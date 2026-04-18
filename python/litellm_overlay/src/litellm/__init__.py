from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Iterable

from js import AbortSignal, Object, fetch
from pyodide.ffi import to_js
from pyodide.http import pyfetch

from .integrations.custom_logger import CustomLogger

__all__ = [
    "CustomLogger",
    "__version__",
    "acompletion",
    "aembedding",
    "anthropic_messages",
    "aresponses",
    "callbacks",
    "failure_callback",
    "input_callback",
    "success_callback",
]

__version__ = "1.83.7.post0"

callbacks: list[CustomLogger] = []
input_callback: list[CustomLogger] = []
success_callback: list[CustomLogger] = []
failure_callback: list[CustomLogger] = []

_RUNTIME_CONFIG: dict[str, Any] = {
    "cors_buster_url": None,
    "runtime": None,
}


@dataclass(slots=True)
class _ProviderRequest:
    provider: str
    model: str
    url: str
    headers: dict[str, str]
    payload: dict[str, Any]
    timeout_seconds: float | None
    metadata: dict[str, Any]


class _SSEStream:
    def __init__(self, response: Any, request: _ProviderRequest):
        self._response = response
        self._request = request
        self._reader = response.body.getReader()
        self._buffer = ""
        self._closed = False

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        return self

    async def __anext__(self) -> dict[str, Any]:
        while True:
            event = await self._next_event()
            if event is None:
                await _dispatch_hook(
                    "success",
                    self._request.payload,
                    {"stream": True, "provider": self._request.provider},
                )
                raise StopAsyncIteration

            if event == "[DONE]":
                await _dispatch_hook(
                    "success",
                    self._request.payload,
                    {"stream": True, "provider": self._request.provider},
                )
                raise StopAsyncIteration

            try:
                parsed = json.loads(event)
            except json.JSONDecodeError:
                parsed = {"type": "raw", "data": event}

            await _dispatch_hook("stream", self._request.payload, parsed)
            return parsed

    async def _next_event(self) -> str | None:
        while "\n\n" not in self._buffer:
            chunk = await self._reader.read()
            if chunk.done:
                if not self._buffer:
                    return None
                event = self._buffer
                self._buffer = ""
                return _extract_sse_data(event)
            self._buffer += bytes(chunk.value.to_py()).decode("utf-8")

        raw_event, self._buffer = self._buffer.split("\n\n", 1)
        return _extract_sse_data(raw_event)


def _extract_sse_data(raw_event: str) -> str:
    parts: list[str] = []
    for line in raw_event.splitlines():
        if line.startswith("data:"):
            parts.append(line[5:].lstrip())
    return "\n".join(parts)


def _callback_targets() -> list[CustomLogger]:
    seen: set[int] = set()
    ordered: list[CustomLogger] = []
    for logger in [*callbacks, *input_callback, *success_callback, *failure_callback]:
        marker = id(logger)
        if marker in seen:
            continue
        seen.add(marker)
        ordered.append(logger)
    return ordered


async def _invoke_logger_method(
    logger: CustomLogger, method_name: str, *args: Any
) -> None:
    method = getattr(logger, method_name, None)
    if method is None:
        return
    result = method(*args)
    if asyncio.iscoroutine(result):
        await result


async def _dispatch_hook(hook: str, kwargs: dict[str, Any], payload: Any) -> None:
    targets = _callback_targets()
    for logger in targets:
        if hook == "pre_api_call":
            await _invoke_logger_method(
                logger,
                "log_pre_api_call",
                kwargs.get("model"),
                kwargs.get("messages"),
                kwargs,
            )
            await _invoke_logger_method(
                logger,
                "async_log_pre_api_call",
                kwargs.get("model"),
                kwargs.get("messages"),
                kwargs,
            )
        elif hook == "post_api_call":
            await _invoke_logger_method(
                logger, "log_post_api_call", kwargs, payload, None, None
            )
        elif hook == "stream":
            await _invoke_logger_method(
                logger, "log_stream_event", kwargs, payload, None, None
            )
            await _invoke_logger_method(
                logger, "async_log_stream_event", kwargs, payload, None, None
            )
        elif hook == "success":
            await _invoke_logger_method(
                logger, "log_success_event", kwargs, payload, None, None
            )
            await _invoke_logger_method(
                logger, "async_log_success_event", kwargs, payload, None, None
            )
        elif hook == "failure":
            await _invoke_logger_method(
                logger, "log_failure_event", kwargs, payload, None, None
            )
            await _invoke_logger_method(
                logger, "async_log_failure_event", kwargs, payload, None, None
            )


