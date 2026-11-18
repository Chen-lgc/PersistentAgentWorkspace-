import { createPortal } from "react-dom";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, FilePlus2, FileText, FolderOpen, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { ConversationFilesContext, type WorkspaceDraft } from "@/lib/conversation-files";
import { api, ApiError } from "@/state/api";
import { t } from "@/lib/i18n";
import { downloadSnippetFile } from "@/lib/code-block";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { ConversationFile, ConversationFileContent, ConversationUpload, ConversationUploadContent, FileWorkspaceScope } from "../../shared/conversation-files";
import { ChatMarkdown } from "./ChatMarkdown";
import { CodeBlock } from "./CodeBlock";

const BUTTON = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40";
const INPUT = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus:border-focus focus:outline-none";
const fileError = (cause: unknown) => cause instanceof ApiError && cause.status === 404 ? t("workspaceFiles.missing") : String((cause as Error).message);
type WorkspaceEntry = ConversationFile | ConversationUpload;
type WorkspaceContent = ConversationFileContent | ConversationUploadContent;
const isUpload = (file: WorkspaceEntry): file is ConversationUpload => "source" in file && file.source === "upload";
const entryKey = (file: WorkspaceEntry) => isUpload(file) ? `upload:${file.id}` : `file:${file.readName ?? file.name}`;

