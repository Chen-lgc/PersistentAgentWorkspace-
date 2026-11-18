import type { ServerResponse } from "node:http";
import { ConversationFileError, type ConversationFiles } from "../conversation-files.ts";
import type { ConversationUploads } from "../conversation-uploads.ts";
import type { SharedFileWorkspace } from "../shared-file-workspace.ts";
import type { json as sendJson } from "../harness/http.ts";
import { messageFileDisposition } from "../message-file.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConversationFileError(400, "A file request must be an object.");
  return input as Record<string, unknown>;
}

function failure(error: unknown, res: ServerResponse, json: typeof sendJson): void {
  if (error instanceof ConversationFileError) json(res, error.status, { error: error.message });
  else {
    const status = (error as { status?: number })?.status;
    json(res, status && [400, 401, 403, 413].includes(status) ? status : 500, { error: "Could not access the conversation file workspace. Please retry." });
  }
}

export function createConversationFileRoutes(deps: {
  files: ConversationFiles;
  uploads: ConversationUploads;
  shared?: SharedFileWorkspace;
  visible(auth: RequestAuth, threadId: string): boolean;
  writeRefusal(auth: RequestAuth, threadId: string): string | null;
}): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const match = /^\/api\/threads\/([\w-]+)\/workspace-files$/.exec(path);
    if (!match || !["GET", "POST", "DELETE"].includes(method)) return PASS;
    const threadId = match[1]!;
    if (!deps.visible(auth, threadId)) return json(res, 404, { error: "Conversation not found." });
    res.setHeader("cache-control", "private, no-store");
    if (method !== "GET") {
      const refusal = deps.writeRefusal(auth, threadId);
      if (refusal) return json(res, 403, { error: refusal });
    }
    try {
      if (method === "GET") {
        const shared = deps.shared?.access(threadId);
        const files = shared?.files ?? deps.files, uploads = shared?.uploads ?? deps.uploads;
        const upload = url.searchParams.get("upload");
        if (upload !== null) {
          if (url.searchParams.get("download") !== "1") {
            const file = await uploads.read(threadId, upload);
            if (!deps.visible(auth, threadId)) return json(res, 404, { error: "Conversation not found." });
            return json(res, 200, file);
          }
          const { file, handle } = await uploads.openFile(threadId, upload);
          if (!deps.visible(auth, threadId)) { await handle.close(); return json(res, 404, { error: "Conversation not found." }); }
          res.writeHead(200, {
            "content-type": "application/octet-stream", "content-length": file.bytes,
            "content-disposition": messageFileDisposition(file.name),
            "content-security-policy": "sandbox", "x-content-type-options": "nosniff",
          });
          if (!file.bytes) { await handle.close(); res.end(); return; }
          const stream = handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }
        const name = url.searchParams.get("name");
        if (name === null) return json(res, 200, { files: files.list(threadId), uploads: uploads.list(threadId), ...(shared ? { scope: shared.scope } : {}) });
        const file = files.read(threadId, name);
        if (url.searchParams.get("download") !== "1") return json(res, 200, file);
        res.writeHead(200, {
          "content-type": "application/octet-stream", "content-length": file.bytes,
          "content-disposition": messageFileDisposition(file.name),
          "content-security-policy": "sandbox", "x-content-type-options": "nosniff",
        });
        res.end(file.content);
        return;
      }
      const body = record(await readBody(req, 4 * 1024 * 1024));
      if (!deps.visible(auth, threadId)) return json(res, 404, { error: "Conversation not found." });
      const refusal = deps.writeRefusal(auth, threadId);
      if (refusal) return json(res, 403, { error: refusal });
      const files = deps.shared?.access(threadId)?.files ?? deps.files;
      if (method === "POST") return json(res, 200, files.write(threadId, body));
      files.remove(threadId, body.name, body.revision);
      return json(res, 200, { ok: true });
    } catch (error) { return failure(error, res, json); }
  };
}

export async function conversationFilesInternal(files: ConversationFiles, ctx: {
  method: string; path: string; res: ServerResponse; json: typeof sendJson;
  threadId: string; readBody(): Promise<unknown>;
  saved?(name: string): void;
  uploads?: ConversationUploads;
  shared?: SharedFileWorkspace;
}): Promise<typeof PASS | void> {
  if (ctx.method !== "POST" || ctx.path !== "/api/internal/workspace-files") return PASS;
  try {
    const body = record(await ctx.readBody());
    const shared = ctx.shared?.access(ctx.threadId);
    files = shared?.files ?? files;
    const uploads = shared?.uploads ?? ctx.uploads;
    if (body.action === "list") return ctx.json(ctx.res, 200, { files: files.list(ctx.threadId), uploads: uploads?.list(ctx.threadId) ?? [], ...(shared ? { scope: shared.scope } : {}) });
    if (body.action === "read") return ctx.json(ctx.res, 200, typeof body.name === "string" && body.name.startsWith("upload:") && uploads
      ? await uploads.read(ctx.threadId, body.name.slice(7)) : files.read(ctx.threadId, body.name));
    if (body.action === "write") {
      const { content: _content, ...file } = files.write(ctx.threadId, body);
      ctx.saved?.(file.readName ?? file.name);
      return ctx.json(ctx.res, 200, { ...file, saved: true });
    }
    throw new ConversationFileError(400, "Choose list, read or write.");
  } catch (error) { return failure(error, ctx.res, ctx.json); }
}
