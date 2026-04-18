import type { InitProgressReport } from "@mlc-ai/web-llm";
import { CreateServiceWorkerMLCEngine, hasModelInCache } from "@mlc-ai/web-llm";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CallbackEventPayload, StreamChunk } from "../../src/index";
import { DEMO_WEBLLM_APP_CONFIG, getDemoApiBase } from "./demo-config";
import {
  CHAT_MODEL_ID,
  EMBEDDING_MODEL_ID,
  getChatModelLabel,
  getEmbeddingModelLabel,
} from "./demo-models";
import {
  type LiteLLMPyodideRuntime,
  loadLiteLLMPyodideRuntime,
} from "./runtime-loader";
import {
  applyCacheState,
  applyInitProgress,
  createInitialModelStatuses,
  type ModelStatus,
  markStartupFailed,
  markStartupReady,
  summarizeStartup,
} from "./startup-status";
import bundledServiceWorkerUrl from "./sw.ts?worker&url";

type DemoClient = ReturnType<LiteLLMPyodideRuntime["createClient"]>;
type PromptPanelMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const minComputeWorkgroupStorageSize = 32_768;

type DemoPhase =
  | "idle"
  | "registering"
  | "checking_cache"
  | "loading_models"
  | "ready"
  | "failed";

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function readStream(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return chunks;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function pushLog(setter: Dispatch<SetStateAction<string[]>>, message: string) {
  setter((current) =>
    [`${new Date().toLocaleTimeString()}  ${message}`, ...current].slice(
      0,
      120,
    ),
  );
}

function getEventEndpoint(
  payload: CallbackEventPayload | StreamChunk | unknown,
) {
  if (payload && typeof payload === "object" && "endpoint" in payload) {
    return String(payload.endpoint);
  }

  return "unknown";
}

function normalizeAssistantContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (entry && typeof entry === "object" && "text" in entry) {
          return String(entry.text ?? "");
        }

        return JSON.stringify(entry);
      })
      .join("\n")
      .trim();
  }

  if (value && typeof value === "object" && "text" in value) {
    return String(value.text ?? "");
  }

  return String(value ?? "").trim();
}

function extractAssistantReply(value: unknown): string {
  if (!value || typeof value !== "object" || !("choices" in value)) {
    return "No assistant content returned.";
  }

  const { choices } = value;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "No assistant content returned.";
  }

  const firstChoice = choices[0];
  if (
    !firstChoice ||
    typeof firstChoice !== "object" ||
    !("message" in firstChoice)
  ) {
    return "No assistant content returned.";
  }

  const { message } = firstChoice;
  if (!message || typeof message !== "object" || !("content" in message)) {
    return "No assistant content returned.";
  }

  return (
    normalizeAssistantContent(message.content) ||
    "No assistant content returned."
  );
}

function createPromptMessage(
  role: PromptPanelMessage["role"],
  content: string,
): PromptPanelMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
  };
}

function bindClientEvents(
  client: DemoClient,
  setLogs: Dispatch<SetStateAction<string[]>>,
) {
  client.events.on("worker:boot", () =>
    pushLog(setLogs, "Runtime worker booted."),
  );
  client.events.on("worker:ready", () =>
    pushLog(setLogs, "Runtime worker ready."),
  );
  client.events.on("callback:pre_api_call", (payload) =>
    pushLog(setLogs, `Callback pre_api_call for ${getEventEndpoint(payload)}`),
  );
  client.events.on("callback:success", (payload) =>
    pushLog(setLogs, `Callback success for ${getEventEndpoint(payload)}`),
  );
  client.events.on("request:stream_chunk", (payload) =>
    pushLog(setLogs, `Stream chunk for ${getEventEndpoint(payload)}`),
  );
  client.events.on("request:completed", (payload) =>
    pushLog(setLogs, `Completed ${getEventEndpoint(payload)}`),
  );
}

