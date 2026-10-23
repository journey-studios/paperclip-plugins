#!/usr/bin/env python3
"""Private, fixed-operation launcher. Chrome exists only in a bounded ephemeral container."""
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = Path(os.environ.get("PERFORMANCE_DATA", "/srv/data/performance-observatory"))
IMAGE = os.environ.get("PERFORMANCE_IMAGE", "journey-performance-runner:0.1.0")
TOKEN = Path(os.environ["PERFORMANCE_TOKEN_FILE"]).read_text().strip()
BIND = os.environ.get("PERFORMANCE_BIND", "127.0.0.1")
PORT = int(os.environ.get("PERFORMANCE_PORT", "8787"))
ORIGINS = json.loads(os.environ.get("PERFORMANCE_ORIGINS", '{"prod":["https://dash.tessel.app","https://tessel.app"],"staging":["https://dash-staging.tessel.app"],"test":[]}'))
PROFILES = json.loads(os.environ.get("PERFORMANCE_PROFILES", '{}'))
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
lock = threading.Lock()

def write(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")))
    temp.chmod(0o600)
    temp.replace(path)

def read(path):
    return json.loads(path.read_text())

def valid_request(body):
    if not UUID.fullmatch(str(body.get("id", ""))) or not UUID.fullmatch(str(body.get("companyId", ""))):
        raise ValueError("INVALID_ID")
    target = body.get("target", {})
    url = urlsplit(target.get("url", ""))
    origin = f"{url.scheme}://{url.netloc}"
    if url.username or url.password or url.query or url.fragment or url.scheme != "https" or origin not in ORIGINS.get(target.get("environment"), []):
        raise ValueError("TARGET_NOT_ALLOWED")
    if target.get("authProfile", "public") not in ("public", target.get("environment")):
        raise ValueError("AUTH_ENVIRONMENT_MISMATCH")
    start = urlsplit(target.get("startUrl", target.get("url", "")))
    if f"{start.scheme}://{start.netloc}" != origin or start.query or start.fragment:
        raise ValueError("START_URL_NOT_ALLOWED")
    # The body can select a configured profile, never a host path, image, mount or command.
    if target.get("authProfile", "public") not in ("public", "prod", "staging", "test"):
        raise ValueError("PROFILE_NOT_ALLOWED")
    return body

def run_one(folder, state):
    name = "perf-" + state["id"]
    result_file = folder / "result.json"
    try:
        if state["status"] == "queued":
            request = read(folder / "request.json")
            args = ["docker", "run", "-d", "--rm", "--name", name,
                    "--label", "journey.performance=true", "--network", "agents-net",
                    "--cpus=2", "--memory=3g", "--memory-swap=3g", "--pids-limit=512",
                    "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
                    "--shm-size=256m", "-v", f"{folder}:/job:rw"]
            profile = request["target"].get("authProfile", "public")
            if profile != "public":
                path = PROFILES.get(profile)
                if not path or not Path(path).is_dir() or not (Path(path) / "storage-state.json").is_file():
                    raise ValueError("AUTH_PROFILE_NOT_CONFIGURED")
                args += ["-v", f"{path}:/auth:rw"]
            args.append(IMAGE)
            started = subprocess.run(args, capture_output=True, timeout=45)
            if started.returncode:
                raise ValueError("EXECUTOR_START_FAILED")
            state.update(status="running", startedAt=time.time(), executorImage=IMAGE,
                         hostLoadBefore=os.getloadavg()[0])
            write(folder / "state.json", state)
        try:
            subprocess.run(["docker", "wait", name], capture_output=True, timeout=1500)
        except subprocess.TimeoutExpired:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30)
            raise ValueError("EXECUTOR_TIMEOUT")
        if not result_file.is_file():
            raise ValueError("EXECUTOR_INTERRUPTED")
        result = read(result_file)
        if result.get("ok") is not True:
            raise ValueError(result.get("errorCode", "COLLECTION_FAILED"))
        result["result"]["execution"] = {
            "image": state.get("executorImage"), "cpuLimit": 2, "memoryLimitMiB": 3072,
            "hostLoadBefore": state.get("hostLoadBefore"), "hostLoadAfter": os.getloadavg()[0],
            "durationMs": (time.time() - state["startedAt"]) * 1000,
        }
        state.update(status="completed", result=result["result"], finishedAt=time.time())
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r"[A-Z0-9_]{1,80}", code):
            code = "EXECUTOR_ERROR"
        state.update(status="failed", errorCode=code, finishedAt=time.time())
    write(folder / "state.json", state)

def work():
    while True:
        try:
            pending = []
            for folder in ROOT.iterdir():
                if not folder.is_dir() or not UUID.fullmatch(folder.name):
                    continue
                state_file = folder / "state.json"
                if not state_file.exists():
                    continue
                state = read(state_file)
                if state["status"] in ("queued", "running"):
                    pending.append((state.get("createdAt", 0), folder, state))
            pending.sort(key=lambda item: item[0])
            if pending:
                _, folder, state = pending[0]
                run_one(folder, state)
            else:
                time.sleep(2)
        except Exception:
            time.sleep(5)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {"error": "UNAUTHORIZED"})
        parts = urlsplit(self.path)
        if parts.path == "/health":
            return self.reply(200, {"ok": True, "executor": "ephemeral", "schema": "performance-review.v1"})
        match = re.fullmatch(r"/runs/([a-f0-9-]{36})", parts.path)
        company = parse_qs(parts.query).get("companyId", [""])[0]
        if not match or not UUID.fullmatch(match[1]) or not UUID.fullmatch(company):
            return self.reply(400, {"error": "INVALID_REQUEST"})
        file = ROOT / match[1] / "state.json"
        if not file.is_file():
            return self.reply(404, {"error": "RUN_NOT_FOUND"})
        state = read(file)
        if state["companyId"] != company:
            return self.reply(404, {"error": "RUN_NOT_FOUND"})
        self.reply(200, state)

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {"error": "UNAUTHORIZED"})
        if self.path != "/runs":
            return self.reply(404, {"error": "NOT_FOUND"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 16000:
                raise ValueError("INVALID_BODY")
            request = valid_request(json.loads(self.rfile.read(length)))
            with lock:
                folder = ROOT / request["id"]
                state_file = folder / "state.json"
                if state_file.exists():
                    state = read(state_file)
                    if state["companyId"] != request["companyId"]:
                        return self.reply(409, {"error": "RUN_ID_CONFLICT"})
                    return self.reply(200, state)
                queued = sum(1 for path in ROOT.glob("*/state.json") if read(path)["status"] in ("queued", "running"))
                if queued >= 40:
                    return self.reply(429, {"error": "QUEUE_FULL"})
                folder.mkdir(mode=0o700)
                write(folder / "request.json", request)
                state = {"id": request["id"], "companyId": request["companyId"], "status": "queued", "createdAt": time.time()}
                write(state_file, state)
            self.reply(202, state)
        except Exception as error:
            code = str(error)
            if not re.fullmatch(r"[A-Z0-9_]{1,80}", code):
                code = "INVALID_REQUEST"
            self.reply(400, {"error": code})

if __name__ == "__main__":
    threading.Thread(target=work, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
