import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import process from "node:process";
import { chromium } from "playwright";
import { afterAll, describe, expect, test } from "vitest";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function reservePreviewPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Failed to reserve a preview port.")),
        );
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function waitForServer(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore until the preview server is ready.
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for preview server at ${url}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopProcess(child: ChildProcess | undefined) {
  if (!child) {
    return;
  }
  child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
}

describe.sequential("demo browser smoke", () => {
  let preview: ChildProcess | undefined;

  afterAll(async () => {
    await stopProcess(preview);
  });

  test("boots the built demo and exercises all endpoint panels in mock mode", async () => {
    const previewPort = await reservePreviewPort();
    const previewOrigin = `http://127.0.0.1:${previewPort}`;
    const previewUrl = `${previewOrigin}/?mockEngine=1`;

    preview = spawn(
      npmCommand,
      [
        "run",
        "preview",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(previewPort),
        "--strictPort",
      ],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    );

    await waitForServer(`${previewOrigin}/`, 30000);

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(previewUrl, { waitUntil: "networkidle" });
      await page
        .getByRole("heading", {
          name: /litellm-pyodide through real http, local webllm/i,
        })
        .waitFor();

      const startupSummary = page.getByTestId("startup-summary");
      const earlySummary = await startupSummary.textContent();
      if (!earlySummary || /Both models are ready/i.test(earlySummary)) {
        throw new Error(
          "Expected the startup summary to show a pre-ready loading state first.",
        );
      }

      await page
        .getByText(/Both models are ready/i)
        .waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Warmup" }).click();
      await page.getByRole("button", { name: "Run non-stream" }).nth(0).click();
      await page.getByRole("button", { name: "Run stream" }).nth(0).click();
      await page.getByRole("button", { name: "Run non-stream" }).nth(1).click();
      await page.getByRole("button", { name: "Run stream" }).nth(1).click();
      await page.getByRole("button", { name: "Run non-stream" }).nth(2).click();
      await page.getByRole("button", { name: "Run stream" }).nth(2).click();
      await page.getByRole("button", { name: "Run embeddings" }).click();
      await page
        .locator("#prompt-input")
        .fill("Give me a short proof this mock route is wired correctly.");
      await page.getByRole("button", { name: "Send prompt" }).click();

      await page.waitForFunction(
        () =>
          !document
            .querySelector('[data-testid="chat-output"]')
            ?.textContent?.includes("No chat result yet."),
      );
      await page.waitForFunction(
        () =>
          !document
            .querySelector('[data-testid="responses-output"]')
            ?.textContent?.includes("No responses result yet."),
      );
      await page.waitForFunction(
        () =>
          !document
            .querySelector('[data-testid="messages-output"]')
            ?.textContent?.includes("No messages result yet."),
      );
      await page.waitForFunction(
        () =>
          !document
            .querySelector('[data-testid="embeddings-output"]')
            ?.textContent?.includes("No embeddings result yet."),
      );
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="prompt-thread"]')
          ?.textContent?.includes("Mock reply for"),
      );

      const chatText = await page.getByTestId("chat-output").textContent();
      const responsesText = await page
        .getByTestId("responses-output")
        .textContent();
      const messagesText = await page
        .getByTestId("messages-output")
        .textContent();
      const embeddingsText = await page
        .getByTestId("embeddings-output")
        .textContent();
      const promptThreadText = await page
        .getByTestId("prompt-thread")
        .textContent();

      expect(chatText).toContain("Mock");
      expect(responsesText).toContain("response.completed");
      expect(messagesText).toContain("message_stop");
      expect(embeddingsText).toContain("embedding");
      expect(promptThreadText).toContain("Mock reply for");

      await page.close();
    } finally {
      await browser.close();
      await stopProcess(preview);
      preview = undefined;
    }
  }, 90_000);
});
