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

/** Scrub known credentials before truncation, regardless of length or vendor format, without re-masking the marker. */
export function createSecretScrubber(values: readonly string[]): (text: string) => string {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!secrets.length) return text => text;
  const pattern = new RegExp(secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const marker = secrets.some(secret => "[redacted]".includes(secret)) ? "••••••" : "[redacted]";
  return text => text.replace(pattern, () => marker);
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
