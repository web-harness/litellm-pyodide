import { CHAT_MODEL_ID, EMBEDDING_MODEL_ID } from "./demo-models";

export type ModelStartupState =
  | "not_cached"
  | "downloading"
  | "cached"
  | "loading"
  | "ready"
  | "failed";

export interface ModelStatus {
  modelId: string;
  label: string;
  cached: boolean;
  state: ModelStartupState;
  text: string;
  progress: number | null;
}

export function createInitialModelStatuses(): Record<string, ModelStatus> {
  return {
    [CHAT_MODEL_ID]: {
      modelId: CHAT_MODEL_ID,
      label: "Chat model",
      cached: false,
      state: "not_cached",
      text: "Cache state not checked yet.",
      progress: null,
    },
    [EMBEDDING_MODEL_ID]: {
      modelId: EMBEDDING_MODEL_ID,
      label: "Embedding model",
      cached: false,
      state: "not_cached",
      text: "Cache state not checked yet.",
      progress: null,
    },
  };
}

export function applyCacheState(
  statuses: Record<string, ModelStatus>,
  cacheState: Record<string, boolean>,
) {
  const next = structuredClone(statuses);

  for (const status of Object.values(next)) {
    const cached = Boolean(cacheState[status.modelId]);
    status.cached = cached;
    status.state = cached ? "cached" : "not_cached";
    status.text = cached
      ? "Cached in IndexedDB. Ready to reload without a fresh download."
      : "Not cached yet. The browser will download this model on first run.";
    status.progress = cached ? 1 : null;
  }

  return next;
}

function inferActiveModelId(
  text: string,
  statuses: Record<string, ModelStatus>,
) {
  if (text.includes(CHAT_MODEL_ID)) {
    return CHAT_MODEL_ID;
  }
  if (text.includes(EMBEDDING_MODEL_ID)) {
    return EMBEDDING_MODEL_ID;
  }

  const pending = Object.values(statuses).find(
    (status) => status.state !== "ready",
  );
  return pending?.modelId ?? CHAT_MODEL_ID;
}

export function applyInitProgress(
  statuses: Record<string, ModelStatus>,
  report: { text?: string; progress?: number },
) {
  const next = structuredClone(statuses);
  const text = report.text ?? "Loading model assets...";
  const activeModelId = inferActiveModelId(text, next);
  const active = next[activeModelId];
  const progress =
    typeof report.progress === "number" && Number.isFinite(report.progress)
      ? Math.max(0, Math.min(1, report.progress))
      : null;
  const downloading = /download|fetch/i.test(text);
  const loadingFromCache = /cache/i.test(text) && !downloading;

  if (active) {
    active.progress = progress;
    active.text = text;
    active.state =
      downloading || (!active.cached && !loadingFromCache)
        ? "downloading"
        : "loading";
  }

  if (progress === 1) {
    for (const status of Object.values(next)) {
      status.cached = true;
      status.state = "ready";
      status.progress = 1;
      if (!status.text || status.text === "Loading model assets...") {
        status.text = "Loaded and ready.";
      }
    }
  }

  return next;
}

export function markStartupReady(statuses: Record<string, ModelStatus>) {
  const next = structuredClone(statuses);
  for (const status of Object.values(next)) {
    status.cached = true;
    status.state = "ready";
    status.progress = 1;
    status.text = "Loaded and ready.";
  }
  return next;
}

export function markStartupFailed(
  statuses: Record<string, ModelStatus>,
  message: string,
) {
  const next = structuredClone(statuses);
  for (const status of Object.values(next)) {
    if (status.state !== "ready") {
      status.state = "failed";
      status.text = message;
    }
  }
  return next;
}

export function summarizeStartup(statuses: Record<string, ModelStatus>) {
  const values = Object.values(statuses);
  const downloading = values.filter((status) => status.state === "downloading");
  const loading = values.filter((status) => status.state === "loading");
  const ready = values.filter((status) => status.state === "ready");
  const failed = values.find((status) => status.state === "failed");

  if (failed) {
    return `Startup failed: ${failed.text}`;
  }
  if (downloading.length > 0) {
    const names = downloading.map((status) => status.label).join(" and ");
    return `The browser is still downloading ${names}.`;
  }
  if (loading.length > 0) {
    const names = loading.map((status) => status.label).join(" and ");
    return `The browser is reusing cached artifacts and loading ${names}.`;
  }
  if (ready.length === values.length) {
    return "Both models are ready. Cached artifacts will be reused on later visits in this browser profile.";
  }
  return "Checking cache state and preparing local models.";
}
