import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MlxDownload, MlxModel } from "../../shared/mlx.ts";
import { checkedConnection, CsgHub, modelFile, type HubCredentials } from "./hub.ts";

export function saveJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

export class MlxStorage {
  readonly root: string;
  readonly models: MlxModel[] = [];
  readonly downloads = new Map<string, MlxDownload>();
  private jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(dataDir: string) {
    this.root = join(dataDir, "mlx");
    mkdirSync(join(this.root, "models"), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.root)) {
      if (/^download-[a-f0-9]{24}$/.test(name)) rmSync(join(this.root, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(join(this.root, "models"))) {
      if (!/^[a-f0-9]{24}$/.test(name)) continue;
      try {
        const model: MlxModel = JSON.parse(readFileSync(join(this.root, "models", name, "qbot-manifest.json"), "utf8"));
        if (model.id === name && ["mlx-lm", "ssm-mlx"].includes(model.backend)) this.models.push(model);
      } catch {}
    }
  }
  directory(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid local model ID.");
    return join(this.root, "models", id);
  }
  credentials(): HubCredentials | null {
    const file = join(this.root, "connection.enc");
    if (!existsSync(file)) return null;
    const raw = readFileSync(file);
    const decipher = createDecipheriv("aes-256-gcm", readFileSync(join(this.root, "connection.key")), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return checkedConnection(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")));
  }
  saveCredentials(config: HubCredentials) {
    const keyFile = join(this.root, "connection.key");
    if (!existsSync(keyFile) || readFileSync(keyFile).length !== 32) {
      writeFileSync(`${keyFile}.tmp`, randomBytes(32), { mode: 0o600 });
      renameSync(`${keyFile}.tmp`, keyFile);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", readFileSync(keyFile), iv);
    const content = Buffer.concat([cipher.update(JSON.stringify(config)), cipher.final()]);
    const file = join(this.root, "connection.enc");
    writeFileSync(`${file}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), content]), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  async disconnect() {
    await this.cancelAll();
    await rm(join(this.root, "connection.enc"), { force: true });
    await rm(join(this.root, "connection.key"), { force: true });
  }
  download(hub: CsgHub, repo: string, revision: string): MlxDownload {
    const id = createHash("sha256").update(`${hub.config.endpoint}\n${repo}\n${revision}`).digest("hex").slice(0, 24);
    if (this.jobs.has(id)) return this.downloads.get(id)!;
    if (this.jobs.size >= 2) throw new Error("Two downloads are already running. Wait or cancel one.");
    const job: MlxDownload = { id, repo, state: "downloading", received: 0, total: 0 };
    this.downloads.set(id, job);
    const abort = new AbortController();
    const done = this.runDownload(hub, repo, revision, job, abort.signal).catch((e: unknown) => {
      job.state = abort.signal.aborted ? "cancelled" : "failed";
      job.error = abort.signal.aborted ? undefined : e instanceof Error ? e.message : "Download failed.";
    }).finally(() => { this.jobs.delete(id); });
    this.jobs.set(id, { abort, done });
    return job;
  }
  private async runDownload(hub: CsgHub, repo: string, revision: string, job: MlxDownload, signal: AbortSignal) {
    const manifest = await hub.manifest(repo, revision, signal);
    const files = manifest.siblings.filter((f) => modelFile(f.rfilename));
    if (files.length > 10_000 || new Set(files.map((f) => f.rfilename.toLowerCase())).size !== files.length) throw new Error("Invalid or oversized model file list.");
    if (!files.some((f) => f.rfilename === "config.json") || !files.some((f) => /^model.*\.safetensors$/.test(f.rfilename)) || !files.some((f) => ["tokenizer.json", "tokenizer.model"].includes(f.rfilename))) throw new Error("This repository is not a complete MLX model (config, tokenizer and safetensors are required).");
    const id = createHash("sha256").update(`${hub.config.endpoint}\n${repo}\n${manifest.sha}`).digest("hex").slice(0, 24);
    if (this.models.some((m) => m.id === id)) { job.state = "ready"; return; }
    const staging = join(this.root, `download-${job.id}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    job.total = files.reduce((n, f) => n + (f.lfs?.size ?? f.size ?? 0), 0);
    try {
      for (const file of files) {
        signal.throwIfAborted(); job.file = file.rfilename;
        const response = await hub.file(repo, manifest.sha, file.rfilename, signal);
        const dest = join(staging, file.rfilename);
        if (!response.body) throw new Error(`Empty response for model file: ${file.rfilename}`);
        const reader = response.body.getReader();
        let out: Awaited<ReturnType<typeof open>> | undefined;
        const hash = createHash("sha256"); let bytes = 0;
        try {
          await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
          out = await open(dest, "wx", 0o600);
          while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read(); if (done) break;
            let offset = 0;
            while (offset < value.length) offset += (await out.write(value, offset)).bytesWritten;
            bytes += value.length; job.received += value.length; hash.update(value);
          }
        } finally { await reader.cancel().catch(() => {}); await out?.close(); }
        const expected = file.lfs?.size ?? file.size;
        if (expected !== undefined && bytes !== expected) throw new Error(`Incomplete model file: ${file.rfilename}`);
        if (file.lfs?.sha256 && hash.digest("hex") !== file.lfs.sha256.toLowerCase()) throw new Error(`Model checksum mismatch: ${file.rfilename}`);
      }
      const config = JSON.parse(await readFile(join(staging, "config.json"), "utf8"));
      if (config.model_file && config.model_type !== "kda") throw new Error("This model requires unsupported custom Python code.");
      const model: MlxModel = { id, repo, endpoint: hub.config.endpoint, revision: manifest.sha,
        backend: config.model_type === "kda" ? "ssm-mlx" : "mlx-lm", bytes: job.received, downloadedAt: new Date().toISOString() };
      saveJson(join(staging, "qbot-manifest.json"), model);
      signal.throwIfAborted();
      if (!this.models.some((m) => m.id === id)) { await rename(staging, this.directory(id)); this.models.push(model); }
      job.state = "ready";
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async cancel(id: string) { const job = this.jobs.get(id); job?.abort.abort(); await job?.done; }
  async cancelAll() { await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id))); }
  async remove(id: string) {
    const index = this.models.findIndex((model) => model.id === id);
    if (index < 0) throw new Error("Unknown local model.");
    await rm(this.directory(id), { recursive: true, force: true });
    this.models.splice(index, 1);
  }
}
