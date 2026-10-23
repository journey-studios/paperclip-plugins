import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("gateway", Path(__file__).with_name("gateway.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Backend:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return io.BytesIO(self.response)


class GatewaySpec(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "requests.jsonl"
        self.config = {"requestModel": "route/model-v1", "effectiveModel": "model-v1", "maxRequests": 2, "maxOutputTokens": 20, "maxInputBytes": 1000, "timeoutSeconds": 5, "upstream": "http://provider/v1"}
        self.gateway = module.Gateway(self.config, self.path, "fixture-secret-never-log")
        self.backend = Backend(json.dumps({"model": "model-v1", "choices": [{"finish_reason": "stop"}], "usage": {"prompt_tokens": 12, "completion_tokens": 3, "raw_prompt": "must-not-log"}}).encode())
        self.gateway.opener = self.backend

    def tearDown(self):
        self.temp.cleanup()

    def body(self):
        return {"model": "route/model-v1", "messages": [{"role": "user", "content": "private-code-not-in-journal"}]}

    def test_limits_are_enforced_before_another_upstream_request(self):
        self.gateway.forward(self.body())
        self.gateway.forward(self.body())
        with self.assertRaisesRegex(ValueError, "budget_exhausted"):
            self.gateway.forward(self.body())
        self.assertEqual(len(self.backend.requests), 2)
        sent = json.loads(self.backend.requests[0].data)
        self.assertEqual(sent["max_tokens"], 20)

    def test_model_substitution_and_hosted_tools_never_reach_backend(self):
        for body in [{**self.body(), "model": "auto/pool"}, {**self.body(), "tools": [{"type": "web_search"}]}, {**self.body(), "web_search_options": {}}, {**self.body(), "messages": [{"content": [{"type": "image_url", "image_url": {"url": "https://github.com/future/fix"}}]}]}]:
            with self.assertRaises(ValueError):
                self.gateway.forward(body)
        self.assertEqual(len(self.backend.requests), 0)

    def test_step_limit_instruction_does_not_fabricate_or_discard_model_reasoning(self):
        self.config["normalizeStepLimitRole"] = True
        original = {"role": "assistant", "content": "Observed tool response", "reasoning_content": "fixture-reasoning"}
        notice = {"role": "assistant", "content": "CRITICAL - MAXIMUM STEPS REACHED\nConclude now", "reasoning_content": ""}
        body = {**self.body(), "messages": [original, notice], "tools": [{"type": "function", "function": {"name": "read"}}]}
        self.gateway.forward(body)
        sent = json.loads(self.backend.requests[0].data)
        self.assertEqual(sent["messages"][0], original)
        self.assertEqual(sent["messages"][1], {"role": "user", "content": notice["content"]})
        self.assertEqual(sent["tool_choice"], "none")
        untouched = {**notice, "role": "assistant", "reasoning_content": "real-model-reasoning"}
        self.gateway.forward({**self.body(), "messages": [untouched]})
        self.assertEqual(json.loads(self.backend.requests[1].data)["messages"], [untouched])

    def test_response_model_drift_is_recorded_as_failed(self):
        self.backend.response = b'{"model":"another-model","choices":[]}'
        with self.assertRaisesRegex(ValueError, "response_model_drift"):
            self.gateway.forward(self.body())
        self.assertEqual([json.loads(line)["event"] for line in self.path.read_text().splitlines()], ["started", "failed"])

    def test_journal_keeps_usage_without_credentials_prompts_or_arbitrary_fields(self):
        self.gateway.forward(self.body())
        journal = self.path.read_text()
        for text in ["fixture-secret", "private-code", "raw_prompt", "must-not-log"]:
            self.assertNotIn(text, journal)
        event = json.loads(journal.splitlines()[-1])
        self.assertEqual(event["usage"], {"prompt_tokens": 12, "completion_tokens": 3})

    def test_stream_model_and_usage_are_verified_before_forwarding(self):
        self.backend.response = b'data: {"model":"model-v1","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"model":"model-v1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
        body = {**self.body(), "stream": True}
        raw, content_type = self.gateway.forward(body)
        self.assertEqual(content_type, "text/event-stream")
        self.assertIn(b"[DONE]", raw)
        self.assertEqual(json.loads(self.path.read_text().splitlines()[-1])["usage"]["prompt_tokens"], 11)

    def test_upstream_failure_still_consumes_request_budget(self):
        self.backend.response = b"invalid-provider-response"
        for _ in range(2):
            with self.assertRaises(ValueError):
                self.gateway.forward(self.body())
        with self.assertRaisesRegex(ValueError, "budget_exhausted"):
            self.gateway.forward(self.body())
        self.assertEqual(len(self.backend.requests), 2)

    def test_empty_gateway_heartbeats_are_not_a_second_model(self):
        heartbeat = {"model": "keepalive", "choices": [{"delta": {}, "finish_reason": None}]}
        answer = {"model": "model-v1", "choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 11, "completion_tokens": 2}}
        self.backend.response = ("data: " + json.dumps(heartbeat) + "\n\ndata: " + json.dumps(answer) + "\n\ndata: [DONE]\n\n").encode()
        self.gateway.forward({**self.body(), "stream": True})
        self.assertEqual(json.loads(self.path.read_text().splitlines()[-1])["model"], "model-v1")
        heartbeat["choices"][0]["delta"] = {"content": "a real answer must not be ignored"}
        self.backend.response = ("data: " + json.dumps(heartbeat) + "\n\ndata: " + json.dumps(answer) + "\n\n").encode()
        with self.assertRaisesRegex(ValueError, "response_model_drift"):
            self.gateway.forward({**self.body(), "stream": True})


if __name__ == "__main__":
    unittest.main()
