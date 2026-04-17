import type { PyodideInterface } from "pyodide";
import createDebug from "debug";
import { RemoteWritableStream } from "remote-web-streams";
import workerpool from "workerpool";
import type {
  EndpointKind,
  HealthSnapshot,
  JsonValue,
  RuntimeKind,
  RuntimeManifest,
  RuntimeManifestWheel,
  StreamChunk,
} from "../types";
import type {
  WorkerEventEnvelope,
  WorkerInitializePayload,
  WorkerInvokePayload,
  WorkerResultEnvelope,
  WorkerStreamOpenPayload,
} from "./worker-types";

declare const __webpack_public_path__: string;

const debug = createDebug("litellmPyodide:worker");
const bridgeDebug = createDebug("litellmPyodide:bridge");

interface WorkerState {
  initialized: boolean;
  initializing: boolean;
  runtime: RuntimeKind;
  workerId: string;
  manifest?: RuntimeManifest;
  pyodide?: PyodideInterface;
  installedWheels: string[];
  lastFatalError?: string;
  streamWriter?: WritableStreamDefaultWriter<StreamChunk>;
  pendingStreamWrite?: Promise<void>;
}

const state: WorkerState = {
  initialized: false,
  initializing: false,
  runtime: "node",
  workerId: `worker-${Math.random().toString(16).slice(2)}`,
  installedWheels: [],
};

function emit(event: WorkerEventEnvelope) {
  workerpool.workerEmit(event);
}

function emitTransfer(payload: unknown, transfer: Transferable[]) {
  workerpool.workerEmit(new workerpool.Transfer(payload as object, transfer));
}

function clearStreamWriter() {
  state.streamWriter = undefined;
  state.pendingStreamWrite = undefined;
}

function queueStreamChunk(chunk: StreamChunk) {
  if (!state.streamWriter) {
    return;
  }

  debug("stream_chunk", {
    endpoint: chunk.endpoint,
    requestId: chunk.requestId,
  });
  const previousWrite = state.pendingStreamWrite ?? Promise.resolve();
  state.pendingStreamWrite = previousWrite.then(async () => {
    await state.streamWriter?.write(chunk);
  });
}

async function closeStreamWriter() {
  if (!state.streamWriter) {
    return;
  }

  const streamWriter = state.streamWriter;
  try {
    await state.pendingStreamWrite;
    await streamWriter.close();
  } finally {
    clearStreamWriter();
  }
}

async function abortStreamWriter(error: unknown) {
  if (!state.streamWriter) {
    return;
  }

  const streamWriter = state.streamWriter;
  try {
    await state.pendingStreamWrite?.catch(() => undefined);
    await streamWriter.abort(error).catch(() => undefined);
  } finally {
    clearStreamWriter();
  }
}

function stringifyError(error: unknown) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function jsonParse(value: unknown): JsonValue {
  if (typeof value === "string") {
    return JSON.parse(value) as JsonValue;
  }
  return value as JsonValue;
}

function resolveAssetUrl(relativePath: string) {
  const baseUrl = __webpack_public_path__ || "./";
  const normalizedPath = relativePath.replace(/^\.\//, "");
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(baseUrl)) {
    return new URL(normalizedPath, baseUrl).toString();
  }
  if (baseUrl.startsWith("/")) {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(normalizedPath, `file://${base}`).toString();
  }
  return `${baseUrl}${normalizedPath}`;
}

