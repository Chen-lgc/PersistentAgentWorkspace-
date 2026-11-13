import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { MlxStorage, saveJson } from "./storage.ts";

type Packet = { ready?: boolean; done?: boolean; error?: string; delta?: Record<string, unknown>; finish_reason?: string; usage?: { prompt_tokens: number; completion_tokens: number } };
const resources = join(SERVER_ROOT, "mlx", "python");

function childEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

class Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exited: Promise<void>;
  private pending?: { resolve: () => void; reject: (e: Error) => void; packet: (p: Packet) => void };
  private dead = false;
  constructor(python: string, home: string) {
    this.child = spawn(python, ["-u", join(resources, "worker.py")], { env: childEnvironment(home), cwd: resources, stdio: "pipe" });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.ready = new Promise((resolve, reject) => { this.pending = { resolve, reject, packet: () => {} }; });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 4_000_000) throw new Error("MLX returned an oversized response.");
        const packet: Packet = JSON.parse(line);
        if (packet.error) { this.pending?.reject(new Error(packet.error)); this.pending = undefined; }
        else {
          this.pending?.packet(packet);
          if (packet.ready || packet.done) { this.pending?.resolve(); this.pending = undefined; }
        }
      } catch { this.stop("Invalid response from the MLX worker."); }
    });
    this.child.stderr.resume();
    this.child.once("error", () => this.stop("Cannot start Python. Install the MLX runtime or select its Python executable."));
    this.child.once("exit", () => { lines.close(); this.stop("The MLX worker stopped. Check the Python environment and available memory."); });
    const timer = setTimeout(() => this.stop("MLX runtime startup timed out."), 60_000);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
  }
  async run(command: unknown, packet: (p: Packet) => void, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cancel = () => this.stop("Local generation was cancelled.");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => this.stop("The local model timed out."), 15 * 60_000);
    try {
      await this.ready;
      signal?.throwIfAborted();
      if (this.dead) throw new Error("The MLX worker is no longer running.");
      await new Promise<void>((resolve, reject) => {
        this.pending = { resolve, reject, packet };
        this.child.stdin.write(JSON.stringify(command) + "\n", (error) => { if (error) this.stop("Cannot send a request to the MLX worker."); });
      });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  stop(reason = "The local model was unloaded.") {
    if (this.dead) return;
    this.dead = true;
    this.pending?.reject(new Error(reason)); this.pending = undefined;
    this.child.kill("SIGKILL");
  }
}

