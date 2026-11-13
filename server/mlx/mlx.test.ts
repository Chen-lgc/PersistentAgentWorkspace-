import { mkdtempSync, readFileSync, rmSync, chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { MlxService } from "./service.ts";
import { checkedConnection, modelFile } from "./hub.ts";
import { startFakeCsgHub } from "../testing/fake-csghub.ts";
import { createMlxDriver } from "../drivers/mlx.ts";
import { recordEvents } from "../testing/events.ts";
import { createMlxRoutes } from "../routes/mlx.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks(); });
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "qbot-mlx-test-"));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  const service = new MlxService(folder); cleanup.push(() => service.close());
  const hub = await startFakeCsgHub(); cleanup.push(hub.close);
  const connect = (token = "fixture-secret") => service.connect({ endpoint: hub.endpoint, token });
  return { folder, service, hub, connect };
}
async function downloaded(f: Awaited<ReturnType<typeof fixture>>) {
  await f.connect();
  const job = f.service.storage.download(f.service.requireHub(), "team/fixture-mlx", "main");
  await vi.waitFor(() => expect(job.state).toBe("ready"));
  return f.service.storage.models[0]!;
}

it("authenticates, browses private models, pins a snapshot and keeps credentials sealed across restart", async () => {
  const f = await fixture();
  await expect(f.connect("wrong-token")).rejects.toThrow("refused");
  expect(f.service.status().authenticated).toBe(false);
  f.hub.files.set(".gitattributes", Buffer.from("*.safetensors filter=lfs"));
  f.hub.files.set("kda.py", Buffer.from("raise RuntimeError('must not execute downloaded code')"));
  const model = await downloaded(f);
  const listed = await f.service.requireHub().list("mlx", 1, true);
  expect(listed.models[0]).toMatchObject({ id: "team/fixture-mlx", private: true, tags: ["mlx"] });
  expect(model.revision).toBe(f.hub.sha);
  expect(f.hub.requests.filter((r) => r.path.includes("/resolve/")).every((r) => r.path.includes(f.hub.sha) && r.authorized)).toBe(true);
  expect(readFileSync(join(f.service.storage.root, "connection.enc")).includes(Buffer.from("fixture-secret"))).toBe(false);
  expect(JSON.stringify(f.service.status())).not.toContain("fixture-secret");
  expect(excludedWorkspaceAuthPath("mlx/connection.key")).toBe(true);
  const restarted = new MlxService(f.folder); cleanup.push(() => restarted.close());
  expect(restarted.status().authenticated).toBe(true);
  expect(restarted.storage.models).toEqual([model]);
  await restarted.disconnect();
  expect(restarted.status().authenticated).toBe(false);
  expect(restarted.storage.models).toHaveLength(1);
});

it.each(["corrupt", "unsafe"] as const)("does not publish a %s download", async (kind) => {
  const f = await fixture(); await f.connect(); f.hub.state[kind] = true;
  const job = f.service.storage.download(f.service.requireHub(), "team/fixture-mlx", "main");
  await vi.waitFor(() => expect(job.state).toBe("failed"));
  expect(f.service.storage.models).toHaveLength(0);
  expect(job.error).toMatch(kind === "corrupt" ? /checksum/ : /unsafe/);
});

it("cancels a partial download and retries cleanly", async () => {
  const f = await fixture(); await f.connect(); f.hub.state.slow = true;
  const job = f.service.storage.download(f.service.requireHub(), "team/fixture-mlx", "main");
  await vi.waitFor(() => expect(job.received).toBeGreaterThan(0));
  await f.service.storage.cancel(job.id);
  expect(job.state).toBe("cancelled"); expect(f.service.storage.models).toHaveLength(0);
  f.hub.state.slow = false;
  const retry = f.service.storage.download(f.service.requireHub(), "team/fixture-mlx", "main");
  await vi.waitFor(() => expect(retry.state).toBe("ready"));
});

it("never forwards an access token to redirected object storage", async () => {
  const f = await fixture(); await f.connect();
  let authorization: string | undefined;
  const other = createServer((req, res) => { authorization = req.headers.authorization; res.end("blob"); });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
  f.hub.state.redirect = `http://127.0.0.1:${(other.address() as AddressInfo).port}/object?signature=fixture`;
  const response = await f.service.requireHub().file("team/fixture-mlx", f.hub.sha, "config.json", new AbortController().signal);
  expect(await response.text()).toBe("blob"); expect(authorization).toBeUndefined();
});

