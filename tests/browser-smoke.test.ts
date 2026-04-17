import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServer, createMockProviderServer } from "./helpers/mock-provider";

const workerpoolImport = 'from "workerpool"';
const workerpoolBrowserImport = 'from "/__test__/workerpool-browser.mjs"';

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".zip", "application/zip"],
  [".whl", "application/zip"],
  [".py", "text/plain; charset=utf-8"],
]);

function contentTypeFor(filePath: string) {
  return mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  getContext: () => string,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms\n${getContext()}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

describe.sequential("browser smoke", () => {
  const provider = createMockProviderServer();
  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>litellm-pyodide browser smoke</title>
  </head>
  <body>
    <script type="module">
      import * as litellmPyodide from "/dist/index.mjs";
      window.__litellmPyodide = litellmPyodide;
    </script>
  </body>
</html>`);
      return;
    }

    if (req.url === "/__test__/workerpool-browser.mjs") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(
        [
          'import "/node_modules/workerpool/dist/workerpool.js";',
          "export default globalThis.workerpool;",
        ].join("\n"),
      );
      return;
    }

    if (req.url === "/node_modules/workerpool/dist/workerpool.js") {
      const filePath = path.join(
        process.cwd(),
        "node_modules",
        "workerpool",
        "dist",
        "workerpool.js",
      );
      const contents = await readFile(filePath);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(contents);
      return;
    }

    if (req.url.startsWith("/v1/")) {
      provider.server.emit("request", req, res);
      return;
    }

    if (!req.url.startsWith("/dist/")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const filePath = path.join(process.cwd(), req.url.slice(1));
    try {
      const contents = req.url.endsWith(".mjs")
        ? (await readFile(filePath, "utf8")).replaceAll(
            workerpoolImport,
            workerpoolBrowserImport,
          )
        : await readFile(filePath);
      res.writeHead(200, { "content-type": contentTypeFor(filePath) });
      res.end(contents);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  let origin = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await closeServer(server);
  });

  it("boots in a browser worker and handles non-stream and stream requests", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];

    page.on("console", (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });

    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      try {
        await page.waitForFunction(() => Boolean(window.__litellmPyodide));
      } catch (error) {
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            `console: ${consoleMessages.join(" | ") || "none"}`,
            `pageErrors: ${pageErrors.join(" | ") || "none"}`,
            `requestFailures: ${requestFailures.join(" | ") || "none"}`,
          ].join("\n"),
        );
      }

      const diagnostics = () =>
        [
          `console: ${consoleMessages.join(" | ") || "none"}`,
          `pageErrors: ${pageErrors.join(" | ") || "none"}`,
          `requestFailures: ${requestFailures.join(" | ") || "none"}`,
        ].join("\n");

      const result = await withTimeout(
        page.evaluate(async (baseUrl) => {
          const module = window.__litellmPyodide;
          const client = module.createClient({ maxWorkers: 1, warmup: false });

          try {
            const health = await client.warmup();
            const chat = await client.chatCompletions.create({
              model: "openai/browser-chat",
              api_base: baseUrl,
              api_key: "browser-secret",
              messages: [{ role: "user", content: "hello" }],
            });

            const stream = (await client.responses.create({
              model: "openai/browser-stream",
              api_base: baseUrl,
              api_key: "browser-secret",
              input: [{ role: "user", content: "stream" }],
              stream: true,
            })) as ReadableStream<unknown>;

            const reader = stream.getReader();
            const chunks = [];
            for (;;) {
              const next = await reader.read();
              if (next.done) {
                break;
              }
              chunks.push(next.value);
            }

            return { health, chat, chunks };
          } finally {
            await client.close();
          }
        }, origin),
        30_000,
        diagnostics,
      );

      expect(result.health).toMatchObject({
        initialized: true,
        runtime: "browser",
      });
      expect(result.chat).toMatchObject({
        object: "chat.completion",
        choices: [{ message: { content: "chat-ok" } }],
      });
      expect(result.chunks).toMatchObject([
        { chunk: { type: "response.output_text.delta" } },
        { chunk: { type: "response.completed" } },
      ]);
    } finally {
      await page.close();
      await browser.close();
    }
  }, 90_000);
});

declare global {
  interface Window {
    __litellmPyodide: typeof import("../src/index");
  }
}
