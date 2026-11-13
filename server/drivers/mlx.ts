import { z } from "zod";
import type { ProviderDriver } from "../contracts.ts";
import type { MlxService } from "../mlx/service.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

export function createMlxDriver(service: MlxService): ProviderDriver<Record<string, never>> {
  return {
    driverKind: "mlx", metadata: { displayName: "MLX · Local", access: "custom" },
    models: { default: "", options: [] },
    decodeConfig: (raw) => z.object({}).parse(raw ?? {}), defaultConfig: () => ({}),
    async create(input) {
      return createOpenAIChatRuntime({
        input, driverKind: "mlx", apiKey: "local-worker", apiUrl: "http://127.0.0.1/mlx/v1",
        transport: async (_url, init) => service.runtime.completion(JSON.parse(String(init.body)), init.signal ?? undefined),
        models: () => ({ default: service.storage.models[0]?.id ?? "", options: service.storage.models.map((m) => ({ id: m.id, label: `${m.repo} · ${m.backend} · ${m.revision.slice(0, 8)}`, contextWindow: 32768 })) }),
        serverUnavailable: async () => !service.runtime.supported ? { reason: "MLX requires an Apple Silicon Mac." }
          : service.runtime.state !== "ready" ? { reason: "Set up the MLX runtime in Settings → Engines → Local MLX." }
            : service.storage.models.length === 0 ? { reason: "Download a model in Settings → Engines → Local MLX." } : null,
        requestBody: (model, messages, stream) => ({ model, messages, stream, max_tokens: 2048 }),
        httpErrorLabel: "MLX", missingKeyError: "MLX runtime is unavailable.", unavailableReason: "MLX runtime is unavailable.",
        timeoutMs: 15 * 60_000, localModel: true, computerUse: true, imageInput: () => false,
        nudgeAnnouncedAction: true, includeUsageInCompleted: true,
        nativeLog: { source: "mlx.local", outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
          incoming: ({ text, usage }) => ({ textLength: text.length, usage }) },
      });
    },
  };
}
