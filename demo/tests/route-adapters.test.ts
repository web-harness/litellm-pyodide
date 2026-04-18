import { describe, expect, test } from "vitest";
import {
  createMockDemoEngineAdapter,
  handleDemoRoute,
  matchDemoRoute,
} from "../src/route-adapters";

describe("demo route adapters", () => {
  test("maps chat completions to a JSON response", async () => {
    const adapter = createMockDemoEngineAdapter();
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
    expect(payload.choices[0].message.content).toContain("Mock reply");
  });

  test("maps responses streaming calls to response events", async () => {
    const adapter = createMockDemoEngineAdapter();
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
    const adapter = createMockDemoEngineAdapter();
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
    const adapter = createMockDemoEngineAdapter();
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
