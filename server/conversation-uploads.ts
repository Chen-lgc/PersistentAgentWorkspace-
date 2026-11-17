import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CONVERSATION_FILE_LIMITS, type ConversationUpload, type ConversationUploadContent } from "../shared/conversation-files.ts";
import { FILE_MAX_BYTES } from "../shared/upload-limits.ts";
import type { WireMessage } from "../shared/wire.ts";
import { ConversationFileError } from "./conversation-files.ts";
import { messageAttachments, mimeFor } from "./message-file.ts";

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/i;

export function createConversationUploads(dataDir: string, messages: (threadId: string) => readonly WireMessage[]) {
  const root = resolve(dataDir, "attachments");

  function list(threadId: string): ConversationUpload[] {
    const uploads = new Map<string, ConversationUpload>();
    for (const message of messages(threadId)) {
      if (message.role !== "user" || message.kind !== "text" || !message.text?.includes("<attached-")) continue;
      for (const attachment of messageAttachments(message.text)) {
        const id = basename(attachment.path);
        if (!UPLOAD_ID.test(id) || dirname(attachment.path) !== root || resolve(attachment.path) !== join(root, id) || uploads.has(id)) continue;
        let bytes = 0, available = false;
        try {
          const info = lstatSync(join(root, id));
          available = lstatSync(root).isDirectory() && info.isFile() && info.nlink === 1 && info.size <= FILE_MAX_BYTES;
          if (available) bytes = info.size;
        } catch {}
        uploads.set(id, { source: "upload", id, name: attachment.name, bytes, updatedAt: message.at, mime: mimeFor(id), available, readName: `upload:${id}` });
      }
    }
    return [...uploads.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  async function openFile(threadId: string, id: string) {
    const file = list(threadId).find((item) => item.id === id);
    if (!file?.available) throw new ConversationFileError(404, "The uploaded original no longer exists or is not accessible.");
    // Only the generated name belonging to this conversation may be opened; links must never expose host files.
    const handle = await open(join(root, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(() => { throw new ConversationFileError(404, "The uploaded original no longer exists or is not accessible."); });
    try {
      const info = await handle.stat();
      const current = lstatSync(join(root, id));
      if (!lstatSync(root).isDirectory() || !info.isFile() || info.nlink !== 1 || info.ino !== current.ino || info.dev !== current.dev) throw new ConversationFileError(403, "This upload cannot be opened safely.");
      if (info.size > FILE_MAX_BYTES) throw new ConversationFileError(413, "The upload exceeds the attachment size limit.");
      return { file: { ...file, bytes: info.size }, handle };
    } catch (error) { await handle.close(); throw error; }
  }

  async function read(threadId: string, id: string): Promise<ConversationUploadContent> {
    const { file, handle } = await openFile(threadId, id);
    try {
      const unavailable = { ...file, contentUnavailable: "The original is saved and downloadable. Only UTF-8 text up to 512 KB can be read here; binary documents require the model's attachment capability." };
      if (file.bytes > CONVERSATION_FILE_LIMITS.fileBytes || /^(image|audio|video)\//.test(file.mime) || /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip)$/i.test(id)) return unavailable;
      const buffer = Buffer.alloc(CONVERSATION_FILE_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > CONVERSATION_FILE_LIMITS.fileBytes) return unavailable;
      try {
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
        return content.includes("\0") ? unavailable : { ...file, content };
      } catch { return unavailable; }
    } finally { await handle.close(); }
  }

  return { list, openFile, read };
}

export type ConversationUploads = ReturnType<typeof createConversationUploads>;