def _split_provider_model(
    model: str, explicit_provider: str | None = None
) -> tuple[str, str]:
    if explicit_provider:
        return explicit_provider, model
    if "/" in model:
        provider, bare_model = model.split("/", 1)
        if provider in {"anthropic", "openai"}:
            return provider, bare_model
    return "openai", model


def _join_api_base(api_base: str | None, endpoint_path: str, default_base: str) -> str:
    if not api_base:
        return default_base
    trimmed = api_base.rstrip("/")
    if trimmed.endswith(endpoint_path):
        return trimmed
    if trimmed.endswith("/v1"):
        return f"{trimmed}/{endpoint_path}"
    return f"{trimmed}/v1/{endpoint_path}"


def _normalize_proxy_base(proxy_base: str) -> str:
    trimmed = proxy_base.strip()
    if not trimmed:
        return trimmed
    return trimmed if trimmed.endswith("/") else f"{trimmed}/"


def _browser_origin() -> str | None:
    try:
        import js

        origin = getattr(getattr(js, "location", None), "origin", None)
        if origin is None:
            return None
        return str(origin)
    except Exception:
        return None


def _apply_cors_buster(url: str, headers: dict[str, str]) -> tuple[str, dict[str, str]]:
    proxy_base = _RUNTIME_CONFIG.get("cors_buster_url")
    if not isinstance(proxy_base, str) or not proxy_base.strip():
        return url, headers

    normalized_proxy_base = _normalize_proxy_base(proxy_base)
    if url.startswith(normalized_proxy_base):
        return url, headers

    origin = _browser_origin()
    if origin is not None:
        normalized_origin = origin.rstrip("/")
        if url == normalized_origin or url.startswith(f"{normalized_origin}/"):
            return url, headers

    next_headers = dict(headers)
    next_headers["x-requested-with"] = "litellm-pyodide"
    return f"{normalized_proxy_base}{url}", next_headers


def set_runtime_config(config: dict[str, Any] | None = None) -> None:
    if isinstance(config, dict):
        _RUNTIME_CONFIG.update(config)


def _filter_payload(kwargs: dict[str, Any], excluded: Iterable[str]) -> dict[str, Any]:
    excluded_set = set(excluded)
    return {
        key: value
        for key, value in kwargs.items()
        if key not in excluded_set and value is not None
    }


def _openai_headers(kwargs: dict[str, Any]) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
    }
    api_key = kwargs.get("api_key")
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    extra_headers = kwargs.get("extra_headers") or {}
    if isinstance(extra_headers, dict):
        headers.update(
            {str(key).lower(): str(value) for key, value in extra_headers.items()}
        )
    return headers


def _anthropic_headers(kwargs: dict[str, Any]) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
        "anthropic-version": str(kwargs.get("api_version") or "2023-06-01"),
    }
    api_key = kwargs.get("api_key")
    if api_key:
        headers["x-api-key"] = str(api_key)
    extra_headers = kwargs.get("extra_headers") or {}
    if isinstance(extra_headers, dict):
        headers.update(
            {str(key).lower(): str(value) for key, value in extra_headers.items()}
        )
    return headers


