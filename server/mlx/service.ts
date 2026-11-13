import type { MlxStatus } from "../../shared/mlx.ts";
import { CsgHub, checkedConnection } from "./hub.ts";
import { MlxStorage } from "./storage.ts";
import { MlxRuntime } from "./runtime.ts";

export class MlxService {
  readonly storage: MlxStorage;
  readonly runtime: MlxRuntime;
  hub: CsgHub | null = null;
  connectionError?: string;
  private connecting = false;
  constructor(dataDir: string) {
    this.storage = new MlxStorage(dataDir);
    this.runtime = new MlxRuntime(this.storage);
    try { const saved = this.storage.credentials(); if (saved) this.hub = new CsgHub(saved); }
    catch { this.connectionError = "Cannot read the saved CSGHub credentials. Connect again with an access token."; }
  }
  status(): MlxStatus {
    return { supported: this.runtime.supported, connection: this.hub?.publicConnection() ?? null,
      authenticated: this.hub !== null, connectionError: this.connectionError, python: this.runtime.python, runtime: this.runtime.state,
      runtimeError: this.runtime.error, loaded: this.runtime.loaded, loading: this.runtime.loading,
      generating: this.runtime.busy, models: [...this.storage.models], downloads: [...this.storage.downloads.values()] };
  }
  async connect(raw: unknown) {
    if (this.connecting) throw new Error("A CSGHub connection is already being checked.");
    this.connecting = true;
    try {
      const next = new CsgHub(checkedConnection(raw));
      await next.authenticate();
      await this.storage.cancelAll();
      this.storage.saveCredentials(next.config); this.hub = next; this.connectionError = undefined;
    } finally { this.connecting = false; }
  }
  async disconnect() {
    if (this.connecting) throw new Error("Wait for the connection check to finish.");
    this.hub = null; await this.storage.disconnect();
  }
  requireHub() { if (!this.hub) throw new Error("Connect to CSGHub first."); return this.hub; }
  async close() { await Promise.all([this.storage.cancelAll(), this.runtime.close()]); }
}
