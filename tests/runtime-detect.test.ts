import { describe, expect, it, vi } from "vitest";

describe("detectRuntime", () => {
  it("detects node when process versions are present", async () => {
    vi.resetModules();
    const mod = await import("../src/runtime/detect");
    expect(mod.detectRuntime()).toBe("node");
  });

  it("detects browser when worker globals exist and node globals do not", async () => {
    vi.resetModules();
    const originalProcess = globalThis.process;
    const originalWorker = globalThis.Worker;
    const originalWindow = globalThis.window;

    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Worker", class Worker {});
    vi.stubGlobal("window", {});

    try {
      const mod = await import("../src/runtime/detect");
      expect(mod.detectRuntime()).toBe("browser");
    } finally {
      if (originalProcess === undefined) {
        vi.unstubAllGlobals();
      } else {
        vi.stubGlobal("process", originalProcess);
        vi.stubGlobal("Worker", originalWorker);
        vi.stubGlobal("window", originalWindow);
      }
    }
  });

  it("throws when neither node nor browser worker support exists", async () => {
    vi.resetModules();
    const originalProcess = globalThis.process;
    const originalWorker = globalThis.Worker;
    const originalWindow = globalThis.window;
    const originalSelf = globalThis.self;

    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("self", undefined);

    try {
      const mod = await import("../src/runtime/detect");
      expect(() => mod.detectRuntime()).toThrow(
        /supports browser workers and Node worker_threads only/i,
      );
    } finally {
      if (originalProcess === undefined) {
        vi.unstubAllGlobals();
      } else {
        vi.stubGlobal("process", originalProcess);
        vi.stubGlobal("Worker", originalWorker);
        vi.stubGlobal("window", originalWindow);
        vi.stubGlobal("self", originalSelf);
      }
    }
  });
});
