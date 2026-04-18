import { CHAT_MODEL_ID, EMBEDDING_MODEL_ID } from "./demo-models";

export interface DemoEngineAdapter {
  chatCompletionsCreate(request: Record<string, unknown>): Promise<unknown>;
  embeddingsCreate(request: Record<string, unknown>): Promise<unknown>;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

const encoder = new TextEncoder();

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

function errorResponse(
  message: string,
  status = 400,
  details?: Record<string, unknown>,
) {
  return jsonResponse(
    {
      error: {
        message,
        type: "demo_error",
        ...details,
      },
    },
    status,
  );
}

function normalizeContent(value: unknown): string {
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
          return String((entry as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(entry);
      })
      .join("\n");
  }
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return String(value ?? "");
}

function normalizeMessagesInput(input: unknown) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) {
    return [{ role: "user", content: JSON.stringify(input) }];
  }

  return input.map((entry) => {
    if (entry && typeof entry === "object") {
      const candidate = entry as {
        role?: unknown;
        content?: unknown;
        type?: unknown;
      };
      return {
        role: typeof candidate.role === "string" ? candidate.role : "user",
        content: normalizeContent(candidate.content ?? candidate.type ?? entry),
      };
    }
    return { role: "user", content: String(entry) };
  });
}

function anthropicToChatRequest(request: Record<string, unknown>) {
  const chatMessages: Array<{ role: string; content: string }> = [];
  const system = request.system;
  if (typeof system === "string" && system.trim()) {
    chatMessages.push({ role: "system", content: system });
  }
  if (Array.isArray(system)) {
    for (const entry of system) {
      chatMessages.push({ role: "system", content: normalizeContent(entry) });
    }
  }

  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const entry of messages) {
    const candidate = (entry ?? {}) as { role?: unknown; content?: unknown };
    chatMessages.push({
      role: typeof candidate.role === "string" ? candidate.role : "user",
      content: normalizeContent(candidate.content),
    });
  }

  return {
    model: CHAT_MODEL_ID,
    messages: chatMessages,
    max_tokens:
      typeof request.max_tokens === "number" ? request.max_tokens : undefined,
    stream: Boolean(request.stream),
    temperature:
      typeof request.temperature === "number" ? request.temperature : undefined,
    top_p: typeof request.top_p === "number" ? request.top_p : undefined,
    stop: Array.isArray(request.stop_sequences)
      ? request.stop_sequences
      : undefined,
    tools: Array.isArray(request.tools) ? request.tools : undefined,
    tool_choice: request.tool_choice,
  } satisfies Record<string, unknown>;
}

function responsesToChatRequest(request: Record<string, unknown>) {
  return {
    model: CHAT_MODEL_ID,
    messages: normalizeMessagesInput(request.input),
    stream: Boolean(request.stream),
    tools: Array.isArray(request.tools) ? request.tools : undefined,
    tool_choice: request.tool_choice,
    temperature:
      typeof request.temperature === "number" ? request.temperature : undefined,
    top_p: typeof request.top_p === "number" ? request.top_p : undefined,
    max_tokens:
      typeof request.max_output_tokens === "number"
        ? request.max_output_tokens
        : typeof request.max_tokens === "number"
          ? request.max_tokens
          : undefined,
  } satisfies Record<string, unknown>;
}

function extractAssistantText(chatResponse: any) {
  const content = chatResponse?.choices?.[0]?.message?.content;
  return normalizeContent(content ?? "");
}

function mapFinishReason(value: unknown) {
  if (value === "length") {
    return "max_tokens";
  }
  if (value === "tool_calls") {
    return "tool_use";
  }
  if (value === "content_filter") {
    return "end_turn";
  }
  return "end_turn";
}

