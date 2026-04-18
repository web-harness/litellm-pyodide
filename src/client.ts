import createDebug from "debug";
import EventEmitter from "eventemitter3";
import uniqid from "uniqid";
import { mergeMetadata } from "./internal/metadata";
import { PoolAdapter } from "./internal/pool-adapter";
import { detectRuntime } from "./runtime/detect";
import type {
  ChatCompletionRequest,
  ClientEventMap,
  ClientEvents,
  ClientOptions,
  EmbeddingsRequest,
  HealthSnapshot,
  JsonValue,
  MessagesRequest,
  ResponsesRequest,
  StreamChunk,
} from "./types";

type StreamResult = ReadableStream<StreamChunk>;
type EndpointResult = JsonValue;
type RequestWithClientFields = Record<string, unknown> & {
  stream?: boolean;
  metadata?: Record<string, JsonValue>;
  signal?: AbortSignal;
};

function stripSignal(request: Record<string, unknown>) {
  const next = { ...request };
  delete next.signal;
  return next;
}

const debug = createDebug("litellmPyodide:client");

export class LiteLLMPyodideClient {
  readonly events: ClientEvents;
  readonly chatCompletions: {
    create: (
      request: ChatCompletionRequest & { signal?: AbortSignal },
    ) => Promise<EndpointResult | StreamResult>;
  };
  readonly messages: {
    create: (
      request: MessagesRequest & { signal?: AbortSignal },
    ) => Promise<EndpointResult | StreamResult>;
  };
  readonly responses: {
    create: (
      request: ResponsesRequest & { signal?: AbortSignal },
    ) => Promise<EndpointResult | StreamResult>;
  };
  readonly embeddings: {
    create: (
      request: EmbeddingsRequest & { signal?: AbortSignal },
    ) => Promise<EndpointResult>;
  };

  private readonly emitter: EventEmitter<ClientEventMap>;
  private readonly adapter: PoolAdapter;
  private readonly options: ClientOptions;
  private closed = false;

  constructor(options: ClientOptions = {}) {
    this.options = options;
    this.emitter = new EventEmitter<ClientEventMap>();
    this.events = this.emitter;
    this.adapter = new PoolAdapter(detectRuntime(), options, this.emitter);

    this.chatCompletions = {
      create: (request) => this.invoke("chat_completions", request),
    };
    this.messages = {
      create: (request) => this.invoke("messages", request),
    };
    this.responses = {
      create: (request) => this.invoke("responses", request),
    };
    this.embeddings = {
      create: (request) => this.invoke("embeddings", request),
    };

    if (options.warmup) {
      void this.warmup();
    }
  }

  async warmup(): Promise<HealthSnapshot> {
    this.ensureOpen();
    return this.adapter.initializeIfNeeded();
  }

  async health(): Promise<HealthSnapshot> {
    this.ensureOpen();
    return this.adapter.health();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    debug("close");
    await this.adapter.close();
  }

  private async invoke(
    endpoint: "embeddings",
    request: RequestWithClientFields,
  ): Promise<EndpointResult>;
  private async invoke(
    endpoint: "chat_completions" | "messages" | "responses",
    request: RequestWithClientFields,
  ): Promise<EndpointResult | StreamResult>;
  private async invoke(
    endpoint: "chat_completions" | "messages" | "responses" | "embeddings",
    request: RequestWithClientFields,
  ): Promise<EndpointResult | StreamResult> {
    this.ensureOpen();
    const requestId = uniqid("req-");
    const stream = Boolean(request.stream);
    debug("invoke", { endpoint, requestId, stream });
    const payload = stripSignal({
      ...request,
      metadata: mergeMetadata(request.metadata, requestId, endpoint, stream),
    });

    if (stream) {
      return this.adapter.runStream({
        requestId,
        endpoint,
        payload,
        stream,
        timeoutMs: this.options.requestTimeoutMs,
        signal: request.signal,
      });
    }

    return this.adapter.run({
      requestId,
      endpoint,
      payload,
      stream,
      timeoutMs: this.options.requestTimeoutMs,
      signal: request.signal,
    });
  }

  private ensureOpen() {
    if (this.closed) {
      throw new Error("Client is closed");
    }
  }
}

export function createClient(options: ClientOptions = {}) {
  return new LiteLLMPyodideClient(options);
}
