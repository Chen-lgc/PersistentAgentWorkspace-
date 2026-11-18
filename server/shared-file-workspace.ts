import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FileWorkspaceScope, WorkspaceFileSource } from "../shared/conversation-files.ts";
import type { WireMessage } from "../shared/wire.ts";
import type { TurnPdfInput } from "./contracts.ts";
import { sinceFreshStart } from "./fresh-start.ts";
import { ConversationFileError, type ConversationFiles } from "./conversation-files.ts";
import type { ConversationUploads } from "./conversation-uploads.ts";

type FileOwner = { id: string; name: string; section?: string; hidden?: boolean; threadId: string; tasks?: readonly { threadId: string }[] };
type Settings = { enabled?: boolean; department?: string; departmentKey?: string; botIds?: string[] };
type Source = { id: string; label: string };

export interface SharedFileAccess {
  files: ConversationFiles;
  uploads: ConversationUploads;
  scope: FileWorkspaceScope;
}

export function createSharedFileWorkspace(deps: {
  files: ConversationFiles;
  uploads: ConversationUploads;
  settings(): Settings | undefined;
  bots(): readonly FileOwner[];
  sections(): readonly string[];
  sectionIdentity(section: string): string;
  attachmentsDir?: string;
}) {
  const threads = (owner: FileOwner) => [...new Set([owner.threadId, ...(owner.tasks ?? []).map(task => task.threadId)])];
  const reference = (source: string, name: string) => `shared:${source}:${name}`;
  const parse = (name: unknown) => typeof name === "string" ? /^shared:([\w-]+):(.+)$/.exec(name) : null;

  function context(threadId: string) {
    const settings = deps.settings();
    if (!settings?.enabled || settings.department === undefined) return null;
    const identity = settings.departmentKey ?? deps.sectionIdentity(settings.department);
    const department = ["", ...deps.sections()].find(name => deps.sectionIdentity(name) === identity);
    if (department === undefined) return null;
    const members = deps.bots().filter(bot => !bot.hidden && ((bot.section?.trim() || "") === department || settings.botIds?.includes(bot.id)));
    if (!members.some(bot => threads(bot).includes(threadId))) return null;
    const bucket = `shared-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
    const seen = new Set<string>();
    const sources = [{ id: bucket, label: department || "General" }, ...members.flatMap(bot => threads(bot).map(id => ({ id, label: bot.name }))) ]
      .filter(source => !seen.has(source.id) && Boolean(seen.add(source.id)));
    return { sources, scope: { label: department || "General", members: members.map(bot => bot.name) } };
  }

  function access(threadId: string): SharedFileAccess | undefined {
    const current = context(threadId);
    if (!current) return undefined;
    const sources = () => {
      const now = context(threadId);
      if (!now) throw new ConversationFileError(403, "This shared file workspace is no longer accessible.");
      return now.sources;
    };
    const metadata = (source: Source, name: string): WorkspaceFileSource => ({ readName: reference(source.id, name), sourceLabel: source.label });
    const sourceFor = (id: string) => {
      const source = sources().find(source => source.id === id);
      if (!source) throw new ConversationFileError(404, "File not found in this workspace.");
      return source;
    };
    const resolve = (raw: unknown, creating = false) => {
      const ref = parse(raw);
      if (ref) return { source: sourceFor(ref[1]!), name: ref[2]! };
      if (typeof raw !== "string") throw new ConversationFileError(400, "Provide a file name from the workspace list.");
      const available = sources();
      if (creating) return { source: available[0]!, name: raw };
      const matches = available.filter(source => deps.files.list(source.id).some(file => file.name === raw));
      const original = matches.find(source => source.id === threadId);
      if (original) return { source: original, name: raw };
      if (matches.length > 1) throw new ConversationFileError(409, "Several files have this name. List files and use the exact readName.");
      if (!matches.length) throw new ConversationFileError(404, "File not found.");
      return { source: matches[0]!, name: raw };
    };
    const files: ConversationFiles = {
      list: () => sources().flatMap(source => deps.files.list(source.id).map(file => ({ ...file, ...metadata(source, file.name) }))),
      read: (_thread, raw) => {
        const { source, name } = resolve(raw);
        return { ...deps.files.read(source.id, name), ...metadata(source, name) };
      },
      write: (_thread, input) => {
        const { source, name } = resolve(input.name, input.revision === undefined);
        const file = deps.files.write(source.id, { ...input, name });
        return { ...file, ...metadata(source, file.name) };
      },
      remove: (_thread, raw, revision) => {
        const { source, name } = resolve(raw);
        deps.files.remove(source.id, name, revision);
      },
    };
    const listedUploads = () => {
      const seen = new Set<string>();
      return sources().flatMap(source => deps.uploads.list(source.id).map(file => ({ source, file })))
        .filter(({ file }) => !seen.has(file.id) && Boolean(seen.add(file.id)));
    };
    const uploadSource = (id: string) => {
      const found = listedUploads().find(entry => entry.file.id === id);
      if (!found) throw new ConversationFileError(404, "Upload not found in this workspace.");
      return found.source;
    };
    const uploads: ConversationUploads = {
      list: () => listedUploads().map(({ source, file }) => ({ ...file, sourceLabel: source.label })),
      read: async (_thread, id) => {
        const source = uploadSource(id);
        const file = await deps.uploads.read(source.id, id);
        sourceFor(source.id);
        return { ...file, sourceLabel: source.label };
      },
      openFile: async (_thread, id) => {
        const source = uploadSource(id);
        const result = await deps.uploads.openFile(source.id, id);
        try { sourceFor(source.id); } catch (error) { await result.handle.close(); throw error; }
        return { ...result, file: { ...result.file, sourceLabel: source.label } };
      },
    };
    return { files, uploads, scope: current.scope };
  }

  function referencedPdfs(threadId: string, path: readonly WireMessage[], throughMessageId?: string): TurnPdfInput[] {
    if (!deps.attachmentsDir) return [];
    const shared = access(threadId);
    if (!shared) return [];
    const uploads = shared.uploads.list(threadId).filter(file => file.available && /\.pdf$/i.test(file.id));
    const names = new Map<string, number>();
    for (const file of uploads) names.set(file.name, (names.get(file.name) ?? 0) + 1);
    const end = throughMessageId === undefined ? path.length : path.findIndex(message => message.id === throughMessageId) + 1;
    const texts = sinceFreshStart(path.slice(0, end)).filter(message => {
      if (message.kind !== "text") return false;
      if (message.role === "user") return true;
      if (message.roomRequest?.phase !== "request" || !message.from) return false;
      const sender = deps.bots().find(bot => bot.id === message.from!.botId);
      return Boolean(sender && context(sender.threadId));
    }).map(message => message.text ?? "");
    return uploads.filter(file => texts.some(text => text.includes(file.id) || (names.get(file.name) === 1 && text.includes(file.name))))
      .map(file => ({ path: join(deps.attachmentsDir!, file.id), name: file.name, bytes: file.bytes }));
  }

  return { access, referencedPdfs };
}

export type SharedFileWorkspace = ReturnType<typeof createSharedFileWorkspace>;