async function* toAsyncIterable(value: unknown): AsyncIterable<any> {
  if (value && typeof value === "object" && Symbol.asyncIterator in value) {
    yield* value as AsyncIterable<any>;
    return;
  }

  if (
    value &&
    typeof value === "object" &&
    "getReader" in value &&
    typeof (value as ReadableStream).getReader === "function"
  ) {
    const reader = (value as ReadableStream).getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  throw new Error("Expected an async iterable or readable stream result.");
}

function createSseResponse(
  producer: (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => Promise<void>,
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          await producer(controller);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
    { headers: sseHeaders },
  );
}

function enqueueSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: unknown,
) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function requestIdentifier(request: Record<string, unknown>, prefix: string) {
  const metadata = request.metadata;
  if (metadata && typeof metadata === "object") {
    const requestId = (metadata as Record<string, unknown>)
      .litellm_pyodide_request_id;
    if (typeof requestId === "string" && requestId) {
      return requestId;
    }
  }
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function handleChatCompletionsRoute(
  adapter: DemoEngineAdapter,
  request: Record<string, unknown>,
) {
  const webllmRequest = { ...request, model: CHAT_MODEL_ID };

  if (!request.stream) {
    const response = await adapter.chatCompletionsCreate(webllmRequest);
    return jsonResponse(response);
  }

  const streamResult = await adapter.chatCompletionsCreate({
    ...webllmRequest,
    stream: true,
  });

  return createSseResponse(async (controller) => {
    for await (const chunk of toAsyncIterable(streamResult)) {
      enqueueSse(controller, chunk);
    }
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  });
}

export async function handleEmbeddingsRoute(
  adapter: DemoEngineAdapter,
  request: Record<string, unknown>,
) {
  const response = await adapter.embeddingsCreate({
    ...request,
    model: EMBEDDING_MODEL_ID,
  });
  return jsonResponse(response);
}

export async function handleResponsesRoute(
  adapter: DemoEngineAdapter,
  request: Record<string, unknown>,
) {
  const chatRequest = responsesToChatRequest(request);
  const responseId = requestIdentifier(request, "resp");

  if (!request.stream) {
    const chatResponse = await adapter.chatCompletionsCreate(chatRequest);
    const text = extractAssistantText(chatResponse);
    return jsonResponse({
      id: responseId,
      object: "response",
      model: CHAT_MODEL_ID,
      status: "completed",
      output: [
        {
          id: `msg_${responseId}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text,
              annotations: [],
            },
          ],
        },
      ],
      output_text: text,
      usage:
        chatResponse && typeof chatResponse === "object"
          ? chatResponse.usage
          : undefined,
    });
  }

  const streamResult = await adapter.chatCompletionsCreate({
    ...chatRequest,
    stream: true,
  });

  return createSseResponse(async (controller) => {
    enqueueSse(controller, {
      type: "response.created",
      response: { id: responseId, model: CHAT_MODEL_ID, status: "in_progress" },
    });

    for await (const chunk of toAsyncIterable(streamResult)) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) {
        enqueueSse(controller, {
          type: "response.output_text.delta",
          response_id: responseId,
          delta,
        });
      }
    }

    enqueueSse(controller, {
      type: "response.completed",
      response: { id: responseId, model: CHAT_MODEL_ID, status: "completed" },
    });
  });
}

export async function handleMessagesRoute(
  adapter: DemoEngineAdapter,
  request: Record<string, unknown>,
) {
  const chatRequest = anthropicToChatRequest(request);
  const messageId = requestIdentifier(request, "msg");

  if (!request.stream) {
    const chatResponse = await adapter.chatCompletionsCreate(chatRequest);
    const text = extractAssistantText(chatResponse);
    return jsonResponse({
      id: messageId,
      type: "message",
      role: "assistant",
      model: CHAT_MODEL_ID,
      content: [{ type: "text", text }],
      stop_reason: mapFinishReason(chatResponse?.choices?.[0]?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: Number(chatResponse?.usage?.prompt_tokens ?? 0),
        output_tokens: Number(chatResponse?.usage?.completion_tokens ?? 0),
      },
    });
  }

  const streamResult = await adapter.chatCompletionsCreate({
    ...chatRequest,
    stream: true,
  });

  return createSseResponse(async (controller) => {
    enqueueSse(controller, {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: CHAT_MODEL_ID,
      },
    });
    enqueueSse(controller, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    for await (const chunk of toAsyncIterable(streamResult)) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) {
        enqueueSse(controller, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta },
        });
      }
    }

    enqueueSse(controller, { type: "content_block_stop", index: 0 });
    enqueueSse(controller, {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    enqueueSse(controller, { type: "message_stop" });
  });
}

export function matchDemoRoute(url: URL) {
  if (url.pathname.endsWith("/demo-openai/v1/chat/completions")) {
    return "chat_completions" as const;
  }
  if (url.pathname.endsWith("/demo-openai/v1/responses")) {
    return "responses" as const;
  }
  if (url.pathname.endsWith("/demo-anthropic/v1/messages")) {
    return "messages" as const;
  }
  if (url.pathname.endsWith("/demo-openai/v1/embeddings")) {
    return "embeddings" as const;
  }
  return null;
}

export async function handleDemoRoute(
  adapter: DemoEngineAdapter,
  route: ReturnType<typeof matchDemoRoute>,
  request: Request,
) {
  if (!route) {
    return errorResponse("Unknown demo route.", 404);
  }
  if (request.method !== "POST") {
    return errorResponse("Demo routes only support POST.", 405);
  }

  const payload = (await request.json()) as Record<string, unknown>;

  switch (route) {
    case "chat_completions":
      return handleChatCompletionsRoute(adapter, payload);
    case "responses":
      return handleResponsesRoute(adapter, payload);
    case "messages":
      return handleMessagesRoute(adapter, payload);
    case "embeddings":
      return handleEmbeddingsRoute(adapter, payload);
    default:
      return errorResponse("Unsupported demo route.", 404);
  }
}

export function createMockDemoEngineAdapter(): DemoEngineAdapter {
  return {
    async chatCompletionsCreate(request) {
      const prompt =
        normalizeMessagesInput(request.messages)[0]?.content ?? "demo";

      if (!request.stream) {
        return {
          id: `chatcmpl_${crypto.randomUUID()}`,
          object: "chat.completion",
          model: CHAT_MODEL_ID,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: `Mock reply for ${prompt}`,
              },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 6,
            total_tokens: 14,
          },
        };
      }

      return (async function* () {
        yield {
          id: `chatcmpl_${crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "Mock " } }],
        };
        yield {
          id: `chatcmpl_${crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "stream" } }],
        };
      })();
    },
    async embeddingsCreate(request) {
      const values = Array.isArray(request.input)
        ? request.input
        : [request.input];
      return {
        object: "list",
        model: EMBEDDING_MODEL_ID,
        data: values.map((value, index) => ({
          object: "embedding",
          index,
          embedding: [String(value).length / 10, index + 0.1, index + 0.2],
        })),
        usage: {
          prompt_tokens: values.length,
          total_tokens: values.length,
        },
      };
    },
  };
}

export { errorResponse };
