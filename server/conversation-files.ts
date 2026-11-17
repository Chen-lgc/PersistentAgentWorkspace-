import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONVERSATION_FILE_LIMITS as LIMITS, type ConversationFile, type ConversationFileContent } from "../shared/conversation-files.ts";

export class ConversationFileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fileName(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw !== raw.trim() || raw.startsWith(".") || /[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(raw) || /[. ]$/.test(raw) || Buffer.byteLength(raw) > 180 || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(raw)) {
    throw new ConversationFileError(400, "Use one file name, up to 180 UTF-8 bytes, without folders, hidden names or special characters.");
  }
  return raw.normalize("NFC");
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export function createConversationFiles(dataDir: string) {
  const root = join(dataDir, "conversation-files");
  function directory(threadId: string, create = false): string | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new ConversationFileError(400, "Invalid conversation.");
    for (const dir of [root, join(root, threadId)]) {
      if (create) {
        try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      try {
        if (!lstatSync(dir).isDirectory()) throw new ConversationFileError(403, "The file workspace must be a real directory.");
      } catch (error) { if (missing(error)) return null; throw error; }
    }
    return join(root, threadId);
  }

  function readAt(dir: string, name: string): ConversationFileContent {
    let fd: number;
    try { fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (missing(error)) throw new ConversationFileError(404, "File not found.");
      throw new ConversationFileError(403, "This file cannot be opened safely.");
    }
    try {
      const info = fstatSync(fd);
      // A workspace must never become an arbitrary host-file reader through links.
      if (!info.isFile() || info.nlink !== 1) throw new ConversationFileError(403, "Only regular workspace files are supported.");
      if (info.size > LIMITS.fileBytes) throw new ConversationFileError(413, "Each workspace file is limited to 512 KB.");
      const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const data = buffer.subarray(0, length);
      if (data.length > LIMITS.fileBytes) throw new ConversationFileError(413, "Each workspace file is limited to 512 KB.");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new ConversationFileError(415, "Only UTF-8 text files are supported."); }
      return { name, bytes: data.length, updatedAt: info.mtimeMs, revision: createHash("sha256").update(data).digest("hex"), content };
    } finally { closeSync(fd); }
  }

  function list(threadId: string): ConversationFile[] {
    const dir = directory(threadId);
    if (!dir) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => {
      const { content: _content, ...file } = readAt(dir, fileName(entry.name));
      return file;
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  function read(threadId: string, rawName: unknown): ConversationFileContent {
    const name = fileName(rawName), dir = directory(threadId);
    if (!dir) throw new ConversationFileError(404, "File not found.");
    return readAt(dir, name);
  }

  function write(threadId: string, input: { name?: unknown; content?: unknown; revision?: unknown }): ConversationFileContent {
    const name = fileName(input.name);
    if (typeof input.content !== "string" || input.content.includes("\0")) throw new ConversationFileError(400, "Provide UTF-8 text content.");
    const bytes = Buffer.byteLength(input.content);
    if (bytes > LIMITS.fileBytes) throw new ConversationFileError(413, "Each workspace file is limited to 512 KB.");
    const dir = directory(threadId, true)!;
    const files = list(threadId), previous = files.find((file) => file.name.toLowerCase() === name.toLowerCase());
    if (previous && (previous.name !== name || input.revision !== previous.revision)) throw new ConversationFileError(409, "That name already exists or the file changed. Read the current file before replacing it, or use a new name.");
    if (!previous && input.revision !== undefined) throw new ConversationFileError(409, "The file was removed. Save it under a new name.");
    if (!previous && files.length >= LIMITS.files) throw new ConversationFileError(413, "A conversation can keep up to 100 files.");
    if (files.reduce((total, file) => total + file.bytes, 0) - (previous?.bytes ?? 0) + bytes > LIMITS.totalBytes) throw new ConversationFileError(413, "The conversation file workspace is limited to 20 MB.");
    const target = join(dir, name);
    if (!previous) {
      let fd: number;
      try { fd = openSync(target, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConversationFileError(409, "That name already exists. Choose a new name."); throw error; }
      try { writeFileSync(fd, input.content, "utf8"); } catch (error) { unlinkSync(target); throw error; } finally { closeSync(fd); }
    } else {
      const temp = join(dir, `.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, input.content, { flag: "wx", mode: 0o600 });
        renameSync(temp, target);
      } finally { rmSync(temp, { force: true }); }
    }
    return readAt(dir, name);
  }

  function remove(threadId: string, rawName: unknown, revision: unknown): void {
    const file = read(threadId, rawName);
    if (revision !== file.revision) throw new ConversationFileError(409, "The file changed. Refresh before deleting it.");
    unlinkSync(join(directory(threadId)!, file.name));
  }

  return { list, read, write, remove };
}

export type ConversationFiles = ReturnType<typeof createConversationFiles>;

export const CONVERSATION_FILES_PROMPT = "This conversation has a persistent file workspace, kept across model switches and restarts. When asked to produce code or a Markdown file, use workspace_file to save the actual contents, then tell the user its name. QBot automatically adds links to successfully saved files below your final answer; do not invent file URLs. User-sent attachments also appear in list under uploads, including existing conversation uploads. They are read-only originals; use their readName as the name for read. Only UTF-8 uploads up to 512 KB return content; metadata or contentUnavailable is not document content. Binary documents still require the selected model's attachment capability. Use list/read to inspect saved files when continuing work; do not assume their contents from history. To update a file, first read it and pass its revision. Without this tool, provide a code block or Markdown answer the user can save to the file workspace. Saving does not execute code.";
