export type LiteLLMPyodideRuntime = typeof import("../../src/index");

let runtimePromise: Promise<LiteLLMPyodideRuntime> | undefined;

export async function loadLiteLLMPyodideRuntime() {
  if (!runtimePromise) {
    const runtimeUrl = new URL(
      `${import.meta.env.BASE_URL}litellm-pyodide/index.mjs`,
      window.location.href,
    ).toString();
    runtimePromise = import(/* @vite-ignore */ runtimeUrl);
  }

  return runtimePromise;
}
