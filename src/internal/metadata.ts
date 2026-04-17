import type { EndpointKind, JsonValue } from "../types";

const REQUEST_ID_KEY = "litellm_pyodide_request_id";
const ENDPOINT_KEY = "litellm_pyodide_endpoint";
const STREAM_KEY = "litellm_pyodide_stream";

export function mergeMetadata(
  metadata: Record<string, JsonValue> | undefined,
  requestId: string,
  endpoint: EndpointKind,
  stream: boolean,
): Record<string, JsonValue> {
  return {
    ...(metadata ?? {}),
    [REQUEST_ID_KEY]: requestId,
    [ENDPOINT_KEY]: endpoint,
    [STREAM_KEY]: stream,
  };
}

export const internalMetadataKeys = {
  endpoint: ENDPOINT_KEY,
  requestId: REQUEST_ID_KEY,
  stream: STREAM_KEY,
} as const;
