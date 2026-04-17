from __future__ import annotations


class CustomLogger:
    def log_pre_api_call(self, model, messages, kwargs):
        return None

    def log_post_api_call(self, kwargs, response_obj, start_time, end_time):
        return None

    def log_stream_event(self, kwargs, response_obj, start_time, end_time):
        return None

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        return None

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        return None

    async def async_log_pre_api_call(self, model, messages, kwargs):
        return None

    async def async_log_stream_event(self, kwargs, response_obj, start_time, end_time):
        return None

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        return None

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        return None