async function readBytes(url: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    const fs = await import("node:fs/promises");
    const bytes = await fs.readFile(parsed);
    return new Uint8Array(bytes);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch asset ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function readText(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    const fs = await import("node:fs/promises");
    return fs.readFile(parsed, "utf8");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch asset ${url}`);
  }
  return response.text();
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadManifest(
  payload: WorkerInitializePayload,
): Promise<RuntimeManifest> {
  if (payload.manifest) {
    return payload.manifest;
  }

  const manifestUrl =
    payload.manifestUrl ?? resolveAssetUrl("./runtime-manifest.json");
  return JSON.parse(await readText(manifestUrl)) as RuntimeManifest;
}

async function importPyodide(manifest: RuntimeManifest) {
  type LoadPyodideModule = {
    loadPyodide: (options: {
      indexURL: string;
      lockFileURL: string;
      stdout?: (message: string) => void;
      stderr?: (message: string) => void;
    }) => Promise<PyodideInterface>;
  };

  if (state.runtime === "node") {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const modulePath = await normalizePyodideLoadPath(
      resolveAssetUrl(manifest.pyodide.modulePath.replace(/\.mjs$/, ".js")),
    );
    const loaded = require(modulePath) as LoadPyodideModule;
    const loadPyodide =
      loaded.loadPyodide ??
      (globalThis as { loadPyodide?: LoadPyodideModule["loadPyodide"] })
        .loadPyodide;
    if (!loadPyodide) {
      throw new Error("Pyodide CommonJS loader did not expose loadPyodide");
    }
    return {
      loadPyodide,
    };
  }
  const moduleUrl = resolveAssetUrl(manifest.pyodide.modulePath);
  const mod = (await import(
    /* webpackIgnore: true */ moduleUrl
  )) as LoadPyodideModule;
  return mod;
}

async function normalizePyodideLoadPath(url: string) {
  if (state.runtime !== "node" || !url.startsWith("file:")) {
    return url;
  }
  const { fileURLToPath } = await import("node:url");
  const normalized = fileURLToPath(url);
  return url.endsWith("/") && !normalized.endsWith("/")
    ? `${normalized}/`
    : normalized;
}

async function validateWheelCompatibility(manifest: RuntimeManifest) {
  const reportUrl = resolveAssetUrl(manifest.reports.compatibilityPath);
  const report = JSON.parse(await readText(reportUrl)) as {
    incompatible: Array<{ filename: string; reason: string }>;
  };
  if (report.incompatible.length > 0) {
    const reason = report.incompatible
      .map((entry) => `${entry.filename}: ${entry.reason}`)
      .join("; ");
    throw new Error(
      `LiteLLM wheel set is not Pyodide-compatible yet. Incompatible wheels: ${reason}`,
    );
  }
}

async function installWheel(
  pyodide: PyodideInterface,
  wheel: RuntimeManifestWheel,
) {
  const wheelUrl = resolveAssetUrl(`./wheels/${wheel.filename}`);
  const bytes = await readBytes(wheelUrl);
  const actualHash = await sha256(bytes);
  if (actualHash !== wheel.sha256) {
    throw new Error(`Hash mismatch for ${wheel.filename}`);
  }

  pyodide.FS.mkdirTree("/wheelhouse");
  const target = `/wheelhouse/${wheel.filename}`;
  pyodide.FS.writeFile(target, bytes);
  await pyodide.runPythonAsync(
    [
      "import sysconfig",
      "import zipfile",
      `wheel_path = ${JSON.stringify(target)}`,
      "site_packages = sysconfig.get_paths()['purelib']",
      "with zipfile.ZipFile(wheel_path) as wheel_file:",
      "    wheel_file.extractall(site_packages)",
    ].join("\n"),
  );
  state.installedWheels.push(wheel.filename);
}

async function loadBridge(
  pyodide: PyodideInterface,
  manifest: RuntimeManifest,
) {
  const bridgeUrl = resolveAssetUrl(manifest.python.bridgePath);
  const bridgeBytes = await readBytes(bridgeUrl);
  pyodide.FS.mkdirTree("/runtime_bridge");
  pyodide.FS.writeFile("/runtime_bridge/bridge.py", bridgeBytes);
  (
    globalThis as { __litellmDebug?: (message: string) => void }
  ).__litellmDebug = (message: string) => {
    bridgeDebug(message);
  };
  (globalThis as { __litellmEmit?: (payload: string) => void }).__litellmEmit =
    (payload: string) => {
      const parsed = jsonParse(payload);
      if (
        parsed &&
        typeof parsed === "object" &&
        "type" in parsed &&
        (parsed as { type: string }).type === "stream_chunk" &&
        state.streamWriter
      ) {
        const streamChunk = parsed as {
          requestId: string;
          endpoint: EndpointKind;
          chunk: JsonValue;
        };
        queueStreamChunk({
          requestId: streamChunk.requestId,
          endpoint: streamChunk.endpoint,
          chunk: streamChunk.chunk,
        });
        return;
      }
      emit({
        type:
          parsed && typeof parsed === "object" && "type" in parsed
            ? (String(
                (parsed as { type: string }).type,
              ) as WorkerEventEnvelope["type"])
            : "debug",
        workerId: state.workerId,
        payload: parsed,
      });
    };
  await pyodide.runPythonAsync(
    [
      "import sys",
      "sys.path.append('/runtime_bridge')",
      "import bridge",
      "await bridge.bootstrap()",
    ].join("\n"),
  );
}

async function initialize(
  payload: WorkerInitializePayload,
): Promise<HealthSnapshot> {
  if (state.initialized) {
    return health();
  }
  if (state.initializing) {
    return health();
  }

  state.initializing = true;
  state.runtime = payload.runtime;
  debug("initialize", { runtime: payload.runtime, workerId: state.workerId });
  emit({
    type: "worker:boot",
    workerId: state.workerId,
    payload: {
      runtime: payload.runtime,
      timestamp: new Date().toISOString(),
    },
  });

  try {
    state.manifest = await loadManifest(payload);
    await validateWheelCompatibility(state.manifest);
    const pyodideModule = await importPyodide(state.manifest);
    const pyodide = await pyodideModule.loadPyodide({
      indexURL: await normalizePyodideLoadPath(
        resolveAssetUrl(state.manifest.pyodide.indexURL),
      ),
      lockFileURL: await normalizePyodideLoadPath(
        resolveAssetUrl(state.manifest.pyodide.lockFilePath),
      ),
      stdout: () => undefined,
      stderr: () => undefined,
    });
    state.pyodide = pyodide;

    for (const wheel of state.manifest.wheels) {
      await installWheel(pyodide, wheel);
    }

    await loadBridge(pyodide, state.manifest);
    state.initialized = true;
    state.initializing = false;
    emit({
      type: "worker:ready",
      workerId: state.workerId,
      payload: {
        runtime: payload.runtime,
        timestamp: new Date().toISOString(),
        installedWheels: state.installedWheels,
      },
    });
    return health();
  } catch (error) {
    state.initializing = false;
    state.lastFatalError = stringifyError(error);
    emit({
      type: "worker:error",
      workerId: state.workerId,
      payload: {
        timestamp: new Date().toISOString(),
        error: state.lastFatalError,
      },
    });
    throw error;
  }
}

function endpointToPythonHandler(
  endpoint: WorkerInvokePayload["endpoint"],
  stream: boolean,
) {
  switch (endpoint) {
    case "chat_completions":
      return stream ? "chat_completions_stream" : "chat_completions_create";
    case "messages":
      return stream ? "messages_stream" : "messages_create";
    case "responses":
      return "responses_create";
    case "embeddings":
      return "embeddings_create";
  }
}

async function invoke(
  payload: WorkerInvokePayload,
): Promise<WorkerResultEnvelope> {
  if (!state.initialized || !state.pyodide) {
    throw new Error("Worker is not initialized");
  }

  const pyodide = state.pyodide;
  if (payload.stream) {
    debug("open_stream", {
      endpoint: payload.endpoint,
      requestId: payload.requestId,
    });
    const remoteStream = new RemoteWritableStream<StreamChunk>();
    state.streamWriter = remoteStream.writable.getWriter();
    state.pendingStreamWrite = Promise.resolve();
    emitTransfer(
      {
        type: "stream_open",
        requestId: payload.requestId,
        endpoint: payload.endpoint,
        payload: {
          requestId: payload.requestId,
          endpoint: payload.endpoint,
          readablePort: remoteStream.readablePort,
        } satisfies WorkerStreamOpenPayload,
      } satisfies WorkerEventEnvelope,
      [remoteStream.readablePort],
    );
  }
  try {
    debug("invoke", {
      endpoint: payload.endpoint,
      requestId: payload.requestId,
    });
    pyodide.globals.set("request_json", JSON.stringify(payload.requestPayload));
    pyodide.globals.set(
      "handler_name",
      endpointToPythonHandler(payload.endpoint, payload.stream),
    );
    const result = await pyodide.runPythonAsync(
      [
        "import json",
        "import bridge",
        "request = json.loads(request_json)",
        "handler = getattr(bridge, handler_name)",
        "result = await handler(request)",
        "result",
      ].join("\n"),
    );

    await closeStreamWriter();

    emit({
      type: "result_meta",
      requestId: payload.requestId,
      workerId: state.workerId,
      endpoint: payload.endpoint,
      payload: {
        requestId: payload.requestId,
        endpoint: payload.endpoint,
        result: jsonParse(result.toString()),
      },
    });

    return {
      requestId: payload.requestId,
      endpoint: payload.endpoint,
      result: jsonParse(result.toString()),
    };
  } catch (error) {
    await abortStreamWriter(error);
    emit({
      type: "failure_meta",
      requestId: payload.requestId,
      workerId: state.workerId,
      endpoint: payload.endpoint,
      payload: {
        requestId: payload.requestId,
        endpoint: payload.endpoint,
        error: stringifyError(error),
      },
    });
    throw error;
  }
}

async function health(): Promise<HealthSnapshot> {
  return {
    initialized: state.initialized,
    runtime: state.runtime,
    workerId: state.workerId,
    installedWheels: [...state.installedWheels],
    lastFatalError: state.lastFatalError,
  };
}

async function shutdown(): Promise<void> {
  debug("shutdown", { workerId: state.workerId });
  state.initialized = false;
  state.pyodide = undefined;
  emit({
    type: "worker:shutdown",
    workerId: state.workerId,
    payload: {
      runtime: state.runtime,
      timestamp: new Date().toISOString(),
    },
  });
}

workerpool.worker({
  initialize,
  invoke,
  health,
  shutdown,
});
