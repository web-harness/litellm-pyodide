import type { EndpointKind, RuntimeKind } from "./types";

export interface SerializedWorkerError {
  name: string;
  message: string;
  endpoint?: EndpointKind;
  requestId?: string;
  statusCode?: number;
  stack?: string;
  workerId?: string;
  runtime?: RuntimeKind;
  providerData?: unknown;
}

export class LiteLLMPyodideError extends Error {
  endpoint?: EndpointKind;
  requestId?: string;
  statusCode?: number;
  workerId?: string;
  runtime?: RuntimeKind;
  providerData?: unknown;

  constructor(details: SerializedWorkerError) {
    super(details.message);
    this.name = details.name;
    this.endpoint = details.endpoint;
    this.requestId = details.requestId;
    this.statusCode = details.statusCode;
    this.workerId = details.workerId;
    this.runtime = details.runtime;
    this.providerData = details.providerData;
    if (details.stack) {
      this.stack = details.stack;
    }
  }
}

export class UnsupportedRuntimeError extends LiteLLMPyodideError {
  constructor(message = "Unsupported runtime") {
    super({ name: "UnsupportedRuntimeError", message });
  }
}

export class WorkerInitializationError extends LiteLLMPyodideError {
  constructor(message: string) {
    super({ name: "WorkerInitializationError", message });
  }
}

export class RequestAbortedError extends LiteLLMPyodideError {
  constructor(message: string, requestId?: string) {
    super({ name: "RequestAbortedError", message, requestId });
  }
}
