import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServer, createMockProviderServer } from "./helpers/mock-provider";

type ClientModule = typeof import("../src/index");

describe.sequential("built runtime integration", () => {
  let baseUrl = "";
  let clientModule: ClientModule;
  let serverHandle: ReturnType<typeof createMockProviderServer>;

  beforeAll(async () => {
    serverHandle = createMockProviderServer();
    await new Promise<void>((resolve) => {
      serverHandle.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = serverHandle.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const distModuleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "index.mjs"),
    ).href;
    clientModule = (await import(
      /* @vite-ignore */ distModuleUrl
    )) as ClientModule;
  }, 60_000);

  afterAll(async () => {
    await closeServer(serverHandle.server);
  });

  it("supports non-stream create calls across chat, messages, responses, and embeddings", async () => {
    const client = clientModule.createClient({ maxWorkers: 1, warmup: false });

    try {
      const chat = await client.chatCompletions.create({
        model: "openai/test-chat",
        api_base: baseUrl,
        api_key: "secret-chat-key",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
      });

      const messages = await client.messages.create({
        model: "anthropic/test-messages",
        api_base: baseUrl,
        api_key: "secret-messages-key",
        messages: [{ role: "user", content: "hi" }],
        system: "be terse",
        max_tokens: 128,
        stop_sequences: ["stop"],
        thinking: { type: "enabled", budget_tokens: 32 },
        tool_choice: { type: "auto" },
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
      });

      const responses = await client.responses.create({
        model: "openai/test-responses",
        api_base: baseUrl,
        api_key: "secret-responses-key",
        input: [{ role: "user", content: "hi" }],
        previous_response_id: "resp_prev",
        tools: [{ type: "function", name: "search" }],
        tool_choice: { type: "auto" },
        truncation: "auto",
        context_management: { type: "retain" },
      });

      const embeddings = await client.embeddings.create({
        model: "openai/test-embeddings",
        api_base: baseUrl,
        api_key: "secret-embeddings-key",
        input: "embed me",
        dimensions: 3,
        encoding_format: "float",
      });

      expect(chat).toMatchObject({
        object: "chat.completion",
        choices: [{ message: { content: "chat-ok" } }],
      });
      expect(messages).toMatchObject({
        type: "message",
        content: [{ text: "message-ok" }],
      });
      expect(responses).toMatchObject({
        object: "response",
        output_text: "response-ok",
      });
      expect(embeddings).toMatchObject({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      });

      expect(
        serverHandle.lastRequest("/v1/chat/completions")?.body,
      ).toMatchObject({
        temperature: 0.2,
      });
      expect(serverHandle.lastRequest("/v1/messages")?.body).toMatchObject({
        max_tokens: 128,
        stop_sequences: ["stop"],
        system: "be terse",
        thinking: { type: "enabled", budget_tokens: 32 },
        tool_choice: { type: "auto" },
      });
      expect(serverHandle.lastRequest("/v1/responses")?.body).toMatchObject({
        previous_response_id: "resp_prev",
        truncation: "auto",
        context_management: { type: "retain" },
      });
      expect(serverHandle.lastRequest("/v1/embeddings")?.body).toMatchObject({
        dimensions: 3,
        encoding_format: "float",
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("streams chat, messages, and responses in order and emits completion metadata", async () => {
    const client = clientModule.createClient({ maxWorkers: 1, warmup: false });
    const completed: Array<Record<string, unknown>> = [];
    const streamEvents: Array<Record<string, unknown>> = [];
    client.events.on("request:completed", (payload: unknown) =>
      completed.push(payload as Record<string, unknown>),
    );
    client.events.on("request:stream_chunk", (payload: unknown) =>
      streamEvents.push(payload as Record<string, unknown>),
    );

    try {
      await client.warmup();
      const startedAt = Date.now();
      const chatStream = await client.chatCompletions.create({
        model: "openai/test-chat-stream",
        api_base: baseUrl,
        api_key: "secret-chat-stream",
        messages: [{ role: "user", content: "stream" }],
        stream: true,
      });
      const chatReader = (chatStream as ReadableStream<unknown>).getReader();
      const firstChatChunk = await chatReader.read();
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(firstChatChunk.done).toBe(false);
      const chatChunks: unknown[] = [firstChatChunk.value];
      for (;;) {
        const next = await chatReader.read();
        if (next.done) {
          break;
        }
        chatChunks.push(next.value);
      }
      expect(chatChunks).toMatchObject([
        { chunk: { delta: { content: "hello" } } },
        { chunk: { delta: { content: " world" } } },
      ]);

      const messagesStream = await client.messages.create({
        model: "anthropic/test-messages-stream",
        api_base: baseUrl,
        api_key: "secret-messages-stream",
        messages: [{ role: "user", content: "stream" }],
        max_tokens: 64,
        stream: true,
      });
      const messageChunks: unknown[] = [];
      const messageReader = (
        messagesStream as ReadableStream<unknown>
      ).getReader();
      for (;;) {
        const next = await messageReader.read();
        if (next.done) {
          break;
        }
        messageChunks.push(next.value);
      }
      expect(messageChunks).toMatchObject([
        { chunk: { type: "message_start" } },
        { chunk: { type: "content_block_delta" } },
      ]);

      const responsesStream = await client.responses.create({
        model: "openai/test-responses-stream",
        api_base: baseUrl,
        api_key: "secret-responses-stream",
        input: [{ role: "user", content: "stream" }],
        stream: true,
      });
      const responseChunks: unknown[] = [];
      const responseReader = (
        responsesStream as ReadableStream<unknown>
      ).getReader();
      for (;;) {
        const next = await responseReader.read();
        if (next.done) {
          break;
        }
        responseChunks.push(next.value);
      }
      expect(responseChunks).toMatchObject([
        { chunk: { type: "response.output_text.delta" } },
        { chunk: { type: "response.completed" } },
      ]);

      expect(streamEvents.length).toBeGreaterThanOrEqual(6);
      expect(completed).toHaveLength(3);
      expect(completed).toMatchObject([
        {
          endpoint: "chat_completions",
          result: { streamed: true, chunk_count: 2 },
        },
        { endpoint: "messages", result: { streamed: true, chunk_count: 2 } },
        { endpoint: "responses", result: { streamed: true, chunk_count: 2 } },
      ]);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("emits callback payloads with endpoint-specific payload kinds", async () => {
    const client = clientModule.createClient({ maxWorkers: 1, warmup: false });
    const preApiCalls: Array<Record<string, unknown>> = [];
    const successCalls: Array<Record<string, unknown>> = [];
    client.events.on("callback:pre_api_call", (payload: unknown) =>
      preApiCalls.push(payload as Record<string, unknown>),
    );
    client.events.on("callback:success", (payload: unknown) =>
      successCalls.push(payload as Record<string, unknown>),
    );

    try {
      await client.chatCompletions.create({
        model: "openai/test-chat-callbacks",
        api_base: baseUrl,
        api_key: "chat-secret",
        messages: [{ role: "user", content: "callbacks" }],
        metadata: { authorization: "Bearer callback-secret" },
      });
      await client.embeddings.create({
        model: "openai/test-embeddings-callbacks",
        api_base: baseUrl,
        api_key: "embeddings-secret",
        input: "callbacks",
      });

      expect(preApiCalls).toHaveLength(2);
      expect(successCalls).toHaveLength(2);
      expect(preApiCalls[0]).toMatchObject({
        endpoint: "chat_completions",
        payloadKind: "chat_completions",
        hook: "pre_api_call",
      });
      expect(successCalls[1]).toMatchObject({
        endpoint: "embeddings",
        payloadKind: "embeddings",
        hook: "success",
      });
      expect(JSON.stringify(preApiCalls)).toContain("callbacks");
      expect(JSON.stringify(successCalls)).toContain("embedding");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("maps non-stream aborts to RequestAbortedError", async () => {
    const client = clientModule.createClient({ maxWorkers: 1, warmup: false });
    const controller = new AbortController();

    try {
      const promise = client.chatCompletions.create({
        model: "openai/test-chat-abort",
        api_base: baseUrl,
        api_key: "secret-abort",
        messages: [{ role: "user", content: "abort" }],
        metadata: { testCase: "abort-non-stream" },
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 25);

      await expect(promise).rejects.toMatchObject({
        name: "RequestAbortedError",
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("maps stream aborts to RequestAbortedError and closes the iterator", async () => {
    const client = clientModule.createClient({ maxWorkers: 1, warmup: false });
    const controller = new AbortController();

    try {
      const stream = await client.responses.create({
        model: "openai/test-responses-abort-stream",
        api_base: baseUrl,
        api_key: "secret-stream-abort",
        input: [{ role: "user", content: "abort-stream" }],
        stream: true,
        signal: controller.signal,
      });

      const reader = (stream as ReadableStream<unknown>).getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      controller.abort();
      await expect(reader.read()).rejects.toMatchObject({
        name: "RequestAbortedError",
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("keeps concurrent requests scoped by request id in callback events", async () => {
    const client = clientModule.createClient({ maxWorkers: 2, warmup: false });
    const successEvents: Array<Record<string, unknown>> = [];
    client.events.on("callback:success", (payload: unknown) =>
      successEvents.push(payload as Record<string, unknown>),
    );

    try {
      await Promise.all([
        client.chatCompletions.create({
          model: "openai/test-concurrency-a",
          api_base: baseUrl,
          api_key: "secret-a",
          messages: [{ role: "user", content: "A" }],
        }),
        client.chatCompletions.create({
          model: "openai/test-concurrency-b",
          api_base: baseUrl,
          api_key: "secret-b",
          messages: [{ role: "user", content: "B" }],
        }),
      ]);

      const chatSuccesses = successEvents.filter(
        (event) => event.endpoint === "chat_completions",
      );
      expect(chatSuccesses).toHaveLength(2);
      const requestIds = new Set(
        chatSuccesses.map((event) => String(event.requestId)),
      );
      expect(requestIds.size).toBe(2);
    } finally {
      await client.close();
    }
  }, 60_000);
});
