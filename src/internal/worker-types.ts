import type {
  EndpointKind,
  HealthSnapshot,
  JsonValue,
  RuntimeKind,
  RuntimeManifest,
} from "../types";

export interface WorkerInitializePayload {
  runtime: RuntimeKind;
  manifestUrl?: string;
  manifest?: RuntimeManifest;
  corsBusterUrl?: string;
}

export interface WorkerInvokePayload {
  requestId: string;
  endpoint: EndpointKind;
  requestPayload: Record<string, unknown>;
  stream: boolean;
  timeoutMs?: number;
}

export interface WorkerStreamOpenPayload {
  requestId: string;
  endpoint: EndpointKind;
  readablePort: MessagePort;
}

export interface WorkerEventEnvelope {
  type:
    | "stream_open"
    | "callback"
    | "progress"
    | "debug"
    | "result_meta"
    | "failure_meta"
    | "worker:boot"
    | "worker:ready"
    | "worker:error"
    | "worker:shutdown";
  requestId?: string;
  workerId?: string;
  endpoint?: EndpointKind;
  payload: unknown;
}

export interface WorkerResultEnvelope {
  requestId: string;
  endpoint: EndpointKind;
  result: JsonValue;
}

export interface WorkerApi {
  initialize(payload: WorkerInitializePayload): Promise<HealthSnapshot>;
  invoke(payload: WorkerInvokePayload): Promise<WorkerResultEnvelope>;
  health(): Promise<HealthSnapshot>;
  shutdown(): Promise<void>;
}
