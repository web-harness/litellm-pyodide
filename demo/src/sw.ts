/// <reference lib="WebWorker" />

import { ServiceWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
import {
  createMockDemoEngineAdapter,
  errorResponse,
  handleDemoRoute,
  matchDemoRoute,
} from "./route-adapters";

declare const self: ServiceWorkerGlobalScope;

let handler: ServiceWorkerMLCEngineHandler | undefined;
const useMockEngine =
  new URL(self.location.href).searchParams.get("mock") === "1";

function ensureHandler() {
  if (!handler) {
    handler = new ServiceWorkerMLCEngineHandler();
  }

  return handler;
}

ensureHandler();

function getAdapter() {
  if (useMockEngine) {
    return createMockDemoEngineAdapter();
  }

  if (!handler) {
    return undefined;
  }

  return {
    chatCompletionsCreate(request: Record<string, unknown>) {
      return handler!.engine.chat.completions.create(request as never);
    },
    embeddingsCreate(request: Record<string, unknown>) {
      return handler!.engine.embeddings.create(request as never);
    },
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  ensureHandler();
  const route = matchDemoRoute(new URL(event.request.url));
  if (!route) {
    return;
  }

  event.respondWith(
    (async () => {
      const adapter = getAdapter();
      if (!adapter) {
        return errorResponse(
          "Local models are not ready yet. Wait for the startup status panel to report readiness.",
          503,
          { code: "models_not_ready" },
        );
      }

      try {
        return await handleDemoRoute(adapter, route, event.request);
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : String(error),
          500,
          { code: "demo_route_failure" },
        );
      }
    })(),
  );
});
