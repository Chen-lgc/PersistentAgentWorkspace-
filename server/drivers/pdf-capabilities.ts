import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { httpErrorDetail } from "./openai-chat-refusals.ts";
import { object } from "./openai-chat-protocol.ts";

const MAX_AGE = 24 * 60 * 60 * 1000;
type Fact = { supported: boolean; at: number };

export class PdfCapabilities {
  private readonly file: string;
  private readonly directory: string;
  private readonly learned = new Map<string, Fact>();
  private readonly declared = new Map<string, boolean>();

  constructor(url: string, key: string, dataDir = DATA_DIR) {
    this.directory = join(dataDir, "pdf-capabilities");
    const identity = createHash("sha256").update(JSON.stringify([url.replace(/\/+$/, ""), key])).digest("hex");
    this.file = join(this.directory, `${identity}.json`);
    try {
      const rows: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(rows)) for (const row of rows.slice(-256)) {
        if (!Array.isArray(row) || typeof row[0] !== "string") continue;
        const fact = object(row[1]);
        if (typeof fact?.supported === "boolean" && typeof fact.at === "number" && Date.now() - fact.at < MAX_AGE) {
          this.learned.set(row[0], { supported: fact.supported, at: fact.at });
        }
      }
    } catch {}
  }

  support(model: string): boolean | undefined {
    const fact = this.learned.get(model);
    return fact && Date.now() - fact.at < MAX_AGE ? fact.supported : this.declared.get(model);
  }

  declare(model: string, row: Record<string, unknown>): void {
    const value = row.supports_pdf ?? object(row.capabilities)?.pdf;
    if (typeof value === "boolean") this.declared.set(model, value);
    else {
      const modalities = row.input_modalities ?? object(row.architecture)?.input_modalities;
      if (Array.isArray(modalities) && modalities.some((value) => value === "pdf" || value === "file" || value === "application/pdf")) this.declared.set(model, true);
    }
  }

  record(model: string, supported: boolean): void {
    if (this.learned.get(model)?.supported === supported && this.support(model) === supported) return;
    this.learned.delete(model);
    this.learned.set(model, { supported, at: Date.now() });
    while (this.learned.size > 256) this.learned.delete(this.learned.keys().next().value!);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify([...this.learned]), { mode: 0o600 });
    } catch {}
  }
}

export class UnsupportedPdfInputError extends Error {
  readonly tryResponses: boolean;
  constructor(message: string, tryResponses = false) {
    super(message);
    this.tryResponses = tryResponses;
  }
}

export function pdfNeedsResponses(body: string): boolean {
  return /\bresponses\b/i.test(body) || /\b(?:invalid|unsupported|unknown) (?:value|type|variant)\b/i.test(body);
}

export function rejectsPdfInput(status: number, body: string, pdfMessageIndexes: readonly number[] = []): boolean {
  if (status !== 400 && status !== 422) return false;
  const detail = httpErrorDetail(body, 4000);
  if (/too (?:large|long)|size|limit|corrupt|malformed|invalid (?:pdf|file)|password|encrypt|quota|balance|api.?key|unauthori[sz]ed/i.test(detail)) return false;
  const contentTypes = /\bcontent type of message with index\s*\[(\d+)\]\s+in the messages must be\s+text(?:\s+or\s+(?:image_url|video_url)){0,2}[.!]?(?:\s+\([a-z][a-z0-9_]*\))?\s*$/i.exec(detail);
  if (contentTypes && pdfMessageIndexes.includes(Number(contentTypes[1]))) return true;
  return /\b(?:does not|doesn't|cannot|can't) (?:support|accept|process|read) (?:\w+\s+){0,3}(?:pdfs?|files?|documents?)\b/i.test(detail)
    || /\b(?:pdf|file|document)(?:s| input| inputs| uploads| attachments)?\b.{0,60}\b(?:not supported|unsupported|not allowed|not permitted)\b/i.test(detail)
    || /\bunsupported (?:content |input |message )?(?:type|format|value)\s*:?\s*['"]?(?:file|input_file|pdf)\b/i.test(detail)
    || /\binvalid value\s*:\s*['"](?:file|input_file)['"].{0,120}supported values/i.test(detail)
    || /\bunknown variant\s*['"`](?:file|input_file)['"`].{0,120}expected/i.test(detail)
    || /\b(?:pdf|file)\b.{0,100}\b(?:use|requires?|only available (?:with|through|in))\b.{0,60}\bresponses\b/i.test(detail)
    || /\b(?:unknown|unrecognized|unsupported) (?:parameter|field)\s*:\s*['"]?[^\s]*\b(?:file|file_data|input_file)\b/i.test(detail)
    || /(?:不支持|不能接收|无法接收).{0,15}(?:PDF|pdf|文件输入|文件类型)/.test(detail);
}

export const PDF_HISTORY_ONLY_NOTE = "The conversation has saved PDF references, but this model/API cannot receive them. No PDF contents are attached to this request. Answer using only the conversation text and the current question. Previous summaries are not the original document. If they lack the requested detail, say so; do not claim to have inspected the PDF or its images.";
