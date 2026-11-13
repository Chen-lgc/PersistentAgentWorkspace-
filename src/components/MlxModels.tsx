import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { HubModel, MlxStatus } from "../../shared/mlx";

const field = "rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-sm text-ink";
const button = "rounded-lg border border-hairline/50 px-3 py-2 text-sm text-ink hover:bg-raised disabled:opacity-50";
const bytes = (size: number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GiB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MiB` : `${(size / 1024).toFixed(1)} KiB`;

export function MlxModels() {
  const { refreshInstances } = useStore();
  const [status, setStatus] = useState<MlxStatus | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [python, setPython] = useState("");
  const [search, setSearch] = useState("mlx");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [models, setModels] = useState<HubModel[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [repo, setRepo] = useState("");
  const [revision, setRevision] = useState("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const catalog = useRef("");
  const alive = useRef(true);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const next = await api<MlxStatus>("/api/mlx", { background: true });
    if (!alive.current) return;
    setStatus(next);
    if (!initialized.current) {
      setEndpoint(next.connection?.endpoint ?? ""); setAllowHttp(next.connection?.allowHttp ?? false); setPython(next.python);
      initialized.current = true;
    }
    const signature = JSON.stringify([next.runtime, next.models.map((m) => m.id)]);
    if (catalog.current !== signature) { catalog.current = signature; await refreshInstances(); }
  }, [refreshInstances]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e: Error) => { if (alive.current) setError(e.message); });
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 2500);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); };
  }, [refresh]);
  async function act(path: string, body: unknown = {}) {
    setBusy(true); setError("");
    try { await api(`/api/mlx/${path}`, { method: "POST", body: JSON.stringify(body), timeoutMs: 15 * 60_000 }); await refresh(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function browse(nextPage = 1) {
    const request = ++sequence.current;
    setBusy(true); setError("");
    try {
      const result = await api<{ models: HubModel[]; hasMore: boolean }>(`/api/mlx/models?${new URLSearchParams({ search, page: String(nextPage), mine: String(mine) })}`);
      if (request !== sequence.current) return;
      setModels(result.models); setPage(nextPage); setHasMore(result.hasMore);
    } catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === sequence.current) setBusy(false); }
  }
  return <section className="mx-4 space-y-4 rounded-xl border border-hairline/50 p-4" aria-label={t("mlx.title")}>
    <h2 className="font-semibold text-ink">{t("mlx.title")}</h2>
    <p className="text-sm text-ink-secondary">{t("mlx.intro")}</p>
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    {status?.connectionError && <p role="alert" className="text-sm text-danger">{status.connectionError}</p>}
    {status && !status.supported && <p className="text-sm text-ink-secondary">{t("mlx.platform")}</p>}
    <form className="flex flex-col gap-2" onSubmit={(event) => {
      event.preventDefault();
      const value = token; setToken(""); setModels([]); sequence.current++;
      void act("connect", { endpoint, token: value, allowHttp });
    }}>
      <label className="flex flex-col gap-1 text-sm">{t("mlx.endpoint")}<input className={field} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://models.example.com" required autoComplete="url" /></label>
      <label className="flex flex-col gap-1 text-sm">{t("mlx.token")}<input className={field} value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" required /></label>
      <label className="flex items-start gap-2 text-xs text-ink-secondary"><input type="checkbox" checked={allowHttp} onChange={(e) => setAllowHttp(e.target.checked)} />{t("mlx.http")}</label>
      <div className="flex flex-wrap items-center gap-2">
        <button className={button} disabled={busy || !token.trim()}>{t("mlx.connect")}</button>
        {status?.authenticated && <><span className="text-sm text-ink-secondary">{t("mlx.connected", { user: status.connection?.username ?? "" })}</span>
          <button type="button" className={button} disabled={busy} onClick={() => { setModels([]); sequence.current++; void act("disconnect"); }}>{t("mlx.disconnect")}</button></>}
      </div>
    </form>
    {status?.authenticated && <div className="space-y-3 border-t border-hairline/50 pt-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void browse(); }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">{t("mlx.search")}<input className={field} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label className="flex items-center gap-1 py-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />{t("mlx.mine")}</label>
        <button className={button} disabled={busy}>{t("mlx.browse")}</button>
      </form>
      {models.map((model) => <div key={model.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline/50 p-3">
        <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{model.id} {model.private ? "🔒" : ""}</p><p className="line-clamp-2 text-xs text-ink-secondary">{model.description}</p><p className="text-xs text-ink-secondary">{model.tags.join(" · ")}</p></div>
        <button className={button} disabled={busy} onClick={() => { void act("download", { repo: model.id, revision: "main" }); }}>{t("mlx.download")}</button>
      </div>)}
      <div className="flex gap-2"><button className={button} disabled={busy || page <= 1} onClick={() => { void browse(page - 1); }}>{t("mlx.previous")}</button><button className={button} disabled={busy || !hasMore} onClick={() => { void browse(page + 1); }}>{t("mlx.next")}</button></div>
      <p className="text-xs text-ink-secondary">{t("mlx.catalogHint")}</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act("download", { repo, revision }); }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">{t("mlx.repo")}<input className={field} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="team/model-mlx" required /></label>
        <label className="flex w-28 flex-col gap-1 text-sm">{t("mlx.revision")}<input className={field} value={revision} onChange={(e) => setRevision(e.target.value)} required /></label>
        <button className={button} disabled={busy}>{t("mlx.download")}</button>
      </form>
    </div>}
    {(status?.downloads ?? []).map((job) => <div key={job.id} className="space-y-1 text-sm">
      <p className="break-all">{job.repo} · {t(`mlx.job.${job.state}`)} · {bytes(job.received)} / {bytes(job.total)}</p>
      {job.state === "downloading" && <><progress className="w-full" value={job.received} max={Math.max(job.total, job.received, 1)} /><button className={button} onClick={() => { void act("cancel", { id: job.id }); }}>{t("mlx.cancel")}</button></>}
      {job.error && <p role="alert" className="text-danger">{job.error}</p>}
    </div>)}
    {status?.supported && <div className="space-y-2 border-t border-hairline/50 pt-3">
      <h3 className="font-medium">{t("mlx.runtime")}: {t(`mlx.runtime.${status.runtime}`)}</h3>
      <p className="text-xs text-ink-secondary">{t("mlx.runtimeHint")}</p>
      <label className="flex flex-col gap-1 text-sm">{t("mlx.python")}<input className={field} value={python} onChange={(e) => setPython(e.target.value)} placeholder="/path/to/venv/bin/python" /></label>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy || status.generating} onClick={() => { void act("runtime/install", { python: python || "python3" }); }}>{t("mlx.install")}</button>
        <button className={button} disabled={busy || status.generating || !python} onClick={() => { void act("runtime/configure", { python }); }}>{t("mlx.usePython")}</button>
      </div>
      {status.runtimeError && <p role="alert" className="break-words text-sm text-danger">{status.runtimeError}</p>}
    </div>}
    <div className="space-y-2 border-t border-hairline/50 pt-3">
      <h3 className="font-medium">{t("mlx.local")}</h3>
      {!status?.models.length && <p className="text-sm text-ink-secondary">{t("mlx.empty")}</p>}
      {status?.models.map((model) => <div key={model.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline/50 p-3">
        <div className="min-w-0 flex-1"><p className="break-all text-sm">{model.repo}</p><p className="text-xs text-ink-secondary">{model.backend} · {bytes(model.bytes)} · {model.revision.slice(0, 8)} {status.loaded === model.id ? `· ${t("mlx.loaded")}` : status.loading === model.id ? `· ${t("mlx.loading")}` : ""}</p></div>
        <button className={button} disabled={busy || status.generating || status.runtime !== "ready"} onClick={() => { void act(status.loaded === model.id ? "unload" : "load", { id: model.id }); }}>{t(status.loaded === model.id ? "mlx.unload" : "mlx.load")}</button>
        <button className={button} disabled={busy || status.generating} onClick={() => { void act("remove", { id: model.id }); }}>{t("mlx.remove")}</button>
      </div>)}
      <p className="text-xs text-ink-secondary">{t("mlx.useHint")}</p>
    </div>
  </section>;
}
