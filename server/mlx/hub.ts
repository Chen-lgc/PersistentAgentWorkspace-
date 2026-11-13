import { z } from "zod";
import type { HubConnection, HubModel } from "../../shared/mlx.ts";

export const connectionSchema = z.object({
  endpoint: z.string().trim().url(), username: z.string().trim().max(100).default(""),
  allowHttp: z.boolean().default(false), token: z.string().trim().min(1).max(4096),
});
export type HubCredentials = z.infer<typeof connectionSchema>;
export const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/).refine((s) => !s.split("/").some((p) => p === "." || p === ".."));
export const revisionSchema = z.string().min(1).max(200).regex(/^[\w./-]+$/);
const metadataSchema = z.object({ sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/), siblings: z.array(z.object({
  rfilename: z.string(), size: z.number().nonnegative().optional(),
  lfs: z.object({ size: z.number().nonnegative(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).nullable().optional(),
})) });

export function checkedConnection(raw: unknown): HubCredentials {
  const config = connectionSchema.parse(raw);
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Enter a platform API base URL without credentials, query or fragment.");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !config.allowHttp) throw new Error("Use HTTPS, or explicitly allow HTTP for your trusted private network.");
  config.endpoint = url.href.replace(/\/+$/, "");
  return config;
}

export function modelFile(name: string): boolean {
  if (!name || name.length > 500 || name.includes("\\") || name.includes(":") || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || name.split("/").some((s) => !s || s === "." || s === "..")) throw new Error("The repository contains an unsafe file path.");
  if (name.split("/").some((s) => s.startsWith(".")) || name === "qbot-manifest.json") return false;
  return /\.(safetensors|json|model|tiktoken|txt|jinja)$/i.test(name);
}

export class CsgHub {
  readonly config: HubCredentials;
  constructor(config: HubCredentials) { this.config = checkedConnection(config); }
  publicConnection(): HubConnection {
    const { endpoint, username, allowHttp } = this.config;
    return { endpoint, username, allowHttp };
  }
  async request(path: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<Response> {
    let url = new URL(`${this.config.endpoint}${path}`);
    const origin = url.origin;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, {
        headers: url.origin === origin ? { authorization: `Bearer ${this.config.token}` } : {},
        signal: combined, redirect: "manual",
      }).catch(() => { throw new Error(combined.aborted ? "CSGHub request cancelled or timed out." : "Cannot reach CSGHub. Check its API address and TLS certificate."); });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("CSGHub returned an invalid redirect.");
        const next = new URL(location, url);
        if (next.username || next.password || !["http:", "https:"].includes(next.protocol) || (url.protocol === "https:" && next.protocol !== "https:")) throw new Error("CSGHub returned an unsafe redirect.");
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 401 || response.status === 403 ? "CSGHub refused this access token or repository permission." : `CSGHub request failed (HTTP ${response.status}).`);
      }
      return response;
    }
    throw new Error("Too many CSGHub redirects.");
  }
  async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, signal);
    if (Number(response.headers.get("content-length")) > 16_000_000) { await response.body?.cancel(); throw new Error("CSGHub metadata is too large."); }
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > 16_000_000) throw new Error("CSGHub metadata is too large.");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
  }
  async authenticate(): Promise<void> {
    const who = z.object({ name: z.string().min(1) }).parse(await this.json("/csg/api/whoami-v2"));
    this.config.username = who.name;
  }
  async list(search: string, page: number, mine: boolean): Promise<{ models: HubModel[]; hasMore: boolean }> {
    const params = new URLSearchParams({ search, page: String(page), per: "20", sort: "recently_update" });
    const path = mine ? `/api/v1/user/${encodeURIComponent(this.config.username)}/models` : "/api/v1/models";
    const payload = z.object({ data: z.array(z.object({ path: repoSchema, private: z.boolean().optional(),
      description: z.string().nullable().optional(), tags: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
    })), total: z.number().optional() }).parse(await this.json(`${path}?${params}`));
    return { models: payload.data.map((m) => ({ id: m.path, private: m.private ?? false, description: m.description ?? "", tags: (m.tags ?? []).map((tag) => typeof tag === "string" ? tag : tag.name) })), hasMore: payload.total === undefined ? payload.data.length === 20 : page * 20 < payload.total };
  }
  async manifest(repo: string, revision: string, signal: AbortSignal) {
    repoSchema.parse(repo); revisionSchema.parse(revision);
    return metadataSchema.parse(await this.json(`/csg/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`, signal));
  }
  file(repo: string, revision: string, path: string, signal: AbortSignal) {
    return this.request(`/csg/${repo}/resolve/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`, signal, 24 * 60 * 60_000);
  }
}
