import type { DriverCreateInput, ModelCatalog, ProviderSnapshot, SendTurnInput } from "../contracts.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { Completion, OpenAIChatMessage } from "./openai-chat.ts";

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
  incoming(completion: Completion): unknown;
}

export interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  /** An in-process transport for local workers that expose no network listener. */
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean, variant?: string): Record<string, unknown>;
  httpErrorLabel: string;
  /** A refusal this provider words itself: the sentence the person sees instead of the HTTP line, or undefined. */
  plainRefusal?: (status: number, body: string) => string | undefined;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  /** Ask a server on this machine or network for its models this often while a reply is pending, and stop the reply
   * when it misses LIVENESS_MISSES checks in a row: it crashed, froze or left the network. */
  livenessEveryMs?: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  /** Cerebras rejects `reasoning_content` and takes `reasoning`. */
  reasoningReplayField?: "reasoning_content" | "reasoning";
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  tools?: boolean;
  computerUse?: boolean;
  /** A text-only model keeps the computer and browser tools but never receives a screenshot or attachment. */
  imageInput?: (model: string) => boolean;
  /** Some models list `variants`; the picked one reaches `requestBody`. */ modelVariants?: boolean;
  /** False for a model its server says cannot call tools: its turns go without them instead of being refused. */ toolUse?: (model: string) => boolean;
  /** Why the server cannot answer now (not running, nothing to run), asked before the key is. */
  serverUnavailable?: () => Promise<Pick<ProviderSnapshot, "reason" | "ollama"> | null>;
  /** The name to send for a model, when its server knows it by another. */
  servedModel?: (model: string) => Promise<string>;
  /** Smaller models announce a step and end the turn without calling a tool; such a reply gets a nudge, at most three
   * per turn and each only after tool progress since the last. */
  nudgeAnnouncedAction?: boolean;
  /** A model on this machine or network: read a tool call it wrote as text, stop it repeating itself, and send it back
   * to fix a failed call instead of ending the turn on it. */
  localModel?: boolean;
}
