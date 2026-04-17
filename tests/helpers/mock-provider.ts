import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type RequestRecord = {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  timestamp: number;
};

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function writeJson(res: ServerResponse, payload: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function writeSse(
  res: ServerResponse,
  chunks: unknown[],
  intervalMs = 25,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await delay(intervalMs);
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

export function createMockProviderServer() {
  const requests: RequestRecord[] = [];

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await readJson(req);
    requests.push({
      path: req.url,
      body,
      headers: req.headers,
      timestamp: Date.now(),
    });

    if (
      (body.metadata as Record<string, unknown> | undefined)?.testCase ===
      "abort-non-stream"
    ) {
      await delay(500);
    }

    if (req.url === "/v1/chat/completions") {
      if (body.stream) {
        await writeSse(res, [
          {
            id: "chat-stream-1",
            type: "chat.delta",
            delta: { content: "hello" },
          },
          {
            id: "chat-stream-2",
            type: "chat.delta",
            delta: { content: " world" },
          },
        ]);
        return;
      }

      writeJson(res, {
        id: "chat-completion-1",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "chat-ok" } }],
        echoed: {
          temperature: body.temperature,
          metadata: body.metadata,
        },
      });
      return;
    }

    if (req.url === "/v1/messages") {
      if (body.stream) {
        await writeSse(res, [
          { type: "message_start", message: { id: "msg_1" } },
          { type: "content_block_delta", delta: { text: "anthropic" } },
        ]);
        return;
      }

      writeJson(res, {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "message-ok" }],
        echoed: {
          max_tokens: body.max_tokens,
          stop_sequences: body.stop_sequences,
          thinking: body.thinking,
          tool_choice: body.tool_choice,
          tools: body.tools,
          system: body.system,
        },
      });
      return;
    }

    if (req.url === "/v1/responses") {
      if (body.stream) {
        await writeSse(res, [
          { type: "response.output_text.delta", delta: "response" },
          { type: "response.completed", response: { id: "resp_1" } },
        ]);
        return;
      }

      writeJson(res, {
        id: "response-1",
        object: "response",
        output_text: "response-ok",
        echoed: {
          previous_response_id: body.previous_response_id,
          tools: body.tools,
          tool_choice: body.tool_choice,
          truncation: body.truncation,
          context_management: body.context_management,
        },
      });
      return;
    }

    if (req.url === "/v1/embeddings") {
      writeJson(res, {
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        echoed: {
          dimensions: body.dimensions,
          encoding_format: body.encoding_format,
          metadata: body.metadata,
        },
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    requests,
    server,
    lastRequest(path: string) {
      const matching = requests.filter((entry) => entry.path === path);
      return matching.at(-1);
    },
  };
}

export type MockProviderServer = ReturnType<typeof createMockProviderServer>;

export async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
