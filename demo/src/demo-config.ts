import type { AppConfig, ModelRecord } from "@mlc-ai/web-llm";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { CHAT_MODEL_ID, EMBEDDING_MODEL_ID } from "./demo-models";

function requireModelRecord(modelId: string): ModelRecord {
  const record = prebuiltAppConfig.model_list.find(
    (entry) => entry.model_id === modelId,
  );

  if (!record) {
    throw new Error(`Missing WebLLM model record for ${modelId}`);
  }

  return {
    ...record,
    overrides: record.overrides ? { ...record.overrides } : undefined,
    required_features: record.required_features
      ? [...record.required_features]
      : undefined,
    tokenizer_files: record.tokenizer_files
      ? [...record.tokenizer_files]
      : undefined,
  };
}

export const CHAT_MODEL_RECORD = requireModelRecord(CHAT_MODEL_ID);
export const EMBEDDING_MODEL_RECORD = requireModelRecord(EMBEDDING_MODEL_ID);

export const DEMO_WEBLLM_APP_CONFIG: AppConfig = {
  cacheBackend: "indexeddb",
  model_list: [CHAT_MODEL_RECORD, EMBEDDING_MODEL_RECORD],
};

export type DemoApiKind = "openai" | "anthropic";

export function getDemoApiBase(baseUrl: string, kind: DemoApiKind) {
  const routeBase = kind === "anthropic" ? "demo-anthropic/" : "demo-openai/";
  return new URL(routeBase, baseUrl).toString().replace(/\/$/, "");
}