export function App() {
  void bundledServiceWorkerUrl;
  const serviceWorkerReloadKey = "litellm-pyodide-sw-reload";
  const baseUrl = useMemo(
    () => new URL(import.meta.env.BASE_URL, window.location.href).toString(),
    [],
  );
  const openAiBase = useMemo(
    () => getDemoApiBase(baseUrl, "openai"),
    [baseUrl],
  );
  const anthropicBase = useMemo(
    () => getDemoApiBase(baseUrl, "anthropic"),
    [baseUrl],
  );
  const [phase, setPhase] = useState<DemoPhase>("idle");
  const [serviceWorkerStatus, setServiceWorkerStatus] = useState(
    "Not registered yet.",
  );
  const [runtimeStatus, setRuntimeStatus] = useState(
    "Runtime module not loaded yet.",
  );
  const [webgpuStatus, setWebgpuStatus] = useState(
    "Checking WebGPU support...",
  );
  const [proxyBase, setProxyBase] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [healthText, setHealthText] = useState("No health snapshot yet.");
  const [chatText, setChatText] = useState("No chat result yet.");
  const [responsesText, setResponsesText] = useState(
    "No responses result yet.",
  );
  const [messagesText, setMessagesText] = useState("No messages result yet.");
  const [embeddingsText, setEmbeddingsText] = useState(
    "No embeddings result yet.",
  );
  const [promptInput, setPromptInput] = useState(
    "Summarize what this demo is proving in two sentences.",
  );
  const [promptMessages, setPromptMessages] = useState<PromptPanelMessage[]>(
    [],
  );
  const [promptPending, setPromptPending] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>(
    createInitialModelStatuses(),
  );
  const runtimeRef = useRef<LiteLLMPyodideRuntime | null>(null);
  const clientRef = useRef<DemoClient | null>(null);
  const activeProxyRef = useRef<string | undefined>(undefined);

  const startupSummary = summarizeStartup(statuses);
  const ready = phase === "ready";
  const normalizedProxyBase = proxyBase.trim();

  useEffect(() => {
    let cancelled = false;

    async function detectRuntimeMode() {
      const navigatorWithGpu = navigator as Navigator & {
        gpu?: {
          requestAdapter?: () => Promise<{
            limits?: {
              maxComputeWorkgroupStorageSize?: number;
            };
          } | null>;
        };
      };

      if (!navigatorWithGpu.gpu?.requestAdapter) {
        return {
          supported: false,
          webgpuMessage:
            "WebGPU is unavailable in this browser. This demo requires Chrome-class WebGPU support for live local inference.",
          failureReason: "WebGPU is unavailable in this browser.",
        };
      }

      try {
        const adapter = await navigatorWithGpu.gpu.requestAdapter();
        if (!adapter) {
          return {
            supported: false,
            webgpuMessage:
              "No WebGPU adapter is available. This demo requires Chrome-class WebGPU support for live local inference.",
            failureReason: "No WebGPU adapter is available.",
          };
        }

        const workgroupStorageLimit =
          adapter.limits?.maxComputeWorkgroupStorageSize;
        if (
          typeof workgroupStorageLimit === "number" &&
          workgroupStorageLimit < minComputeWorkgroupStorageSize
        ) {
          return {
            supported: false,
            webgpuMessage: `This browser exposes maxComputeWorkgroupStorageSize=${workgroupStorageLimit}, below the ${minComputeWorkgroupStorageSize} required by the fixed WebLLM models. Use Chrome for live local inference.`,
            failureReason: `Insufficient WebGPU workgroup storage limit (${workgroupStorageLimit}).`,
          };
        }

        return {
          supported: true,
          webgpuMessage: "WebGPU API detected in the browser.",
          failureReason: undefined,
        };
      } catch (error) {
        return {
          supported: false,
          webgpuMessage:
            "WebGPU adapter initialization failed in this browser. This demo requires Chrome-class WebGPU support for live local inference.",
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    async function waitForServiceWorkerController(timeoutMs: number) {
      if (navigator.serviceWorker.controller) {
        return;
      }

      await new Promise<void>((resolve) => {
        const handleControllerChange = () => {
          window.clearTimeout(timeoutId);
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            handleControllerChange,
          );
          resolve();
        };

        const timeoutId = window.setTimeout(() => {
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            handleControllerChange,
          );
          resolve();
        }, timeoutMs);

        navigator.serviceWorker.addEventListener(
          "controllerchange",
          handleControllerChange,
        );
      });
    }

    async function registerServiceWorker() {
      setPhase("registering");
      setServiceWorkerStatus("Registering module service worker...");
      const registration = await navigator.serviceWorker.register(
        new URL(`${import.meta.env.BASE_URL}sw.js`, window.location.href),
        {
          type: "module",
        },
      );
      await navigator.serviceWorker.ready;
      await waitForServiceWorkerController(3000);

      if (!navigator.serviceWorker.controller) {
        if (!window.sessionStorage.getItem(serviceWorkerReloadKey)) {
          window.sessionStorage.setItem(serviceWorkerReloadKey, "1");
          window.location.reload();
          await new Promise(() => undefined);
        }

        throw new Error(
          "Service worker activated but did not take control of the page.",
        );
      }

      window.sessionStorage.removeItem(serviceWorkerReloadKey);

      if (cancelled) {
        return;
      }
      void registration;
      setServiceWorkerStatus("Service worker active and controlling the page.");
      pushLog(setLogs, "Service worker registered.");
    }

    async function ensureRuntimeLoaded() {
      const runtime = await loadLiteLLMPyodideRuntime();
      runtimeRef.current = runtime;
      if (!cancelled) {
        setRuntimeStatus(
          "Built litellm-pyodide runtime loaded from copied dist assets.",
        );
        pushLog(setLogs, "Loaded copied litellm-pyodide runtime.");
      }
      return runtime;
    }

    async function ensureClient(runtime: LiteLLMPyodideRuntime) {
      const nextProxy = normalizedProxyBase || undefined;
      if (clientRef.current && activeProxyRef.current === nextProxy) {
        return clientRef.current;
      }

      if (clientRef.current) {
        await clientRef.current.close();
      }

      const client = runtime.createClient({
        maxWorkers: 1,
        warmup: false,
        corsBusterUrl: nextProxy,
      });
      activeProxyRef.current = nextProxy;
      clientRef.current = client;
      bindClientEvents(client, setLogs);

      return client;
    }

    async function bootstrapReal(runtime: LiteLLMPyodideRuntime) {
      setPhase("checking_cache");
      pushLog(setLogs, "Checking model cache state.");

      const cacheState = {
        [CHAT_MODEL_ID]: await hasModelInCache(
          CHAT_MODEL_ID,
          DEMO_WEBLLM_APP_CONFIG,
        ),
        [EMBEDDING_MODEL_ID]: await hasModelInCache(
          EMBEDDING_MODEL_ID,
          DEMO_WEBLLM_APP_CONFIG,
        ),
      };
      pushLog(setLogs, `Cache state resolved: ${formatJson(cacheState)}`);
      setStatuses((current) => applyCacheState(current, cacheState));
      setPhase("loading_models");
      pushLog(setLogs, "Creating WebLLM service-worker engine.");

      const engine = await CreateServiceWorkerMLCEngine(
        [CHAT_MODEL_ID, EMBEDDING_MODEL_ID],
        {
          appConfig: DEMO_WEBLLM_APP_CONFIG,
          initProgressCallback: (report: InitProgressReport) => {
            if (cancelled) {
              return;
            }
            setStatuses((current) => applyInitProgress(current, report));
          },
        },
      );
      void engine;
      setStatuses((current) => markStartupReady(current));
      await ensureClient(runtime);
      if (!cancelled) {
        setPhase("ready");
        pushLog(
          setLogs,
          "WebLLM service-worker engine loaded both fixed models.",
        );
      }
    }

    async function boot() {
      try {
        const runtimeMode = await detectRuntimeMode();
        if (cancelled) {
          return;
        }

        setWebgpuStatus(runtimeMode.webgpuMessage);
        if (!runtimeMode.supported) {
          setPhase("failed");
          setServiceWorkerStatus(
            "Skipped because the browser does not support the required WebGPU features.",
          );
          setRuntimeStatus(
            "Runtime was not started because the browser cannot run the fixed local models.",
          );
          setStatuses((current) =>
            markStartupFailed(
              current,
              runtimeMode.failureReason ?? runtimeMode.webgpuMessage,
            ),
          );
          pushLog(
            setLogs,
            `Startup blocked: ${runtimeMode.failureReason ?? runtimeMode.webgpuMessage}`,
          );
          return;
        }

        await registerServiceWorker();
        const runtime = await ensureRuntimeLoaded();
        await bootstrapReal(runtime);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setPhase("failed");
        setStatuses((current) =>
          markStartupFailed(
            current,
            error instanceof Error ? error.message : String(error),
          ),
        );
        pushLog(
          setLogs,
          `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    void boot();

    return () => {
      cancelled = true;
      void clientRef.current?.close();
    };
  }, [normalizedProxyBase]);

  async function withClient<T>(
    action: (runtime: LiteLLMPyodideRuntime, client: DemoClient) => Promise<T>,
  ) {
    const runtime = runtimeRef.current;
    if (!runtime) {
      throw new Error("Runtime module has not loaded yet.");
    }

    const nextProxy = normalizedProxyBase || undefined;
    if (!clientRef.current || activeProxyRef.current !== nextProxy) {
      if (clientRef.current) {
        await clientRef.current.close();
      }
      activeProxyRef.current = undefined;
      const client = runtime.createClient({
        maxWorkers: 1,
        warmup: false,
        corsBusterUrl: nextProxy,
      });
      activeProxyRef.current = nextProxy;
      clientRef.current = client;
      bindClientEvents(client, setLogs);
    }

    return action(runtime, clientRef.current);
  }

  async function runWarmup() {
    const health = await withClient(async (_runtime, client) =>
      client.warmup(),
    );
    setHealthText(formatJson(health));
  }

  async function runHealth() {
    const health = await withClient(async (_runtime, client) =>
      client.health(),
    );
    setHealthText(formatJson(health));
  }

  async function runChat(stream: boolean) {
    const result = await withClient(async (_runtime, client) => {
      const response = await client.chatCompletions.create({
        model: CHAT_MODEL_ID,
        api_base: openAiBase,
        messages: [
          {
            role: "user",
            content: "Describe what this demo proves in two lines.",
          },
        ],
        temperature: 0.2,
        stream,
      });
      return stream
        ? readStream(response as ReadableStream<unknown>)
        : response;
    });
    setChatText(formatJson(result));
  }

  async function runResponses(stream: boolean) {
    const result = await withClient(async (_runtime, client) => {
      const response = await client.responses.create({
        model: CHAT_MODEL_ID,
        api_base: openAiBase,
        input: [
          {
            role: "user",
            content: "Stream or return a short repository summary.",
          },
        ],
        stream,
      });
      return stream
        ? readStream(response as ReadableStream<unknown>)
        : response;
    });
    setResponsesText(formatJson(result));
  }

  async function runMessages(stream: boolean) {
    const result = await withClient(async (_runtime, client) => {
      const response = await client.messages.create({
        model: CHAT_MODEL_ID,
        api_base: anthropicBase,
        messages: [
          {
            role: "user",
            content: "Return one terse line about the transport path.",
          },
        ],
        system: "Be terse and literal.",
        max_tokens: 64,
        stream,
      });
      return stream
        ? readStream(response as ReadableStream<unknown>)
        : response;
    });
    setMessagesText(formatJson(result));
  }

  async function runEmbeddings() {
    const result = await withClient(async (_runtime, client) =>
      client.embeddings.create({
        model: EMBEDDING_MODEL_ID,
        api_base: openAiBase,
        input: [
          "litellm-pyodide uses Pyodide workers",
          "WebLLM runs local inference in the browser",
        ],
      }),
    );
    setEmbeddingsText(formatJson(result));
  }

  async function sendPrompt() {
    const nextPrompt = promptInput.trim();
    if (!nextPrompt || promptPending) {
      return;
    }

    const nextMessages: PromptPanelMessage[] = [
      ...promptMessages,
      createPromptMessage("user", nextPrompt),
    ];

    setPromptPending(true);
    setPromptError(null);
    setPromptMessages(nextMessages);
    setPromptInput("");

    try {
      const response = await withClient(async (_runtime, client) =>
        client.chatCompletions.create({
          model: CHAT_MODEL_ID,
          api_base: openAiBase,
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          temperature: 0.2,
          stream: false,
        }),
      );

      setPromptMessages([
        ...nextMessages,
        createPromptMessage("assistant", extractAssistantReply(response)),
      ]);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : String(error));
      setPromptInput(nextPrompt);
    } finally {
      setPromptPending(false);
    }
  }

  function clearPromptPanel() {
    setPromptMessages([]);
    setPromptError(null);
  }

  async function reinitializeModels() {
    clearPromptPanel();
    setStatuses(createInitialModelStatuses());
    setPhase("idle");
    if (clientRef.current) {
      await clientRef.current.close();
      clientRef.current = null;
      activeProxyRef.current = undefined;
    }
    window.location.reload();
  }

  const proxyExample = proxyBase.trim()
    ? `${proxyBase.endsWith("/") ? proxyBase : `${proxyBase}/`}https://api.openai.com/v1/chat/completions`
    : "Set a proxy base to preview a rewritten cross-origin URL.";

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">GitHub Pages React Demo</p>
        <h1>
          litellm-pyodide through real HTTP, local WebLLM, and fixed
          browser-cached models.
        </h1>
        <p className="hero-copy">
          This app consumes the built package artifact from copied dist assets,
          keeps one WebLLM service-worker engine alive for both fixed models,
          and exposes same-origin provider-style routes for chat completions,
          responses, messages, and embeddings.
        </p>
        <div className="hero-models">
          <span>{getChatModelLabel()}</span>
          <span>{getEmbeddingModelLabel()}</span>
        </div>
      </section>

      <section className="status-grid">
        <article className="panel">
          <h2>Environment Status</h2>
          <dl className="status-list">
            <div>
              <dt>Phase</dt>
              <dd>{phase}</dd>
            </div>
            <div>
              <dt>Service Worker</dt>
              <dd>{serviceWorkerStatus}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{runtimeStatus}</dd>
            </div>
            <div>
              <dt>WebGPU</dt>
              <dd>{webgpuStatus}</dd>
            </div>
            <div>
              <dt>Cache Policy</dt>
              <dd>
                IndexedDB-backed WebLLM app config with the two fixed model
                records.
              </dd>
            </div>
          </dl>
        </article>

        <article className="panel startup-panel">
          <h2>Startup Status</h2>
          <p className="startup-summary" data-testid="startup-summary">
            {startupSummary}
          </p>
          <div className="button-row startup-actions">
            <button type="button" onClick={reinitializeModels}>
              Reinitialize local models
            </button>
          </div>
          <div className="model-status-grid">
            {Object.values(statuses).map((status) => (
              <div
                key={status.modelId}
                className={`model-status state-${status.state}`}
              >
                <strong>{status.label}</strong>
                <span className="model-id">{status.modelId}</span>
                <span className="state-chip">{status.state}</span>
                <span>{status.text}</span>
                <span>
                  {typeof status.progress === "number"
                    ? `${Math.round(status.progress * 100)}%`
                    : "No numeric progress yet."}
                </span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="panel-grid">
        <article className="panel">
          <h2>Runtime Controls</h2>
          <div className="button-row">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runWarmup()}
            >
              Warmup
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runHealth()}
            >
              Health
            </button>
            <button type="button" onClick={() => setLogs([])}>
              Clear logs
            </button>
          </div>
          <pre data-testid="health-output">{healthText}</pre>
        </article>

        <article className="panel">
          <h2>Chat Completions</h2>
          <div className="button-row">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runChat(false)}
            >
              Run non-stream
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runChat(true)}
            >
              Run stream
            </button>
          </div>
          <pre data-testid="chat-output">{chatText}</pre>
        </article>

        <article className="panel">
          <h2>Responses</h2>
          <div className="button-row">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runResponses(false)}
            >
              Run non-stream
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runResponses(true)}
            >
              Run stream
            </button>
          </div>
          <pre data-testid="responses-output">{responsesText}</pre>
        </article>

        <article className="panel">
          <h2>Messages</h2>
          <div className="button-row">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runMessages(false)}
            >
              Run non-stream
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runMessages(true)}
            >
              Run stream
            </button>
          </div>
          <pre data-testid="messages-output">{messagesText}</pre>
        </article>

        <article className="panel">
          <h2>Embeddings</h2>
          <div className="button-row">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void runEmbeddings()}
            >
              Run embeddings
            </button>
          </div>
          <pre data-testid="embeddings-output">{embeddingsText}</pre>
        </article>

        <article className="panel">
          <h2>Transport</h2>
          <dl className="status-list compact">
            <div>
              <dt>OpenAI-style api_base</dt>
              <dd>{openAiBase}</dd>
            </div>
            <div>
              <dt>Anthropic-style api_base</dt>
              <dd>{anthropicBase}</dd>
            </div>
            <div>
              <dt>Local routes</dt>
              <dd>
                {openAiBase}/v1/chat/completions
                <br />
                {openAiBase}/v1/responses
                <br />
                {anthropicBase}/v1/messages
                <br />
                {openAiBase}/v1/embeddings
              </dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>Proxy Panel</h2>
          <label className="field-label" htmlFor="proxy-base">
            Optional CORS Buster URL
          </label>
          <input
            id="proxy-base"
            value={proxyBase}
            onChange={(event) => setProxyBase(event.target.value)}
            placeholder="https://cors-anywhere.example/"
          />
          <p className="helper-copy">
            The local WebLLM routes above are same-origin and must bypass this
            proxy. This field exists to demonstrate how cross-origin targets
            would be rewritten.
          </p>
          <pre>{proxyExample}</pre>
        </article>

        <article className="panel prompt-panel">
          <h2>Prompt Panel</h2>
          <div className="button-row">
            <button
              type="button"
              disabled={!ready || promptPending || !promptInput.trim()}
              onClick={() => void sendPrompt()}
            >
              {promptPending ? "Sending..." : "Send prompt"}
            </button>
            <button
              type="button"
              disabled={promptPending || promptMessages.length === 0}
              onClick={clearPromptPanel}
            >
              Clear chat
            </button>
          </div>
          <label className="field-label" htmlFor="prompt-input">
            Prompt composer
          </label>
          <textarea
            id="prompt-input"
            value={promptInput}
            onChange={(event) => setPromptInput(event.target.value)}
            placeholder="Ask the model something direct."
            rows={4}
          />
          <div className="chat-transcript" data-testid="prompt-thread">
            {promptMessages.length > 0 ? (
              promptMessages.map((message) => (
                <div
                  key={message.id}
                  className={`chat-bubble role-${message.role}`}
                >
                  <strong>
                    {message.role === "user" ? "You" : "Assistant"}
                  </strong>
                  <span>{message.content}</span>
                </div>
              ))
            ) : (
              <p className="chat-empty">
                Send a prompt here to get a regular chat reply from the active
                model route.
              </p>
            )}
          </div>
          {promptError ? (
            <p className="error-copy" data-testid="prompt-error">
              {promptError}
            </p>
          ) : null}
        </article>

        <article className="panel log-panel">
          <h2>Event Log</h2>
          <pre>
            {logs.length > 0 ? logs.join("\n") : "No runtime events yet."}
          </pre>
        </article>
      </section>
    </main>
  );
}