export class MlxRuntime {
  readonly storage: MlxStorage;
  readonly supported = process.platform === "darwin" && process.arch === "arm64";
  python = "";
  state: "missing" | "installing" | "ready" | "failed" = "missing";
  error?: string;
  loaded: string | null = null;
  loading: string | null = null;
  private worker?: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private setup?: Promise<void>;
  private installer?: ChildProcessWithoutNullStreams;
  readonly home: string;
  constructor(storage: MlxStorage) {
    this.storage = storage;
    this.home = join(storage.root, "runtime-home");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    try { this.python = JSON.parse(readFileSync(join(storage.root, "runtime.json"), "utf8")).python ?? ""; } catch {}
    if (this.python && this.supported) { this.state = "installing"; this.setup = this.check().catch(() => {}); }
  }
  get busy() { return this.pending > 0 || this.state === "installing"; }
  private async exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pending++;
    const previous = this.tail;
    const result = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("The MLX runtime is shutting down.");
      return fn();
    });
    this.tail = result.then(() => { this.pending--; }, () => { this.pending--; });
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(signal.reason ?? new Error("Local generation was cancelled."));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void result.then((value) => { signal.removeEventListener("abort", cancel); resolve(value); },
        (error: unknown) => { signal.removeEventListener("abort", cancel); reject(error); });
    });
  }
  private command(executable: string, args: string[], timeout: number) {
    if (this.closed) return Promise.reject(new Error("The MLX runtime is shutting down."));
    return new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { env: childEnvironment(this.home), cwd: resources, stdio: "pipe" });
      this.installer = child;
      let errorText = "";
      child.stdout.resume(); child.stderr.on("data", (data: Buffer) => { errorText = (errorText + data.toString()).slice(-1200); });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Cannot start Python. Enter an installed Python executable path.")); });
      child.once("close", (code) => {
        clearTimeout(timer); if (this.installer === child) this.installer = undefined;
        if (code === 0) resolve(); else reject(new Error(errorText || "MLX runtime setup failed or timed out."));
      });
    });
  }
  async check() {
    if (!this.supported) throw new Error("Local MLX requires an Apple Silicon Mac.");
    if (!this.python) throw new Error("Install the MLX runtime first.");
    try { await this.command(this.python, [join(resources, "worker.py"), "--check"], 60_000); this.state = "ready"; this.error = undefined; }
    catch (e) { this.state = "failed"; this.error = e instanceof Error ? e.message : "MLX runtime check failed."; throw e; }
  }
  async configure(python: string) {
    if (this.busy) throw new Error("Wait for the current MLX operation to finish.");
    if (!isAbsolute(python) || !existsSync(python)) throw new Error("Select the absolute path of a Python executable with MLX installed.");
    this.unload(); this.python = python;
    await this.check();
    saveJson(join(this.storage.root, "runtime.json"), { python });
  }
  install(seed = "python3") {
    if (!this.supported) throw new Error("Local MLX requires an Apple Silicon Mac.");
    if (this.busy) throw new Error("Wait for the current MLX operation to finish.");
    this.unload(); this.state = "installing"; this.error = undefined;
    const venv = join(this.storage.root, "venv");
    this.setup = (async () => {
      if (seed !== join(venv, "bin", "python")) await this.command(seed, ["-m", "venv", venv], 120_000);
      this.python = join(venv, "bin", "python");
      await this.command(this.python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", join(resources, "requirements.txt")], 20 * 60_000);
      await this.check();
      saveJson(join(this.storage.root, "runtime.json"), { python: this.python });
    })().catch((e: unknown) => { this.state = "failed"; this.error = e instanceof Error ? e.message : "Installation failed."; });
  }
  private async ensureLoaded(id: string, signal?: AbortSignal) {
    if (this.state !== "ready") throw new Error("Install or configure the MLX runtime first.");
    if (!this.storage.models.some((m) => m.id === id)) throw new Error("Download this model first.");
    if (this.loaded === id && this.worker) return;
    this.loading = id; this.loaded = null;
    const previous = this.worker; previous?.stop(); await previous?.exited;
    if (this.closed) throw new Error("The MLX runtime is shutting down.");
    signal?.throwIfAborted();
    const worker = new Worker(this.python, this.home); this.worker = worker;
    try {
      await worker.run({ op: "load", path: this.storage.directory(id) }, () => {}, signal);
      this.loaded = id;
    } catch (e) { worker.stop(); this.worker = undefined; throw e; }
    finally { this.loading = null; }
  }
  load(id: string) { return this.exclusive(() => this.ensureLoaded(id)); }
  unload() {
    if (this.busy) throw new Error("Wait for local generation to finish before unloading or deleting a model.");
    this.worker?.stop(); this.worker = undefined; this.loaded = null;
  }
  async remove(id: string) {
    if (this.busy) throw new Error("Wait for local generation to finish before deleting a model.");
    if (this.loaded === id) this.unload();
    await this.exclusive(() => this.storage.remove(id));
  }
  async completion(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const model = String(body.model);
    const id = `chatcmpl-${randomUUID()}`;
    const chunk = (packet: Packet) => ({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: packet.delta ?? {}, finish_reason: packet.done ? packet.finish_reason ?? "stop" : null }], ...(packet.usage ? { usage: packet.usage } : {}) });
    const run = (receive: (p: Packet) => void, abort?: AbortSignal) => this.exclusive(async () => {
      await this.ensureLoaded(model, abort);
      try { await this.worker!.run({ op: "generate", body }, receive, abort); }
      catch (e) { this.worker?.stop(); this.worker = undefined; this.loaded = null; throw e; }
    }, abort);
    if (body.stream) {
      const cancel = new AbortController();
      const abort = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          void run((packet) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(packet))}\n\n`)), abort).then(() => {
            controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
          }).catch((e: unknown) => { if (!cancel.signal.aborted) controller.error(e); });
        }, cancel() { cancel.abort(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    let content = "", reasoning = ""; const calls: unknown[] = []; let end: Packet = {};
    await run((p) => {
      if (typeof p.delta?.content === "string") content += p.delta.content;
      if (typeof p.delta?.reasoning_content === "string") reasoning += p.delta.reasoning_content;
      if (Array.isArray(p.delta?.tool_calls)) calls.push(...p.delta.tool_calls);
      if (p.done) end = p;
    }, signal);
    return Response.json({ id, object: "chat.completion", model, choices: [{ index: 0,
      message: { role: "assistant", content, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: end.finish_reason ?? "stop" }], usage: end.usage });
  }
  async close() {
    this.closed = true; this.installer?.kill("SIGKILL"); const worker = this.worker; worker?.stop(); this.worker = undefined; this.loaded = null;
    await Promise.allSettled([this.tail, this.setup, worker?.exited]);
  }
}
