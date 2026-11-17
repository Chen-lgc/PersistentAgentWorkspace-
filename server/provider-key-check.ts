// OpenRouter's catalog is public, so /key proves the key there; elsewhere /models proves only catalog access.
import { isIP } from "node:net";
import { rejectsKey } from "./key-rejections.ts";
import { createSecretScrubber } from "./redact.ts";

export type ProviderKeyKind = "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "modelgo" | "meta";

export type ProviderKeyVerdict =
  /** `freeTier`: OpenRouter's /key says the account never bought credit, so paid models refuse it. */
  | { ok: true; check: "authentication" | "models"; models: string[]; freeTier?: boolean }
  | { ok: false; reason: "rejected" | "forbidden" | "unreachable" | "timeout" | "unexpected" | "insecure_transport"; status?: number };

export const PROVIDER_KEY_KINDS: readonly ProviderKeyKind[] = ["anthropic", "openai", "openrouter", "openaiCompat", "xai", "mistral", "cerebras", "groq", "greenference", "modelgo", "meta"];

const DEFAULT_URLS: Record<ProviderKeyKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openaiCompat: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  greenference: "https://llm.eu.greenference.com/v1",
  modelgo: "https://api.modelgo.ai/v1",
  meta: "https://api.meta.ai/v1",
};

const MAX_MODELS = 5;

export function apiKeyFormatError(key: string): string | null {
  return /[^\x21-\x7e]/.test(key)
    ? "API Key 格式有误：不能包含空格、换行、中文或 ✓ 等非 ASCII 字符。请从服务商控制台重新复制密钥本身，不要包含页面或终端提示文字。"
    : null;
}

/** A URL hostname on this machine. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

/** Credentials may travel only over HTTPS or HTTP to this machine; redirects must also be disabled by callers. */
export function providerTransportError(address: string): string | null {
  try {
    const url = new URL(address);
    if (!url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))) return null;
  } catch {}
  return "API keys require HTTPS for remote servers. HTTP is allowed only on localhost/loopback. Use HTTPS or a secure tunnel to localhost.";
}

export function providerBaseUrl(provider: ProviderKeyKind, base?: string | null): string {
  return (base?.trim() || DEFAULT_URLS[provider]).replace(/\/+$/, "");
}

export function providerModelsUrl(provider: ProviderKeyKind, base?: string | null): string {
  const root = providerBaseUrl(provider, base);
  if (provider === "anthropic") return root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
  return `${root}/models`;
}

function modelIds(body: unknown): string[] {
  const record = body && typeof body === "object" ? (body as { data?: unknown; models?: unknown }) : null;
  const list = Array.isArray(body) ? body : Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
  const ids: string[] = [];
  for (const entry of list) {
    const item = entry && typeof entry === "object" ? (entry as { id?: unknown; name?: unknown }) : null;
    const id = typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : null;
    if (id && id.length <= 120) ids.push(id);
    if (ids.length === MAX_MODELS) break;
  }
  return ids;
}

export async function checkProviderKey(
  input: { provider: ProviderKeyKind; key: string; url?: string | null },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<ProviderKeyVerdict> {
  if (!input.key.trim() || apiKeyFormatError(input.key)) return { ok: false, reason: "rejected" };
  let url: URL;
  try {
    url = new URL(providerModelsUrl(input.provider, input.url));
  } catch {
    return { ok: false, reason: "unexpected" };
  }
  if (providerTransportError(url.href)) {
    return { ok: false, reason: "insecure_transport" };
  }
  const authenticate = (input.provider === "openaiCompat" || input.provider === "openrouter")
    && url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/models";
  if (authenticate) url.pathname = "/api/v1/key";
  const headers: Record<string, string> =
    input.provider === "anthropic"
      ? { "x-api-key": input.key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${input.key}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow a redirect: the key must not be replayed to whichever host the front door points at.
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "manual" });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      if (controller.signal.aborted) return { ok: false, reason: "timeout" };
      return { ok: false, reason: rejectsKey(response.status, detail) ? "rejected" : response.status === 403 ? "forbidden" : "unexpected", status: response.status };
    }
    const body: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) return { ok: false, reason: "timeout" };
    if (!body || typeof body !== "object") return { ok: false, reason: "unexpected", status: response.status };
    if (authenticate) {
      const data = (body as { data?: unknown }).data;
      const freeTier = data && typeof data === "object" && !Array.isArray(data) ? (data as { is_free_tier?: unknown }).is_free_tier : undefined;
      if (typeof freeTier !== "boolean") return { ok: false, reason: "unexpected", status: response.status };
      return { ok: true, check: "authentication", models: [], freeTier };
    }
    if (!Array.isArray(body) && !Array.isArray((body as { data?: unknown }).data) && !Array.isArray((body as { models?: unknown }).models)) {
      return { ok: false, reason: "unexpected", status: response.status };
    }
    const scrub = createSecretScrubber([input.key]);
    return { ok: true, check: "models", models: modelIds(body).map(scrub) };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
