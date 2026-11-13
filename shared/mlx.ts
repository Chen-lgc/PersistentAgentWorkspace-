export interface HubConnection {
  endpoint: string;
  username: string;
  allowHttp: boolean;
}

export interface HubModel {
  id: string;
  private: boolean;
  description: string;
  tags: string[];
}

export interface MlxModel {
  id: string;
  repo: string;
  endpoint: string;
  revision: string;
  backend: "mlx-lm" | "ssm-mlx";
  bytes: number;
  downloadedAt: string;
}

export interface MlxDownload {
  id: string;
  repo: string;
  state: "downloading" | "ready" | "failed" | "cancelled";
  received: number;
  total: number;
  file?: string;
  error?: string;
}

export interface MlxStatus {
  supported: boolean;
  connection: HubConnection | null;
  authenticated: boolean;
  connectionError?: string;
  python: string;
  runtime: "missing" | "installing" | "ready" | "failed";
  runtimeError?: string;
  loaded: string | null;
  loading: string | null;
  generating: boolean;
  models: MlxModel[];
  downloads: MlxDownload[];
}
