import type { RuntimeManifest } from "../types";

declare const __webpack_public_path__: string;

async function readText(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    const fs = await import("node:fs/promises");
    return fs.readFile(parsed, "utf8");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load runtime manifest from ${url}`);
  }
  return response.text();
}

export async function loadRuntimeManifest(
  manifestUrl = `${__webpack_public_path__ || "./"}internal/runtime-manifest.json`,
): Promise<RuntimeManifest> {
  return JSON.parse(await readText(manifestUrl)) as RuntimeManifest;
}
