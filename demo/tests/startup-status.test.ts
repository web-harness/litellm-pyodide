import { describe, expect, test } from "vitest";
import { CHAT_MODEL_ID, EMBEDDING_MODEL_ID } from "../src/demo-models";
import {
  applyCacheState,
  applyInitProgress,
  createInitialModelStatuses,
  summarizeStartup,
} from "../src/startup-status";

describe("startup status helpers", () => {
  test("reports cache hits and misses clearly", () => {
    const statuses = applyCacheState(createInitialModelStatuses(), {
      [CHAT_MODEL_ID]: true,
      [EMBEDDING_MODEL_ID]: false,
    });

    expect(statuses[CHAT_MODEL_ID].state).toBe("cached");
    expect(statuses[EMBEDDING_MODEL_ID].state).toBe("not_cached");
    expect(summarizeStartup(statuses)).toContain("Checking cache state");
  });

  test("treats progress reports as downloading or cached loading", () => {
    const cached = applyCacheState(createInitialModelStatuses(), {
      [CHAT_MODEL_ID]: true,
      [EMBEDDING_MODEL_ID]: true,
    });

    const loading = applyInitProgress(cached, {
      text: `Loading ${CHAT_MODEL_ID} from IndexedDB cache`,
      progress: 0.45,
    });

    expect(loading[CHAT_MODEL_ID].state).toBe("loading");
    expect(summarizeStartup(loading)).toContain("reusing cached artifacts");
  });
});
