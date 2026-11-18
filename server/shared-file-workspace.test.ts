import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WireMessage } from "../shared/wire.ts";
import { createConversationFiles } from "./conversation-files.ts";
import { createConversationUploads } from "./conversation-uploads.ts";
import { createSharedFileWorkspace } from "./shared-file-workspace.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "qbot-shared-files-")); homes.push(home);
  const bots = [
    { id: "chief", name: "QBot", threadId: "chief-chat", section: "", tasks: [{ threadId: "chief-old" }] },
    { id: "summary", name: "Summary", threadId: "summary-chat", section: "Research", tasks: [] },
    { id: "experiment", name: "Experiment", threadId: "experiment-chat", section: "Research", tasks: [] },
    { id: "other", name: "Other", threadId: "other-chat", section: "Other", tasks: [] },
  ];
  const settings = { enabled: true, department: "Research", departmentKey: "stable-research", botIds: ["chief"] };
  const identities: Record<string, string> = { Research: "stable-research", Other: "stable-other" };
  const messages = new Map<string, WireMessage[]>();
  const files = createConversationFiles(home);
  const uploads = createConversationUploads(home, thread => messages.get(thread) ?? []);
  const shared = createSharedFileWorkspace({ files, uploads, settings: () => settings, bots: () => bots,
    sections: () => Object.keys(identities), sectionIdentity: name => identities[name] ?? name, attachmentsDir: join(home, "attachments") });
  const upload = (thread: string, name: string, content: string) => {
    const id = `${randomUUID()}.${name.split(".").at(-1)}`;
    mkdirSync(join(home, "attachments"), { recursive: true });
    const path = join(home, "attachments", id); writeFileSync(path, content);
    messages.set(thread, [...messages.get(thread) ?? [], { id: randomUUID(), role: "user", kind: "text", at: Date.now(), text: `<attached-file path="${path}" name="${name}" />` }]);
    return id;
  };
  return { home, bots, settings, identities, files, uploads, shared, upload };
}

it("shares original uploads and old files, preserves duplicate names, and excludes other departments", async () => {
  const f = fixture();
  f.files.write("chief-old", { name: "report.md", content: "first" });
  f.files.write("summary-chat", { name: "report.md", content: "second" });
  f.files.write("other-chat", { name: "secret.md", content: "outside" });
  const id = f.upload("chief-old", "notes.txt", "uploaded source");
  const pdf = f.upload("summary-chat", "paper.pdf", "%PDF-1.4\nfixture");
  const foreign = f.upload("other-chat", "other.txt", "outside");
  const access = f.shared.access("experiment-chat")!;
  expect(access.scope.members).toEqual(["QBot", "Summary", "Experiment"]);
  const listed = access.files.list("experiment-chat");
  expect(listed.map(file => file.name)).toEqual(["report.md", "report.md"]);
  expect(new Set(listed.map(file => file.readName)).size).toBe(2);
  expect(() => access.files.read("experiment-chat", "report.md")).toThrow(/Several files/);
  expect(access.files.read("experiment-chat", listed[0]!.readName).content).toBe("first");
  expect(await access.uploads.read("experiment-chat", id)).toMatchObject({ content: "uploaded source", sourceLabel: "QBot" });
  expect(await access.uploads.read("experiment-chat", pdf)).toMatchObject({ contentUnavailable: expect.any(String) });
  const original = await access.uploads.openFile("experiment-chat", pdf);
  try { expect((await original.handle.readFile()).toString()).toBe("%PDF-1.4\nfixture"); } finally { await original.handle.close(); }
  await expect(access.uploads.read("experiment-chat", foreign)).rejects.toMatchObject({ status: 404 });
  expect(() => access.files.read("experiment-chat", "shared:other-chat:secret.md")).toThrow(/not found/);
  expect(f.shared.access("other-chat")).toBeUndefined();
});

it("writes a shared file, guards stale revisions, and retains it after its author's chat is removed", () => {
  const f = fixture();
  const first = f.shared.access("chief-chat")!.files.write("chief-chat", { name: "analysis.md", content: "v1" });
  const reader = f.shared.access("summary-chat")!.files;
  expect(reader.read("summary-chat", first.readName).content).toBe("v1");
  const second = reader.write("summary-chat", { name: first.readName, content: "v2", revision: first.revision });
  expect(() => reader.write("summary-chat", { name: first.readName, content: "stale", revision: first.revision })).toThrow(/changed/);
  expect(() => reader.remove("summary-chat", first.readName, first.revision)).toThrow(/changed/);
  f.bots.splice(0, 1);
  expect(reader.read("summary-chat", second.readName).content).toBe("v2");
  reader.remove("summary-chat", second.readName, second.revision);
  expect(reader.list("summary-chat")).toEqual([]);
});

