import { UnsupportedRuntimeError } from "../errors";
import type { RuntimeKind } from "../types";

export function detectRuntime(): RuntimeKind {
  const hasProcess = typeof process !== "undefined" && !!process.versions?.node;
  const hasWorkerThreads = hasProcess;
  if (hasProcess && hasWorkerThreads) {
    return "node";
  }

  const hasBrowserWorker =
    typeof Worker !== "undefined" &&
    (typeof window !== "undefined" || typeof self !== "undefined");
  if (hasBrowserWorker) {
    return "browser";
  }

  throw new UnsupportedRuntimeError(
    "This package supports browser workers and Node worker_threads only.",
  );
}