it("rejects unsafe paths and requires explicit consent for remote HTTP", () => {
  for (const name of ["../x.json", "/x.json", "x/../../a", "x\\a", "x//a"]) expect(() => modelFile(name)).toThrow();
  expect(modelFile("kda.py")).toBe(false);
  expect(modelFile(".gitattributes")).toBe(false);
  expect(() => checkedConnection({ endpoint: "http://lan.example", token: "x" })).toThrow("HTTPS");
  expect(checkedConnection({ endpoint: "http://lan.example", token: "x", allowHttp: true }).allowHttp).toBe(true);
  expect(() => checkedConnection({ endpoint: "https://x:password@host", token: "x" })).toThrow();
});

it("recovers from unreadable saved credentials without crashing app startup", async () => {
  const f = await fixture(); await f.connect();
  writeFileSync(join(f.service.storage.root, "connection.enc"), "broken");
  writeFileSync(join(f.service.storage.root, "connection.key"), "broken");
  const restarted = new MlxService(f.folder); cleanup.push(() => restarted.close());
  expect(restarted.status()).toMatchObject({ authenticated: false, connectionError: expect.any(String) });
  await restarted.connect({ endpoint: f.hub.endpoint, token: "fixture-secret" });
  expect(restarted.status().authenticated).toBe(true);
});

it.each([
  { kind: "loopback", trust: "service", scopes: [] },
  { kind: "loopback", trust: "owner", scopes: ["admin"], hosted: true },
])("refuses model/credential access from restricted servers: %j", async (policy) => {
  const f = await fixture();
  const route = createMlxRoutes({ mlx: f.service, hosted: policy.hosted ?? false, changed: () => {} });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    await route({ req, res, url, path: url.pathname, method: req.method!, auth: policy as RequestAuth, json, readBody });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const path of ["/api/mlx", "/api/mlx/models", "/api/mlx/connect", "/api/mlx/runtime/install"]) expect((await fetch(url + path)).status).toBe(403);
});

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("runs the actual driver/worker protocol, cancellation and crash recovery without network inference", async () => {
  const f = await fixture(); const model = await downloaded(f);
  const python = join(f.folder, "fixture-python");
  copyFileSync(resolve("server/testing/fake-mlx-python.mjs"), python); chmodSync(python, 0o700);
  await f.service.runtime.configure(python);
  const network = vi.spyOn(globalThis, "fetch");
  const driver = createMlxDriver(f.service);
  const instance = await driver.create({ instanceId: "mlxLocal", displayName: "MLX", environment: {}, config: {}, enabled: true });
  cleanup.push(() => instance.dispose());
  expect(await instance.snapshot()).toMatchObject({ state: "available" });
  expect(await instance.generateText!("hello", { model: model.id })).toContain("Local fixture: hello");
  const recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "mlx-chat", text: "hello chat", model: model.id });
  expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  recorder.stop();
  const abort = new AbortController();
  const pending = instance.generateText!("wait forever", { signal: abort.signal });
  await vi.waitFor(() => expect(f.service.runtime.busy).toBe(true));
  expect(() => f.service.runtime.unload()).toThrow("finish");
  abort.abort(); await expect(pending).rejects.toThrow();
  expect(await instance.generateText!("after cancellation")).toContain("after cancellation");
  await expect(instance.generateText!("crash worker")).rejects.toThrow();
  expect(await instance.generateText!("after crash")).toContain("after crash");
  const second = { ...model, id: "b".repeat(24) };
  f.service.storage.models.push(second);
  const parallel = await Promise.all([model, second, model].map((m) => instance.generateText!("parallel", { model: m.id })));
  expect(parallel).toEqual([model, second, model].map((m) => `Local fixture: parallel (${m.id})`));
  const runningAbort = new AbortController();
  const running = instance.generateText!("wait forever", { signal: runningAbort.signal });
  const queuedAbort = new AbortController();
  const queued = instance.generateText!("queued", { signal: queuedAbort.signal });
  queuedAbort.abort();
  await expect(queued).rejects.toThrow();
  expect(f.service.runtime.busy).toBe(true);
  runningAbort.abort(); await expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(f.service.runtime.busy).toBe(false));
  expect(network).not.toHaveBeenCalled();
  await f.service.runtime.remove(second.id);
  await f.service.runtime.remove(model.id);
  expect(f.service.runtime.loaded).toBeNull(); expect(instance.models.options).toHaveLength(0);
});
