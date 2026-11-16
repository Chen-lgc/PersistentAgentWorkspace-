import { basename, resolve } from "node:path";
import type { WireMessage } from "../shared/wire.ts";
import type { TurnPdfInput } from "./contracts.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { sinceFreshStart } from "./fresh-start.ts";
import { extractTurnPdfs, OWNED_PDF_NAME } from "./turn-images.ts";

export function messagePdfReferences(message: Pick<WireMessage, "role" | "kind" | "text">, attachmentsDir = ATTACHMENTS_DIR): NonNullable<WireMessage["pdfReferences"]> {
  if (message.role !== "user" || message.kind !== "text") return [];
  return extractTurnPdfs(message.text ?? "", attachmentsDir, false)
    .map(({ path, name, bytes }) => ({ id: basename(path), name, bytes }));
}

export function conversationPdfs(
  path: readonly WireMessage[], throughMessageId?: string, attachmentsDir = ATTACHMENTS_DIR,
  migrate?: (message: WireMessage, refs: NonNullable<WireMessage["pdfReferences"]>) => void,
): TurnPdfInput[] {
  const end = throughMessageId === undefined ? path.length : path.findIndex((message) => message.id === throughMessageId) + 1;
  const pdfs = new Map<string, TurnPdfInput>();
  for (const message of sinceFreshStart(path.slice(0, end))) {
    if (message.role !== "user" || message.kind !== "text") continue;
    const refs = message.pdfReferences ?? messagePdfReferences(message, attachmentsDir);
    if (message.pdfReferences === undefined) migrate?.(message, refs);
    for (const ref of refs) {
      if (!OWNED_PDF_NAME.test(ref.id) || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || typeof ref.name !== "string") continue;
      pdfs.set(ref.id, { path: resolve(attachmentsDir, ref.id), name: ref.name, bytes: ref.bytes });
    }
  }
  return [...pdfs.values()];
}
