import type EventEmitter from "eventemitter3";
import createDebug from "debug";
import { fromReadablePort } from "remote-web-streams";
import workerpool from "workerpool";
import { RequestAbortedError, WorkerInitializationError } from "../errors";
import type {
  ClientOptions,
  EndpointKind,
  HealthSnapshot,
  JsonValue,
  RuntimeKind,
  StreamChunk,
} from "../types";
import { loadRuntimeManifest } from "./runtime-manifest";
import type {
  WorkerEventEnvelope,
  WorkerInvokePayload,
  WorkerResultEnvelope,
} from "./worker-types";

declare const __webpack_public_path__: string;

const debug = createDebug("litellmPyodide:pool");

interface RunRequestOptions {
  requestId: string;
  endpoint: EndpointKind;
  payload: Record<string, unknown>;
  stream: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PoolAdapter {
  private readonly pool: workerpool.Pool;
  private readonly emitter: EventEmitter;
  private readonly runtime: RuntimeKind;
  private readonly options: ClientOptions;
  private readonly activeStreamCancels = new Set<() => Promise<void>>();
  private initializePromise?: Promise<HealthSnapshot>;

  constructor(
    runtime: RuntimeKind,
    options: ClientOptions,
    emitter: EventEmitter,
  ) {
    this.runtime = runtime;
    this.options = options;
    this.emitter = emitter;
    const baseUrl = __webpack_public_path__ || "./";
    const workerScriptPath = `${baseUrl}internal/worker.mjs`;
    const workerScript =
      this.runtime === "node" && workerScriptPath.startsWith("file:")
        ? new URL(workerScriptPath).pathname
        : workerScriptPath;
    this.pool = workerpool.pool(workerScript as unknown as string, {
      workerType: this.runtime === "node" ? "thread" : "web",
      ...(this.runtime === "node"
        ? {}
        : { workerOpts: { type: "module" as WorkerOptions["type"] } }),
      ...(typeof options.minWorkers === "number"
        ? { minWorkers: options.minWorkers }
        : {}),
      ...(typeof options.maxWorkers === "number"
        ? { maxWorkers: options.maxWorkers }
        : {}),
    });
  }

  async initializeIfNeeded(): Promise<HealthSnapshot> {
    if (!this.initializePromise) {
      this.initializePromise = this.initialize();
    }

    return this.initializePromise;
  }

  async initialize(): Promise<HealthSnapshot> {
    try {
      debug("initialize");
      const manifest = await loadRuntimeManifest(this.options.manifestUrl);
      const workerCount = Math.max(
        1,
        this.options.maxWorkers ?? this.options.minWorkers ?? 1,
      );
      const results = await Promise.all(
        Array.from({ length: workerCount }, () =>
          this.pool.exec("initialize", [
            {
              runtime: this.runtime,
              manifest,
              manifestUrl: this.options.manifestUrl,
            },
          ]),
        ),
      );
      return results[0] as HealthSnapshot;
    } catch (error) {
      throw new WorkerInitializationError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async run(options: RunRequestOptions): Promise<JsonValue> {
    await this.initializeIfNeeded();
    debug("run", { endpoint: options.endpoint, requestId: options.requestId });
    const task = this.createTask(options);
    const result = (await task.promise.catch((error) => {
      throw this.normalizeTaskError(error, options);
    })) as WorkerResultEnvelope;
    return result.result;
  }

  async runStream(
    options: RunRequestOptions,
  ): Promise<ReadableStream<StreamChunk>> {
    await this.initializeIfNeeded();
    debug("runStream", {
      endpoint: options.endpoint,
      requestId: options.requestId,
    });
    let opened = false;
    let resolvePort: ((port: MessagePort) => void) | undefined;
    let rejectPort: ((error: unknown) => void) | undefined;
    const openedPort = new Promise<MessagePort>((resolve, reject) => {
      resolvePort = resolve;
      rejectPort = reject;
    });

    const task = this.createTask(options, (event) => {
      if (event.type !== "stream_open") {
        return;
      }

      const payload = event.payload as { readablePort: MessagePort };
      opened = true;
      debug("stream_open", {
        endpoint: options.endpoint,
        requestId: options.requestId,
      });
      resolvePort?.(payload.readablePort);
    });

    const taskCompletion = task.promise.then((result) => {
      this.emitSafe("request:completed", {
        requestId: options.requestId,
        endpoint: options.endpoint,
        result: result.result,
      });
      return result;
    });
    const taskFailure = taskCompletion.then(
      () => new Promise<never>(() => undefined),
      (error) => Promise.reject(this.normalizeTaskError(error, options)),
    );

    void taskFailure.catch((error) => {
      if (!opened) {
        rejectPort?.(error);
      }
    });

    const port = await openedPort;
    const remoteReader = fromReadablePort<StreamChunk>(port).getReader();
    let settled = false;

    const releaseStream = () => {
      if (settled) {
        return;
      }
      settled = true;
      this.activeStreamCancels.delete(cancelStream);
      remoteReader.releaseLock();
    };

    const cancelStream = async (reason?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      this.activeStreamCancels.delete(cancelStream);
      task.cancel?.();
      await remoteReader.cancel(reason).catch(() => undefined);
    };

    this.activeStreamCancels.add(cancelStream);

    return new ReadableStream<StreamChunk>({
      pull: async (controller) => {
        try {
          const next = await Promise.race([remoteReader.read(), taskFailure]);
          if (next.done) {
            await taskCompletion.catch(() => undefined);
            releaseStream();
            controller.close();
            return;
          }

          this.emitSafe("request:stream_chunk", next.value);
          controller.enqueue(next.value);
        } catch (error) {
          releaseStream();
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        await cancelStream(reason);
      },
    });
  }

  async health(): Promise<HealthSnapshot> {
    await this.initializeIfNeeded();
    return (await this.pool.exec("health", [])) as HealthSnapshot;
  }

  async close(): Promise<void> {
    try {
      debug("close");
      await Promise.allSettled(
        [...this.activeStreamCancels].map((cancel) => cancel()),
      );
      await this.pool.exec("shutdown", []).catch(() => undefined);
    } finally {
      await this.pool.terminate();
    }
  }

  private createTask(
    options: RunRequestOptions,
    extraHandler?: (event: WorkerEventEnvelope) => void,
  ): {
    promise: Promise<WorkerResultEnvelope>;
    cancel?: () => void;
  } {
    const invokePayload: WorkerInvokePayload = {
      requestId: options.requestId,
      endpoint: options.endpoint,
      requestPayload: options.payload,
      stream: options.stream,
      timeoutMs: options.timeoutMs,
    };

    const task = this.pool.exec("invoke", [invokePayload], {
      on: (event: WorkerEventEnvelope) => {
        this.routeWorkerEvent(event);
        extraHandler?.(event);
      },
    }) as Promise<WorkerResultEnvelope> & {
      cancel?: () => void;
      timeout?: (ms: number) => void;
    };

    if (options.timeoutMs && typeof task.timeout === "function") {
      task.timeout(options.timeoutMs);
    }

    if (options.signal) {
      const onAbort = () => {
        task.cancel?.();
      };
      if (options.signal.aborted) {
        onAbort();
        throw new RequestAbortedError(
          "Request aborted before dispatch",
          options.requestId,
        );
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      void task.finally(() => {
        options.signal?.removeEventListener("abort", onAbort);
      });
    }

    return {
      promise: task,
      cancel:
        typeof task.cancel === "function" ? () => task.cancel?.() : undefined,
    };
  }

  private routeWorkerEvent(event: WorkerEventEnvelope) {
    switch (event.type) {
      case "callback": {
        const payload = event.payload as Record<string, JsonValue>;
        const hook = String(payload.hook ?? "callback:unknown");
        this.emitSafe(`callback:${hook}`, payload);
        break;
      }
      case "worker:boot":
      case "worker:ready":
      case "worker:error":
      case "worker:shutdown":
        this.emitSafe(event.type, event.payload);
        break;
      case "debug":
      case "progress":
      case "result_meta":
      case "failure_meta":
        this.emitSafe(event.type, event.payload);
        break;
      case "stream_open":
        break;
      default:
        break;
    }
  }

  private emitSafe(eventName: string, payload: unknown) {
    try {
      this.emitter.emit(eventName, payload);
    } catch {
      // Listener failures must not break runtime flow.
    }
  }

  private normalizeTaskError(error: unknown, options: RunRequestOptions) {
    if (options.signal?.aborted) {
      return new RequestAbortedError("Request aborted", options.requestId);
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/cancel|aborted/i.test(message)) {
      return new RequestAbortedError(message, options.requestId);
    }

    return error;
  }
}
