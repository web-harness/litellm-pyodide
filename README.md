# litellm-pyodide

Run LiteLLM inside Pyodide workers from one JavaScript client for Node and the browser.

This package keeps the Python runtime, wheel install, and worker boot path inside the package. You call LiteLLM-style endpoints from JavaScript, and the package handles Pyodide, the local wheelhouse, and callback forwarding behind the scenes.

## Features

- Single public ESM entrypoint.
- Browser and Node runtime detection.
- Local Pyodide assets. No CDN fallback.
- LiteLLM-compatible endpoint surface for chat completions, messages, responses, and embeddings.
- ReadableStream support for streamed chat, messages, and responses calls.
- EventEmitter-style callback forwarding on the main thread.
- Worker-backed execution so Python startup and request work stay off the main thread.
- Optional browser-side `corsBusterUrl` rewriting for cross-origin requests that need a CORS proxy.
- A React + WebLLM GitHub Pages demo with one shared service-worker engine and IndexedDB-backed model reuse.

## Installation

```bash
npm install litellm-pyodide
```

Node 18+ is required.

Browser usage assumes a normal npm build pipeline that resolves package dependencies and serves the built package assets over HTTP.

## Quick Start

```ts
import { createClient } from "litellm-pyodide";

const client = createClient({
	maxWorkers: 1,
	warmup: true,
	corsBusterUrl: "https://cors-anywhere.example/",
});

const response = await client.chatCompletions.create({
	model: "openai/gpt-4o-mini",
	api_key: process.env.OPENAI_API_KEY,
	messages: [{ role: "user", content: "Hello from Pyodide" }],
});

console.log(response);

await client.close();
```

## Supported APIs

```ts
client.chatCompletions.create(...)
client.messages.create(...)
client.responses.create(...)
client.embeddings.create(...)
```

Non-stream requests resolve to JSON-safe LiteLLM response payloads.

Stream requests resolve to ReadableStream values whose chunks preserve endpoint-native event shapes.

## Chat Completions

```ts
const response = await client.chatCompletions.create({
	model: "openai/gpt-4o-mini",
	api_key: process.env.OPENAI_API_KEY,
	messages: [
		{ role: "system", content: "Be concise" },
		{ role: "user", content: "Explain Pyodide in one sentence" },
	],
});
```

## Messages

```ts
const response = await client.messages.create({
	model: "anthropic/claude-3-5-sonnet-20241022",
	api_key: process.env.ANTHROPIC_API_KEY,
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 256,
});
```

## Responses

```ts
const response = await client.responses.create({
	model: "openai/gpt-4.1-mini",
	api_key: process.env.OPENAI_API_KEY,
	input: [{ role: "user", content: "Summarize this repository" }],
});
```

## Embeddings

```ts
const response = await client.embeddings.create({
	model: "openai/text-embedding-3-small",
	api_key: process.env.OPENAI_API_KEY,
	input: "embed this string",
});
```

## Streaming

Streaming returns a ReadableStream.

```ts
const stream = await client.responses.create({
	model: "openai/gpt-4.1-mini",
	api_key: process.env.OPENAI_API_KEY,
	input: [{ role: "user", content: "Stream a short answer" }],
	stream: true,
});

const reader = stream.getReader();

for (;;) {
	const next = await reader.read();
	if (next.done) break;
	console.log(next.value);
}
```

## Events

The client exposes one shared EventEmitter-compatible event surface:

```ts
client.events.on("callback:pre_api_call", (payload) => {
	console.log(payload);
});

client.events.on("callback:success", (payload) => {
	console.log(payload);
});

client.events.on("request:stream_chunk", (payload) => {
	console.log(payload);
});

client.events.on("worker:ready", (payload) => {
	console.log(payload);
});
```

Current worker and request events:

- `callback:pre_api_call`
- `callback:post_api_call`
- `callback:stream_event`
- `callback:success`
- `callback:failure`
- `request:stream_chunk`
- `request:completed`
- `worker:boot`
- `worker:ready`
- `worker:error`
- `worker:shutdown`

