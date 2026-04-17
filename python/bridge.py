from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

import litellm
from litellm.integrations.custom_logger import CustomLogger


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(inner) for key, inner in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(inner) for inner in value]
    if hasattr(value, "model_dump"):
        return _json_safe(value.model_dump())
    if hasattr(value, "dict"):
        return _json_safe(value.dict())
    if hasattr(value, "__dict__"):
        return _json_safe(vars(value))
    return str(value)


def _emit(payload: dict[str, Any]) -> None:
    import js

    js.__litellmEmit(json.dumps(_json_safe(payload)))


def _debug(message: str, payload: Any = None) -> None:
    import js

    if payload is None:
        js.__litellmDebug(message)
        return
    js.__litellmDebug(f"{message} {json.dumps(_json_safe(payload))}")


def _request_context(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    metadata = payload.get("metadata") or {}
    if not isinstance(metadata, dict):
        return None, None
    request_id = metadata.get("litellm_pyodide_request_id")
    endpoint = metadata.get("litellm_pyodide_endpoint")
    return request_id, endpoint


def _json_response(value: Any) -> str:
    return json.dumps(_json_safe(value))


def _emit_stream_chunk(
    request_id: str | None, endpoint: str | None, chunk: Any
) -> None:
    _emit(
        {
            "type": "stream_chunk",
            "requestId": request_id,
            "endpoint": endpoint,
            "chunk": _json_safe(chunk),
        }
    )


class PyodideCallbackLogger(CustomLogger):
    def _emit_hook(
        self, hook: str, kwargs: dict[str, Any], payload: Any = None
    ) -> None:
        request_id, endpoint = _request_context(kwargs)
        details = _json_safe(payload if payload is not None else kwargs)
        _debug(
            f"callback:{hook}",
            {"requestId": request_id, "endpoint": endpoint},
        )
        _emit(
            {
                "type": "callback",
                "hook": hook,
                "requestId": request_id,
                "endpoint": endpoint,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "payloadKind": endpoint or "unknown",
                "model": kwargs.get("model"),
                "response_cost": kwargs.get("response_cost"),
                "details": details,
            }
        )

    def log_pre_api_call(self, model, messages, kwargs):
        self._emit_hook("pre_api_call", kwargs, {"model": model, "messages": messages})

    def log_post_api_call(self, kwargs, response_obj, start_time, end_time):
        self._emit_hook(
            "post_api_call",
            kwargs,
            {
                "response": response_obj,
                "start_time": start_time,
                "end_time": end_time,
            },
        )

    def log_stream_event(self, kwargs, response_obj, start_time, end_time):
        self._emit_hook(
            "stream_event",
            kwargs,
            {
                "response": response_obj,
                "start_time": start_time,
                "end_time": end_time,
            },
        )

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._emit_hook(
            "success",
            kwargs,
            {
                "response": response_obj,
                "start_time": start_time,
                "end_time": end_time,
            },
        )

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._emit_hook(
            "failure",
            kwargs,
            {
                "response": response_obj,
                "start_time": start_time,
                "end_time": end_time,
            },
        )


_CALLBACK_LOGGER = PyodideCallbackLogger()


async def bootstrap() -> str:
    _debug("bootstrap")
    litellm.callbacks = [_CALLBACK_LOGGER]
    litellm.input_callback = [_CALLBACK_LOGGER]
    litellm.success_callback = [_CALLBACK_LOGGER]
    litellm.failure_callback = [_CALLBACK_LOGGER]
    return json.dumps(
        {
            "bridge": "bridge.py",
            "litellm_version": getattr(litellm, "__version__", "unknown"),
        }
    )


async def _stream_result(request: dict[str, Any], iterator: Any) -> str:
    request_id, endpoint = _request_context(request)
    chunk_count = 0
    last_chunk = None
    async for chunk in iterator:
        chunk_count += 1
        last_chunk = _json_safe(chunk)
        _emit_stream_chunk(request_id, endpoint, last_chunk)
    return json.dumps(
        {"streamed": True, "chunk_count": chunk_count, "last_chunk": last_chunk}
    )


async def chat_completions_create(request: dict[str, Any]) -> str:
    response = await litellm.acompletion(**request)
    return _json_response(response)


async def chat_completions_stream(request: dict[str, Any]) -> str:
    stream = await litellm.acompletion(**request)
    return await _stream_result(request, stream)


async def messages_create(request: dict[str, Any]) -> str:
    response = await litellm.anthropic_messages(**request)
    return _json_response(response)


async def messages_stream(request: dict[str, Any]) -> str:
    stream = await litellm.anthropic_messages(**request)
    return await _stream_result(request, stream)


async def responses_create(request: dict[str, Any]) -> str:
    if request.get("stream"):
        stream = await litellm.aresponses(**request)
        return await _stream_result(request, stream)
    response = await litellm.aresponses(**request)
    return _json_response(response)


async def embeddings_create(request: dict[str, Any]) -> str:
    response = await litellm.aembedding(**request)
    return _json_response(response)