def _prepare_request(endpoint: str, kwargs: dict[str, Any]) -> _ProviderRequest:
    provider, model = _split_provider_model(
        str(kwargs["model"]),
        explicit_provider=kwargs.get("custom_llm_provider"),
    )
    timeout_seconds = None
    if kwargs.get("timeout") is not None:
        timeout_seconds = float(kwargs["timeout"])
    metadata = (
        kwargs.get("metadata") if isinstance(kwargs.get("metadata"), dict) else {}
    )

    if endpoint == "messages":
        payload = _filter_payload(
            {**kwargs, "model": model, "max_tokens": kwargs.get("max_tokens") or 1024},
            {
                "api_base",
                "api_key",
                "api_version",
                "timeout",
                "custom_llm_provider",
                "extra_headers",
            },
        )
        url = _join_api_base(
            kwargs.get("api_base"),
            "messages",
            "https://api.anthropic.com/v1/messages",
        )
        headers = _anthropic_headers(kwargs)
        url, headers = _apply_cors_buster(url, headers)
        return _ProviderRequest(
            provider="anthropic",
            model=model,
            url=url,
            headers=headers,
            payload=payload,
            timeout_seconds=timeout_seconds,
            metadata=metadata,
        )

    endpoint_map = {
        "chat_completions": "chat/completions",
        "responses": "responses",
        "embeddings": "embeddings",
    }
    payload = _filter_payload(
        {**kwargs, "model": model},
        {
            "api_base",
            "api_key",
            "api_version",
            "timeout",
            "custom_llm_provider",
            "extra_headers",
        },
    )
    url = _join_api_base(
        kwargs.get("api_base"),
        endpoint_map[endpoint],
        f"https://api.openai.com/v1/{endpoint_map[endpoint]}",
    )
    headers = _openai_headers(kwargs)
    url, headers = _apply_cors_buster(url, headers)
    return _ProviderRequest(
        provider=provider,
        model=model,
        url=url,
        headers=headers,
        payload=payload,
        timeout_seconds=timeout_seconds,
        metadata=metadata,
    )


async def _read_response_json(response: Any) -> dict[str, Any]:
    text = await response.string()
    return json.loads(text)


async def _raise_for_failure(
    request: _ProviderRequest, response: Any, body: Any | None = None
) -> None:
    details = body
    if details is None:
        try:
            details = await _read_response_json(response)
        except Exception:
            details = {"status": int(response.status), "body": await response.string()}
    await _dispatch_hook("failure", request.payload, details)
    raise RuntimeError(
        f"{request.provider} request failed with status {int(response.status)}"
    )


def _fetch_options(request: _ProviderRequest) -> dict[str, Any]:
    options: dict[str, Any] = {
        "method": "POST",
        "headers": request.headers,
        "body": json.dumps(request.payload),
    }
    if request.timeout_seconds is not None:
        options["signal"] = AbortSignal.timeout(int(request.timeout_seconds * 1000))
    return options


async def _post_json(request: _ProviderRequest) -> dict[str, Any]:
    await _dispatch_hook(
        "pre_api_call",
        request.payload,
        {"url": request.url, "provider": request.provider},
    )
    response = await pyfetch(
        request.url,
        method="POST",
        headers=request.headers,
        body=json.dumps(request.payload),
    )
    if not response.ok:
        await _raise_for_failure(request, response)
    parsed = await response.json()
    await _dispatch_hook("post_api_call", request.payload, parsed)
    await _dispatch_hook("success", request.payload, parsed)
    return parsed


async def _post_stream(request: _ProviderRequest) -> _SSEStream:
    await _dispatch_hook(
        "pre_api_call",
        request.payload,
        {"url": request.url, "provider": request.provider},
    )
    options = to_js(_fetch_options(request), dict_converter=Object.fromEntries)
    response = await fetch(request.url, options)
    if not response.ok:
        text = await response.text()
        details = (
            json.loads(str(text))
            if str(text).startswith("{")
            else {"status": int(response.status), "body": str(text)}
        )
        await _dispatch_hook("failure", request.payload, details)
        raise RuntimeError(
            f"{request.provider} stream request failed with status {int(response.status)}"
        )
    await _dispatch_hook(
        "post_api_call", request.payload, {"stream": True, "provider": request.provider}
    )
    return _SSEStream(response, request)


async def acompletion(**kwargs: Any) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
    request = _prepare_request("chat_completions", kwargs)
    if kwargs.get("stream"):
        return await _post_stream(request)
    return await _post_json(request)


async def anthropic_messages(
    **kwargs: Any,
) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
    request = _prepare_request("messages", kwargs)
    if kwargs.get("stream"):
        return await _post_stream(request)
    return await _post_json(request)


async def aresponses(**kwargs: Any) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
    request = _prepare_request("responses", kwargs)
    if kwargs.get("stream"):
        return await _post_stream(request)
    return await _post_json(request)


async def aembedding(**kwargs: Any) -> dict[str, Any]:
    request = _prepare_request("embeddings", kwargs)
    return await _post_json(request)
