import { describe, expect, it } from "vitest";

import { mergeMetadata } from "../src/internal/metadata";

describe("mergeMetadata", () => {
  it("preserves user metadata and injects internal tracing fields", () => {
    const result = mergeMetadata(
      { user: "value" },
      "req-1",
      "chat_completions",
      true,
    );
    expect(result).toMatchObject({
      user: "value",
      litellm_pyodide_request_id: "req-1",
      litellm_pyodide_endpoint: "chat_completions",
      litellm_pyodide_stream: true,
    });
  });
});
