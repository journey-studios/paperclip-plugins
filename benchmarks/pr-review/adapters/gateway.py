"""Model-only proxy for disposable review containers. Never logs credentials or prompts."""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Gateway:
    def __init__(self, config, journal, key):
        self.config = config
        self.journal = Path(journal)
        self.key = key
        self.calls = 0
        self.lock = threading.Lock()
        self.opener = urllib.request.build_opener(NoRedirect)

    def record(self, event):
        with self.lock:
            with self.journal.open("a") as stream:
                stream.write(json.dumps(event) + "\n")

    def validate(self, body):
        if body.get("model") != self.config["requestModel"]:
            raise ValueError("unfrozen_model")
        if "web_search_options" in body or any(tool.get("type") != "function" for tool in body.get("tools", [])):
            raise ValueError("hosted_tools_denied")
        for message in body.get("messages", []):
            content = message.get("content")
            if isinstance(content, list) and any(part.get("type") != "text" for part in content):
                raise ValueError("remote_media_denied")
        with self.lock:
            if self.calls >= self.config["maxRequests"]:
                raise ValueError("request_budget_exhausted")
            self.calls += 1
            attempt = self.calls
        body.pop("max_completion_tokens", None)
        body["max_tokens"] = self.config["maxOutputTokens"]
        if body.get("stream"):
            body["stream_options"] = {"include_usage": True}
        return attempt

    def forward(self, body):
        attempt = self.validate(body)
        started = time.monotonic()
        self.record({"event": "started", "attempt": attempt})
        try:
            request = urllib.request.Request(
                self.config["upstream"].rstrip("/") + "/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.key},
            )
            with self.opener.open(request, timeout=self.config["timeoutSeconds"]) as response:
                raw = response.read(32 * 1024 * 1024 + 1)
            if len(raw) > 32 * 1024 * 1024:
                raise ValueError("oversized_response")
            chunks = []
            content_type = "application/json"
            if body.get("stream"):
                chunks = [json.loads(line[6:]) for line in raw.decode().splitlines() if line.startswith("data: ") and line[6:].strip() != "[DONE]"]
                content_type = "text/event-stream"
            else:
                chunks = [json.loads(raw)]
            models = sorted({chunk["model"] for chunk in chunks if chunk.get("model")})
            if models != [self.config["effectiveModel"]]:
                raise ValueError("response_model_drift")
            raw_usage = next((chunk["usage"] for chunk in reversed(chunks) if chunk.get("usage")), None)
            usage = None
            if raw_usage:
                usage = {key: raw_usage.get(key) for key in ["prompt_tokens", "completion_tokens", "total_tokens"] if isinstance(raw_usage.get(key), int)}
                cached = raw_usage.get("prompt_tokens_details", {}).get("cached_tokens")
                if isinstance(cached, int):
                    usage["cached_tokens"] = cached
            finish = [choice.get("finish_reason") for chunk in chunks for choice in chunk.get("choices", []) if choice.get("finish_reason")]
            self.record({"event": "finished", "attempt": attempt, "model": models[0], "usage": usage, "finishReasons": finish, "durationMs": round((time.monotonic() - started) * 1000)})
            return raw, content_type
        except Exception:
            self.record({"event": "failed", "attempt": attempt, "durationMs": round((time.monotonic() - started) * 1000)})
            raise


def handler_for(gateway):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, code, body, content_type="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/healthz":
                self.reply(200, b'{"ok":true}')
                return
            if self.path == "/v1/models":
                self.reply(200, json.dumps({"object": "list", "data": [{"id": gateway.config["requestModel"], "object": "model", "owned_by": "benchmark"}]}).encode())
                return
            self.reply(403, b'{"error":{"message":"endpoint_denied"}}')

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.reply(403, b'{"error":{"message":"endpoint_denied"}}')
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > gateway.config["maxInputBytes"]:
                    raise ValueError("input_limit")
                body = json.loads(self.rfile.read(size))
                raw, content_type = gateway.forward(body)
                self.reply(200, raw, content_type)
            except ValueError:
                self.reply(422, b'{"error":{"message":"benchmark_policy_or_model_validation_failed"}}')
            except Exception:
                self.reply(502, b'{"error":{"message":"upstream_failed_details_withheld"}}')

    return Handler


if __name__ == "__main__":
    config = json.loads(Path("/config/gateway.json").read_text())
    proxy = Gateway(config, "/out/requests.jsonl", os.environ["RB_GATEWAY_KEY"])
    ThreadingHTTPServer(("0.0.0.0", 8080), handler_for(proxy)).serve_forever()