export function ConversationFilesProvider({ threadId, canWrite, children }: { threadId: string; canWrite: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState<{ threadId: string; draft?: WorkspaceDraft; fileName?: string } | null>(null);
  const open = useCallback((draft?: WorkspaceDraft) => { if (!draft || canWrite) setOpened({ threadId, draft }); }, [threadId, canWrite]);
  const openFile = useCallback((fileName: string) => setOpened({ threadId, fileName }), [threadId]);
  const context = useMemo(() => ({ threadId, canWrite, open, openFile }), [threadId, canWrite, open, openFile]);
  useEffect(() => setOpened(null), [threadId]);
  return <ConversationFilesContext value={context}>
    {children}
    {opened?.threadId === threadId && <ConversationFilesDialog key={`${threadId}:${opened.fileName ?? ""}`} threadId={threadId} canWrite={canWrite} draft={opened.draft} initialFile={opened.fileName} onClose={() => setOpened(null)} />}
  </ConversationFilesContext>;
}

export function ConversationFilesButton() {
  const workspace = useContext(ConversationFilesContext);
  if (!workspace) return null;
  return <button type="button" onClick={() => workspace.open()} aria-label={t("workspaceFiles.title")} title={t("workspaceFiles.title")}
    className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"><FolderOpen size={16} /></button>;
}

export function ConversationFileLinks({ threadId, names }: { threadId: string; names?: readonly string[] }) {
  const workspace = useContext(ConversationFilesContext);
  if (!names?.length || workspace?.threadId !== threadId) return null;
  return <div className="mt-3 flex flex-col items-start gap-1.5" aria-label={t("workspaceFiles.savedFiles")}>
    {[...new Set(names)].map((name) => <a key={name} href={`#workspace-file=${encodeURIComponent(name)}`} onClick={(event) => { event.preventDefault(); workspace.openFile(name); }}
      className="inline-flex max-w-full items-center gap-1.5 rounded text-[13px] text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
      <FileText size={15} className="shrink-0" aria-hidden="true" /><span className="min-w-0 break-all">{t("workspaceFiles.openFile", { name: name.replace(/^shared:[\w-]+:/, "") })}</span>
    </a>)}
  </div>;
}

function ConversationFilesDialog({ threadId, canWrite, draft, initialFile, onClose }: { threadId: string; canWrite: boolean; draft?: WorkspaceDraft; initialFile?: string; onClose(): void }) {
  const endpoint = `/api/threads/${encodeURIComponent(threadId)}/workspace-files`;
  const dialog = useRef<HTMLDivElement>(null), request = useRef(0), mounted = useRef(true), pending = useRef(false);
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [scope, setScope] = useState<FileWorkspaceScope | null>(null);
  const [selected, setSelected] = useState<WorkspaceContent | null>(null);
  const [editing, setEditing] = useState(Boolean(draft));
  const [name, setName] = useState(draft?.name ?? "notes.md");
  const [content, setContent] = useState(draft?.content ?? "");
  const [working, setWorking] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"close" | "delete" | null>(null);
  const uploaded = selected && isUpload(selected);
  const dirty = editing && (selected ? content !== selected.content : Boolean(content || name !== "notes.md"));
  const close = () => { if (!pending.current) { if (dirty) setConfirm("close"); else onClose(); } };
  useModalDialog(dialog, close);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);

  const refresh = useCallback(async () => {
    const result = await api<{ files: ConversationFile[]; uploads?: ConversationUpload[]; scope?: FileWorkspaceScope }>(endpoint);
    const entries = [...result.files, ...(result.uploads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt || entryKey(a).localeCompare(entryKey(b)));
    if (mounted.current) { setFiles(entries); setScope(result.scope ?? null); }
    return entries;
  }, [endpoint]);
  useEffect(() => {
    let active = true;
    const id = ++request.current;
    void Promise.all([refresh(), initialFile ? api<ConversationFileContent>(`${endpoint}?name=${encodeURIComponent(initialFile)}`) : null])
      .then(([, file]) => {
        if (active && id === request.current && file) { setSelected(file); setName(file.name); setContent(file.content); }
      })
      .catch((cause: unknown) => { if (active && id === request.current) setError(fileError(cause)); })
      .finally(() => { if (active && id === request.current) setLoading(false); });
    return () => { active = false; };
  }, [refresh, endpoint, initialFile]);

  async function openFile(file: WorkspaceEntry) {
    if (pending.current || editing) return;
    const id = ++request.current;
    setError(""); setNotice(""); setLoading(true); setSelected(null);
    try {
      const query = isUpload(file) ? `upload=${encodeURIComponent(file.id)}` : `name=${encodeURIComponent(file.readName ?? file.name)}`;
      const result = await api<WorkspaceContent>(`${endpoint}?${query}`);
      if (mounted.current && id === request.current) { setSelected(result); setName(result.name); setContent(result.content ?? ""); }
    } catch (cause) { if (mounted.current && id === request.current) setError(fileError(cause)); }
    finally { if (mounted.current && id === request.current) setLoading(false); }
  }

  async function mutate(remove = false) {
    if (pending.current || !canWrite || uploaded) return;
    pending.current = true; request.current++; setWorking(true); setError(""); setNotice("");
    try {
      if (remove && selected) {
        await api(endpoint, { method: "DELETE", body: JSON.stringify({ name: selected.readName ?? selected.name, revision: "revision" in selected ? selected.revision : undefined }) });
        if (mounted.current) { setSelected(null); setContent(""); setConfirm(null); }
      } else {
        const file = await api<ConversationFileContent>(endpoint, { method: "POST", body: JSON.stringify({ name: selected?.readName ?? name, content, ...(selected && "revision" in selected ? { revision: selected.revision } : {}) }) });
        if (mounted.current) { setSelected(file); setName(file.name); setContent(file.content); setEditing(false); setNotice(t(scope ? "workspaceFiles.sharedSaved" : "workspaceFiles.saved")); }
      }
      await refresh();
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { pending.current = false; if (mounted.current) setWorking(false); }
  }

  return createPortal(<div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("workspaceFiles.title")} tabIndex={-1} aria-busy={working || undefined}
      className="flex h-[min(760px,90dvh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-hairline/40 px-5 py-4">
        <div><h2 className="flex items-center gap-2 text-[16px] font-semibold"><FolderOpen size={18} />{t("workspaceFiles.title")}</h2><p className="mt-1 text-[12px] text-ink-secondary">{scope ? t("workspaceFiles.sharedDescription", { department: scope.label }) : t("workspaceFiles.description")}</p>{scope && <p className="mt-1 text-[11px] text-ink-tertiary">{scope.members.join(" · ")}</p>}</div>
        <button type="button" onClick={close} disabled={working} className={BUTTON} aria-label={t("common.close")}><X size={18} /></button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="flex max-h-44 shrink-0 flex-col border-b border-hairline/40 sm:max-h-none sm:w-56 sm:border-b-0 sm:border-r">
          <div className="flex items-center justify-between px-2 py-2">
            <button type="button" disabled={!canWrite || editing || working || loading || Boolean(confirm)} className={BUTTON} onClick={() => { request.current++; setSelected(null); setName("notes.md"); setContent(""); setEditing(true); setError(""); setNotice(""); }}><FilePlus2 size={14} />{t("workspaceFiles.new")}</button>
            <button type="button" disabled={working || loading} aria-label={t("workspaceFiles.refresh")} className={BUTTON} onClick={() => { setError(""); void refresh().catch((cause: Error) => setError(cause.message)); }}><RefreshCw size={14} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" aria-label={t("workspaceFiles.list")}>
            {files.map((file) => <button key={entryKey(file)} type="button" disabled={editing || working || Boolean(confirm)} aria-current={selected && entryKey(selected) === entryKey(file) ? "true" : undefined} onClick={() => void openFile(file)}
              className={`mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-[12px] disabled:opacity-50 ${selected && entryKey(selected) === entryKey(file) ? "bg-accent/10 text-accent" : "hover:bg-raised"}`}>
              <FileText size={15} className="mt-0.5 shrink-0" /><span className="min-w-0"><span className="block truncate" title={file.name}>{file.name}</span><span className="text-[11px] text-ink-tertiary">{isUpload(file) ? t("workspaceFiles.uploaded") : t("workspaceFiles.created")} · {isUpload(file) && !file.available ? t("workspaceFiles.unavailable") : `${(file.bytes / 1024).toFixed(1)} KB`}</span>{file.sourceLabel && <span className="block truncate text-[10px] text-ink-tertiary" title={file.sourceLabel}>{file.sourceLabel}</span>}{isUpload(file) && <span className="block text-[10px] text-ink-tertiary">{new Date(file.updatedAt).toLocaleString()}</span>}</span>
            </button>)}
            {!files.length && !loading && <p className="px-2 py-3 text-[12px] text-ink-secondary">{t("workspaceFiles.empty")}</p>}
          </div>
          <p className="border-t border-hairline/30 px-4 py-2 text-[11px] text-ink-tertiary">{t(scope ? "workspaceFiles.sharedLimits" : "workspaceFiles.limits")}</p>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {(selected || editing) ? <>
            <div className="flex flex-wrap items-center gap-2 border-b border-hairline/30 px-4 py-2">
              {editing && !selected ? <label className="min-w-0 flex-1"><span className="sr-only">{t("workspaceFiles.name")}</span><input className={INPUT} value={name} onChange={(event) => setName(event.target.value)} disabled={working} autoComplete="off" placeholder="analysis.md" /></label>
                : <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{selected?.name}</span>}
              {!editing && selected && <>
                {isUpload(selected) ? <a className={BUTTON} href={`${endpoint}?upload=${encodeURIComponent(selected.id)}&download=1`} download={selected.name}><Download size={14} />{t("workspaceFiles.download")}</a>
                  : <button type="button" disabled={loading || working} className={BUTTON} onClick={() => downloadSnippetFile(selected.name, selected.content)}><Download size={14} />{t("workspaceFiles.download")}</button>}
                {canWrite && !uploaded && <><button type="button" disabled={loading || working || Boolean(confirm)} className={BUTTON} onClick={() => { setEditing(true); setNotice(""); }}><Pencil size={14} />{t("workspaceFiles.edit")}</button>
                  <button type="button" disabled={loading || working || Boolean(confirm)} className={BUTTON} onClick={() => setConfirm("delete")} aria-label={t("workspaceFiles.delete")}><Trash2 size={14} /></button></>}
              </>}
            </div>
            {editing ? <textarea aria-label={t("workspaceFiles.content")} spellCheck={false} disabled={working} value={content} onChange={(event) => setContent(event.target.value)}
              className="min-h-0 flex-1 resize-none bg-inset p-4 font-mono text-[13px] leading-6 text-ink outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40" />
              : <div className="min-h-0 flex-1 overflow-auto p-5"><ConversationFilesContext value={null}>
                {uploaded && <p className="mb-4 text-[12px] text-ink-secondary">{t("workspaceFiles.originalHint")}</p>}
                {selected?.content === undefined ? <p className="text-[13px] text-ink-secondary">{t("workspaceFiles.downloadPreview")}</p>
                  : /\.(md|markdown)$/i.test(selected.name) ? <ChatMarkdown text={selected.content} /> : <CodeBlock code={selected.content} lang={selected.name.split(".").at(-1) ?? "text"} initialWrap />}
              </ConversationFilesContext></div>}
          </> : <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-ink-secondary"><FolderOpen size={32} className="text-ink-tertiary" /><p>{t(loading ? "workspaceFiles.loading" : "workspaceFiles.hint")}</p></div>}
          {editing && <div className="flex justify-end gap-2 border-t border-hairline/30 px-4 py-3">
            <button type="button" className={BUTTON} disabled={working} onClick={() => { setEditing(false); setContent(selected?.content ?? ""); setError(""); }}>{t("common.cancel")}</button>
            <button type="button" disabled={working || !name.trim() || !canWrite} onClick={() => void mutate()} className={`${BUTTON} bg-accent text-white hover:bg-accent/90 hover:text-white`}>{t(working ? "workspaceFiles.saving" : "workspaceFiles.save")}</button>
          </div>}
        </section>
      </div>
      {(error || notice) && <p role={error ? "alert" : "status"} className={`border-t border-hairline/30 px-5 py-2 text-[12px] ${error ? "text-danger" : "text-success"}`}>{error || notice}</p>}
      {confirm && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline/40 bg-inset px-5 py-3 text-[13px]">
        <span>{t(confirm === "close" ? "workspaceFiles.discardHint" : "workspaceFiles.deleteHint")}</span><div className="flex gap-2"><button type="button" disabled={working} className={BUTTON} onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
          <button type="button" disabled={working} className={`${BUTTON} text-danger`} onClick={() => confirm === "close" ? onClose() : void mutate(true)}>{t(confirm === "close" ? "workspaceFiles.discard" : "workspaceFiles.delete")}</button></div>
      </div>}
    </div>
  </div>, document.body);
}