it("tracks department membership and stable identity without sharing chat history", () => {
  const f = fixture();
  const saved = f.shared.access("summary-chat")!.files.write("summary-chat", { name: "method.md", content: "method" });
  f.identities.Renamed = f.identities.Research!; delete f.identities.Research;
  for (const bot of f.bots) if (bot.section === "Research") bot.section = "Renamed";
  const access = f.shared.access("experiment-chat")!;
  expect(access.scope.label).toBe("Renamed");
  expect(access.files.read("experiment-chat", saved.readName).content).toBe("method");
  f.bots.push({ id: "new", name: "New", section: "Renamed", threadId: "new-chat", tasks: [] });
  expect(f.shared.access("new-chat")!.files.list("new-chat")).toHaveLength(1);
  f.bots.find(bot => bot.id === "experiment")!.section = "Other";
  expect(f.shared.access("experiment-chat")).toBeUndefined();
  expect(() => access.files.read("experiment-chat", saved.readName)).toThrow(/no longer accessible/);
  f.settings.enabled = false;
  expect(f.shared.access("chief-chat")).toBeUndefined();
});

it("rejects traversal and symlink files through a shared reference", () => {
  const f = fixture();
  const access = f.shared.access("summary-chat")!;
  expect(() => access.files.write("summary-chat", { name: "../outside", content: "bad" })).toThrow();
  f.files.write("chief-chat", { name: "safe.md", content: "safe" });
  const linked = join(f.home, "conversation-files", "chief-chat", "link.md");
  symlinkSync(join(f.home, "conversation-files", "chief-chat", "safe.md"), linked);
  expect(() => access.files.read("summary-chat", "shared:chief-chat:link.md")).toThrow();
  expect(() => access.files.read("summary-chat", "shared:chief-chat:../outside")).toThrow();
});


it("selects only explicitly referenced shared PDFs and respects fresh starts and membership changes", () => {
  const f = fixture();
  const first = f.upload("chief-chat", "paper.pdf", "%PDF-1.4 first");
  const duplicate = f.upload("summary-chat", "paper.pdf", "%PDF-1.4 second");
  const unique = f.upload("summary-chat", "unique.pdf", "%PDF-1.4 unique");
  const foreign = f.upload("other-chat", "private.pdf", "%PDF-1.4 private");
  const line = (id: string, text: string): WireMessage => ({ id, at: 1, kind: "text", role: "user", text });
  expect(f.shared.referencedPdfs("experiment-chat", [line("m1", "paper.pdf")])).toEqual([]);
  const path = [line("m1", `Analyze upload:${first} and unique.pdf; ignore upload:${foreign}`), line("m2", `upload:${duplicate}`)];
  const selected = f.shared.referencedPdfs("experiment-chat", path, "m1");
  expect(selected.map(pdf => pdf.path).sort()).toEqual([first, unique].map(id => join(f.home, "attachments", id)).sort());
  const fresh: WireMessage = { id: "fresh", at: 2, kind: "compaction", role: "bot", compaction: { summary: "", firstKeptId: "", foldedThroughId: "m2", tokensBefore: 0, by: "person", fresh: true } };
  expect(f.shared.referencedPdfs("experiment-chat", [...path, fresh, line("m3", "hello")])).toEqual([]);
  f.bots.find(bot => bot.id === "experiment")!.section = "Other";
  expect(f.shared.referencedPdfs("experiment-chat", path)).toEqual([]);
});

it("selects PDF references in authenticated member assignments, not bot prose or returned results", () => {
  const f = fixture();
  const id = f.upload("chief-chat", "paper.pdf", "%PDF-1.4 delegated");
  const request: WireMessage = { id: "request", at: 2, role: "bot", kind: "text", text: `Read upload:${id}`,
    from: { botId: "chief", name: "QBot", color: "blue" }, roomRequest: { id: "assignment", phase: "request" } };
  const path: WireMessage[] = [{ id: "earlier-user", at: 1, role: "user", kind: "text", text: "Earlier question" }, request];
  expect(f.shared.referencedPdfs("summary-chat", path, request.id)).toHaveLength(1);
  expect(f.shared.referencedPdfs("summary-chat", path, "earlier-user")).toEqual([]);
  expect(f.shared.referencedPdfs("summary-chat", [request, { id: "followup", at: 3, role: "user", kind: "text", text: "Explain further" }])).toHaveLength(1);
  for (const changed of [
    { roomRequest: undefined }, { from: undefined },
    { roomRequest: { id: "assignment", phase: "result" as const } },
    { from: { botId: "other", name: "Other", color: "blue" } },
  ]) expect(f.shared.referencedPdfs("summary-chat", [{ ...request, ...changed }])).toEqual([]);
  const fresh: WireMessage = { id: "fresh", at: 4, kind: "compaction", role: "bot", compaction: { summary: "", firstKeptId: "", foldedThroughId: request.id, tokensBefore: 0, by: "person", fresh: true } };
  expect(f.shared.referencedPdfs("summary-chat", [...path, fresh])).toEqual([]);
  f.settings.botIds = [];
  expect(f.shared.referencedPdfs("summary-chat", path)).toEqual([]);
});
