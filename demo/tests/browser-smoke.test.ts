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

  test("reports unsupported WebGPU honestly instead of faking demo responses", async () => {
    const previewPort = await reservePreviewPort();
    const previewOrigin = `http://127.0.0.1:${previewPort}`;
    const previewUrl = `${previewOrigin}/`;

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
      await page.addInitScript(() => {
        Object.defineProperty(window.navigator, "gpu", {
          configurable: true,
          value: undefined,
        });
      });
      await page.goto(previewUrl, { waitUntil: "networkidle" });
      await page
        .getByRole("heading", {
          name: /litellm-pyodide through real http, local webllm/i,
        })
        .waitFor();

      await page
        .getByText(/This demo requires Chrome-class WebGPU support/i)
        .waitFor({ timeout: 30000 });

      const phaseText = await page
        .locator("dt", { hasText: "Phase" })
        .locator("xpath=following-sibling::dd[1]")
        .textContent();
      const startupSummary = await page
        .getByTestId("startup-summary")
        .textContent();
      const webgpuText = await page.locator("dd").nth(3).textContent();

      expect(phaseText).toContain("failed");
      expect(startupSummary).toContain("Startup failed");
      expect(webgpuText).toContain(
        "This demo requires Chrome-class WebGPU support",
      );
      expect(
        await page.getByRole("button", { name: "Warmup" }).isDisabled(),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Run embeddings" }).isDisabled(),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Send prompt" }).isDisabled(),
      ).toBe(true);
      await page.close();

      await page.close();
    } finally {
      await browser.close();
      await stopProcess(preview);
      preview = undefined;
    }
  }, 90_000);
});
