import { describe, expect, test } from "vitest";
import {
  type DemoEngineAdapter,
  handleDemoRoute,
  matchDemoRoute,
} from "../src/route-adapters";

function createTestAdapter(): DemoEngineAdapter {
  return {
    async chatCompletionsCreate(request) {
      if (!request.stream) {
        return {
          id: "chatcmpl_test",
          object: "chat.completion",
          model: "SmolLM2-360M-Instruct-q4f16_1-MLC",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Test adapter reply",
              },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
          },
        };
      }

      return (async function* () {
        yield {
          id: "chatcmpl_chunk_1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "stream" } }],
        };
        yield {
          id: "chatcmpl_chunk_2",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "ed" } }],
        };
      })();
    },
    async embeddingsCreate(request) {
      const values = Array.isArray(request.input)
        ? request.input
        : [request.input];
      return {
        object: "list",
        model: "snowflake-arctic-embed-m-q0f32-MLC-b4",
        data: values.map((_, index) => ({
          object: "embedding",
          index,
          embedding: [index + 0.1, index + 0.2, index + 0.3],
        })),
        usage: {
          prompt_tokens: values.length,
          total_tokens: values.length,
        },
      };
    },
  };
}

describe("demo route adapters", () => {
  test("maps chat completions to a JSON response", async () => {
    const adapter = createTestAdapter();
    const request = new Request(
      "https://example.test/demo-openai/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "ignored",
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const route = matchDemoRoute(new URL(request.url));
    const response = await handleDemoRoute(adapter, route, request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.model).toContain("SmolLM2");
    expect(payload.choices[0].message.content).toContain("Test adapter reply");
  });

  test("maps responses streaming calls to response events", async () => {
    const adapter = createTestAdapter();
    const request = new Request(
      "https://example.test/demo-openai/v1/responses",
      {
        method: "POST",
        body: JSON.stringify({
          input: [{ role: "user", content: "stream" }],
          stream: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const route = matchDemoRoute(new URL(request.url));
    const response = await handleDemoRoute(adapter, route, request);
    const text = await response.text();

    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
  });

  test("maps anthropic streaming calls to message stop events", async () => {
    const adapter = createTestAdapter();
    const request = new Request(
      "https://example.test/demo-anthropic/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "stream" }],
          max_tokens: 32,
          stream: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const route = matchDemoRoute(new URL(request.url));
    const response = await handleDemoRoute(adapter, route, request);
    const text = await response.text();

    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
  });

  test("maps embeddings calls to the fixed embedding model", async () => {
    const adapter = createTestAdapter();
    const request = new Request(
      "https://example.test/demo-openai/v1/embeddings",
      {
        method: "POST",
        body: JSON.stringify({
          input: ["alpha", "beta"],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const route = matchDemoRoute(new URL(request.url));
    const response = await handleDemoRoute(adapter, route, request);
    const payload = await response.json();

    expect(payload.model).toContain("snowflake-arctic");
    expect(payload.data).toHaveLength(2);
  });
});
