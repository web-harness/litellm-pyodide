export const CHAT_MODEL_ID = "SmolLM2-360M-Instruct-q4f16_1-MLC";
export const EMBEDDING_MODEL_ID = "snowflake-arctic-embed-m-q0f32-MLC-b4";

export function getChatModelLabel() {
  return `Chat: ${CHAT_MODEL_ID}`;
}

export function getEmbeddingModelLabel() {
  return `Embeddings: ${EMBEDDING_MODEL_ID}`;
}