Event payloads are serialized JavaScript objects, not raw Python objects.

## Browser Proxy Support

Browser requests can optionally rewrite their final outbound URL through a CORS proxy.

```ts
const client = createClient({
	maxWorkers: 1,
	corsBusterUrl: "https://cors-anywhere.example/",
});

await client.chatCompletions.create({
	model: "openai/gpt-4o-mini",
	api_base: "https://api.openai.com",
	api_key: "browser-key",
	messages: [{ role: "user", content: "hello" }],
});
```

The runtime applies the proxy only after the final provider URL is resolved. It deliberately bypasses proxying when:

- no proxy base is configured
- the target is same-origin with the current browser page
- the target has already been prefixed with the proxy base

When the proxy is used, the runtime also adds `X-Requested-With: litellm-pyodide`.

## GitHub Pages Demo

This repository now includes a React demo under `demo/` that exercises the built package artifact against same-origin service-worker routes backed by WebLLM.

Fixed demo models:

- chat: `SmolLM2-360M-Instruct-q4f16_1-MLC`
- embeddings: `snowflake-arctic-embed-m-q0f32-MLC-b4`

The demo uses one shared WebLLM service-worker engine with `cacheBackend: "indexeddb"`. The UI explicitly shows whether the browser is still downloading model assets or reusing cached artifacts from previous visits.

Local demo routes:

- `POST /demo-openai/v1/chat/completions`
- `POST /demo-openai/v1/responses`
- `POST /demo-anthropic/v1/messages`
- `POST /demo-openai/v1/embeddings`

### Demo Commands

```bash
npm run demo:install
npm run demo:build
npm run demo:preview
npm run demo:test
```

`demo:build` rebuilds the package dist output, copies it into `demo/public/litellm-pyodide`, and then builds the Vite app.

`demo:test` runs the demo unit tests and a browser smoke path against the built demo in mock mode so the Pages workflow can validate the transport path without requiring WebGPU in CI.

## Warmup And Health

Pyodide startup is the expensive path. If you want to pay that cost before the first request, call warmup explicitly.

```ts
await client.warmup();

const health = await client.health();
console.log(health);
```

## How It Works

- `build.ts` bundles the public client and worker runtime with webpack.
- The build copies Pyodide assets into `dist/internal/pyodide`.
- The build stages the Python bridge into `dist/internal/python`.
- The build produces a local wheelhouse and runtime manifest under `dist/internal`.
- The worker boots Pyodide from package-local assets, installs the local wheels, imports the bridge, and then serves requests.

## Debugging

This package uses the `debug` package for runtime logging.

```bash
DEBUG=litellmPyodide:* npm test
```

Useful namespaces:

- `litellmPyodide:build`
- `litellmPyodide:client`
- `litellmPyodide:pool`
- `litellmPyodide:worker`
- `litellmPyodide:bridge`

## Limitations

- This is an SDK-side runtime. Browser usage does not hide provider credentials from end users.
- Cold start is slower than a JavaScript-only SDK because Pyodide and Python wheels must boot first.
- The package ships a Pyodide-specific LiteLLM overlay for the endpoint families exposed here, not full upstream LiteLLM parity.
- Browser usage requires correct static asset serving for the internal Pyodide, wheel, and worker assets.
- Native CPython extension wheels are out of scope unless they are Pyodide-compatible.

## Build And Test

```bash
npm run build
npm run typecheck
npm test
npm run demo:test
```

The test suite covers:

- runtime detection
- metadata injection
- Node integration for all four endpoint families
- stream handling and abort behavior
- callback forwarding and request scoping
- browser worker smoke coverage against the built dist output
- demo startup-state helpers and route adapters
- demo browser smoke coverage against the built Pages app in mock mode

## Repository Layout

- `build.ts`: build orchestration
- `src/`: TypeScript client, pool adapter, worker runtime, and helpers
- `python/bridge.py`: package-owned Python bridge
- `python/litellm_overlay/`: Pyodide-compatible LiteLLM overlay
- `python/wheels-source.json`: pinned wheel source manifest
- `tests/`: unit, integration, and browser smoke tests
