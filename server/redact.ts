// Native protocol logs keep the shape of credentials, never their values: they get pasted into issues.

const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "omb_gate_upstream" || lower === "omb_remote_mcp_server" || lower.startsWith("omb_remote_mcp_config_")) return true;
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

import { mask, redactSecretsInText } from "../shared/redact.ts";

export { addHeldSecretScrubber, HELD_SECRET_MASK, mask, redactParams, redactSecretsInText, scrubHeldSecrets } from "../shared/redact.ts";

interface SecretRange { start: number; end: number }
interface SecretScrubber {
  (text: string): string;
  value<T>(value: T): T;
  containsCredential(value: unknown): boolean;
  stream(): { push(text: string, finish?: boolean): string };
}

const SECRET_CONTEXT = /(?:\b(?:[a-z0-9_-]*[_-])?(?:api[ _-]?key|apikey|key|token|secret|password|passwd|credential|authorization)|\bbearer|密钥|令牌|密码)(?:[\s:="'`]|(?:is|was|provided|supplied|value)\b){0,64}$/i;
const CONTEXT_LENGTH = 256;

/** Short credentials are ambiguous prose: mask them in credential contexts or whole values. Diagnostics also mask standalone tokens. */
export function createSecretScrubber(values: readonly string[], short: "context" | "token" = "context"): SecretScrubber {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
  const marker = secrets.some(secret => "[redacted]".includes(secret)) ? "••••••" : "[redacted]";
  const patterns = secrets.map(secret => ({ secret, pattern: new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") }));
  const word = /[\p{L}\p{N}_]/u;
  const ranges = (text: string, wholeValue = true): SecretRange[] => {
    const found: SecretRange[] = [];
    for (const { secret, pattern } of patterns) {
      for (const match of text.matchAll(pattern)) {
        const start = match.index, end = start + secret.length;
        if (secret.length < 8) {
          if (word.test(text[start - 1] ?? "") || word.test(text[end] ?? "")) continue;
          if (short !== "token" && !(wholeValue && text.trim() === secret) && !SECRET_CONTEXT.test(text.slice(Math.max(0, start - CONTEXT_LENGTH), start))) continue;
        }
        found.push({ start, end });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: SecretRange[] = [];
    for (const range of found) {
      const previous = merged.at(-1);
      if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    return merged;
  };
  const render = (text: string, matches: SecretRange[], start = 0, end = text.length): string => {
    let out = "", at = start;
    for (const range of matches) {
      if (range.end <= start || range.start >= end) continue;
      out += text.slice(at, Math.max(at, range.start)) + marker;
      at = range.end;
    }
    return out + text.slice(at, end);
  };
  const scrub = ((text: string) => render(text, ranges(text))) as SecretScrubber;
  scrub.containsCredential = (value: unknown): boolean => {
    const visit = (part: unknown, field = ""): boolean => {
      if (typeof part === "string") {
        if (ranges(part, false).length) return true;
        if (isSecretName(field) && secrets.some(secret => part.trim() === secret || part.trim() === `Bearer ${secret}`)) return true;
        if (/^\s*[[{]/.test(part)) {
          try { return visit(JSON.parse(part)); } catch {}
        }
        return false;
      }
      if (Array.isArray(part)) return part.some(item => visit(item, field));
      return Boolean(part && typeof part === "object" && Object.entries(part).some(([key, item]) => visit(item, key)));
    };
    return visit(value);
  };
  scrub.value = <T>(value: T): T => {
    const visit = (part: unknown, field = ""): unknown => {
      if (typeof part === "string") {
        if (isSecretName(field) && part) return marker;
        if (/^\s*[[{]/.test(part)) {
          try {
            const parsed: unknown = JSON.parse(part), safe = visit(parsed);
            return JSON.stringify(parsed) === JSON.stringify(safe) ? part : JSON.stringify(safe);
          } catch {}
        }
        return redactSecretsInText(scrub(part));
      }
      if (Array.isArray(part)) return part.map(item => visit(item, field));
      if (part && typeof part === "object") return Object.fromEntries(Object.entries(part).map(([key, item]) => [key, visit(item, key)]));
      return part;
    };
    return visit(value) as T;
  };
  scrub.stream = () => {
    let context = "", pending = "";
    let emittedNonWhitespace = false;
    const reserve = CONTEXT_LENGTH + Math.max(8, ...secrets.map(secret => secret.length));
    return {
      push(text: string, finish = false): string {
        pending += text;
        const combined = context + pending;
        const matches = ranges(combined, !emittedNonWhitespace);
        let end = finish ? combined.length : Math.max(context.length, combined.length - reserve);
        for (const match of matches) if (match.start < end && match.end > end) end = Math.max(context.length, match.start);
        const out = render(combined, matches, context.length, end);
        emittedNonWhitespace ||= Boolean(combined.slice(context.length, end).trim());
        pending = combined.slice(end);
        context = combined.slice(Math.max(0, end - CONTEXT_LENGTH), end);
        return redactSecretsInText(out);
      },
    };
  };
  return scrub;
}

export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        // A non-secret name does not clear the value: it still gets the content pass.
        return isSecretName(entry.name)
          ? { ...entry, value: mask(entry.value) }
          : { ...entry, value: redactSecretsInText(entry.value) };
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
