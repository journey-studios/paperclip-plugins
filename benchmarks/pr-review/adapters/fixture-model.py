"""Deterministic fake backend for integration checks. Its output is never benchmark evidence."""

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

fixture = json.loads(Path("/fixtures/fixture.json").read_text())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        message = f"review:\n  security_concerns: 'No'\n  key_issues_to_review:\n    - relevant_file: '{fixture['file']}'\n      issue_header: 'Synthetic canary'\n      issue_content: 'This fake finding validates replay plumbing only.'\n      start_line: 1\n      end_line: 1\n"
        tool = None
        if body.get("tools"):
            has_result = any(msg.get("role") == "tool" for msg in body["messages"])
            if not has_result:
                tool = {"index": 0, "id": "call_fixture_read", "type": "function", "function": {"name": "read", "arguments": json.dumps({"filePath": "/work/pr/diff.patch"})}}
                message = ""
            else:
                verdict = {"v": 1, "repo": fixture["repo"], "number": fixture["number"], "headSha": fixture["head"], "outcome": "comment", "findings": [{"severity": "minor", "path": fixture["file"], "line": 1, "message": "Synthetic canary finding; no reviewer quality claim"}]}
                message = "<!-- paperclip-review-verdict\n" + json.dumps(verdict) + "\n-->"
        common = {"id": "chatcmpl-fixture", "created": int(time.time()), "model": body["model"]}
        usage = {"prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130}
        self.send_response(200)
        if body.get("stream"):
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            delta = {"role": "assistant", "content": message}
            finish = "stop"
            if tool:
                delta["tool_calls"] = [tool]
                finish = "tool_calls"
            chunks = [{**common, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}, {**common, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage}]
            for chunk in chunks:
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({**common, "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": message}, "finish_reason": "stop"}], "usage": usage}).encode())


HTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
