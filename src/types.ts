export type RuntimeKind = "browser" | "node";

export type EndpointKind =
  | "chat_completions"
  | "messages"
  | "responses"
  | "embeddings";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface BaseRequest {
  model: string;
  metadata?: Record<string, JsonValue>;
  timeout?: number;
  api_key?: string;
  api_base?: string;
  api_version?: string;
  [key: string]: unknown;
}

export interface ChatCompletionRequest extends BaseRequest {
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
}

export interface MessagesRequest extends BaseRequest {
  messages: Array<Record<string, unknown>>;
  max_tokens?: number;
  system?: string | Array<Record<string, unknown>>;
  stop_sequences?: string[];
  thinking?: Record<string, unknown>;
  tool_choice?: string | Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
}

export interface ResponsesRequest extends BaseRequest {
  input: unknown;
  previous_response_id?: string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  truncation?: string | Record<string, unknown>;
  context_management?: Record<string, unknown>;
  stream?: boolean;
}

export interface EmbeddingsRequest extends BaseRequest {
  input: string | string[] | number[] | number[][];
  dimensions?: number;
  encoding_format?: string;
}

export interface StreamChunk<T = JsonValue> {
  requestId: string;
  endpoint: EndpointKind;
  chunk: T;
}

export interface CallbackEventPayload {
  requestId?: string;
  workerId?: string;
  endpoint?: EndpointKind;
  hook: string;
  payloadKind?: string;
  model?: string;
  response_cost?: number;
  timestamp: string;
  details: JsonValue;
}

export interface WorkerLifecycleEvent {
  workerId?: string;
  runtime: RuntimeKind;
  timestamp: string;
  details: JsonValue;
}

export interface RuntimeManifestWheel {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  tags: string[];
}

export interface RuntimeManifest {
  schemaVersion: 1;
  builtAt: string;
  packageVersion: string;
  pyodideVersion: string;
  litellmVersion: string;
  pyodide: {
    indexURL: string;
    modulePath: string;
    lockFilePath: string;
  };
  python: {
    bridgePath: string;
  };
  wheels: RuntimeManifestWheel[];
  reports: {
    compatibilityPath: string;
  };
}

export interface ClientOptions {
  minWorkers?: number;
  maxWorkers?: number;
  warmup?: boolean;
  requestTimeoutMs?: number;
  manifestUrl?: string;
}

export interface HealthSnapshot {
  initialized: boolean;
  runtime: RuntimeKind;
  workerId?: string;
  installedWheels: string[];
  lastFatalError?: string;
}

export interface ClientEvents {
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  removeAllListeners(event?: string): this;
}
