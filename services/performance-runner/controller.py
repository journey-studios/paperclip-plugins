#!/usr/bin/env python3
"""Private, fixed-operation launcher. Chrome exists only in a bounded ephemeral container."""
import hmac
import json
import os
from pathlib import Path
import re
import shutil
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
NETWORK = "journey-performance-egress"
RUNNER_UID = int(os.environ.get("PERFORMANCE_RUNNER_UID", "1001"))
RUNNER_GID = int(os.environ.get("PERFORMANCE_RUNNER_GID", "1001"))
if RUNNER_UID <= 0 or RUNNER_GID <= 0:
    raise ValueError("NON_ROOT_EXECUTOR_REQUIRED")
RETENTION_SECONDS = 7 * 86400
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
lock = threading.Lock()
active = {}

def write(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")))
    temp.chmod(0o600)
    temp.replace(path)

def read(path):
    return json.loads(path.read_text())

def recover_active():
    with lock:
        active.clear()
        for folder in ROOT.iterdir():
            if not folder.is_dir() or not UUID.fullmatch(folder.name):
                continue
            file = folder / "state.json"
            if not file.is_file():
                continue
            state = read(file)
            if state.get("status") in ("queued", "running"):
                active[folder.name] = state

def clean_acknowledged(now):
    removed = 0
    with lock:
        for folder in ROOT.iterdir():
            if not folder.is_dir() or not UUID.fullmatch(folder.name) or folder.name in active:
                continue
            file = folder / "state.json"
            if not file.is_file():
                continue
            state = read(file)
            acknowledged = state.get("acknowledgedAt")
            if state.get("status") not in ("completed", "failed") or not isinstance(acknowledged, (int, float)):
                continue
            if now - acknowledged < RETENTION_SECONDS:
                continue
            # Only remove delivery files after Paperclip confirms that its durable history is saved.
            shutil.rmtree(folder)
            removed += 1
    return removed

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
                    "--label", "journey.performance=true", "--network", NETWORK,
                    "--user", f"{RUNNER_UID}:{RUNNER_GID}",
                    "--cpus=2", "--memory=3g", "--memory-swap=3g", "--pids-limit=512",
                    "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
                    "--shm-size=256m", "-v", f"{folder}:/job:rw"]
            profile = request["target"].get("authProfile", "public")
            if profile != "public":
                path = PROFILES.get(profile)
                if not path or not Path(path).is_dir() or not (Path(path) / "storage-state.json").is_file():
                    raise ValueError("AUTH_PROFILE_NOT_CONFIGURED")
                os.chown(path, RUNNER_UID, RUNNER_GID)
                os.chown(Path(path) / "storage-state.json", RUNNER_UID, RUNNER_GID)
                args += ["-v", f"{path}:/auth:rw"]
            os.chown(folder, RUNNER_UID, RUNNER_GID)
            os.chown(folder / "request.json", RUNNER_UID, RUNNER_GID)
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
    next_cleanup = 0
    while True:
        try:
            if time.time() >= next_cleanup:
                clean_acknowledged(time.time())
                next_cleanup = time.time() + 86400
            with lock:
                pending = [(state.get("createdAt", 0), ROOT / identifier, state) for identifier, state in active.items()]
            pending.sort(key=lambda item: item[0])
            if pending:
                _, folder, state = pending[0]
                run_one(folder, state)
                if state["status"] not in ("queued", "running"):
                    with lock:
                        active.pop(folder.name, None)
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
        ack = re.fullmatch(r"/runs/([a-f0-9-]{36})/ack", self.path)
        if self.path != "/runs" and not ack:
            return self.reply(404, {"error": "NOT_FOUND"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 16000:
                raise ValueError("INVALID_BODY")
            body = json.loads(self.rfile.read(length))
            if ack:
                company = body.get("companyId", "")
                if not UUID.fullmatch(ack[1]) or not UUID.fullmatch(str(company)):
                    raise ValueError("INVALID_ID")
                with lock:
                    file = ROOT / ack[1] / "state.json"
                    if not file.is_file():
                        return self.reply(404, {"error": "RUN_NOT_FOUND"})
                    state = read(file)
                    if state["companyId"] != company:
                        return self.reply(404, {"error": "RUN_NOT_FOUND"})
                    if state["status"] not in ("completed", "failed"):
                        return self.reply(409, {"error": "RUN_NOT_TERMINAL"})
                    state.setdefault("acknowledgedAt", time.time())
                    write(file, state)
                    active.pop(ack[1], None)
                return self.reply(200, {"ok": True})
            request = valid_request(body)
            with lock:
                folder = ROOT / request["id"]
                state_file = folder / "state.json"
                if state_file.exists():
                    state = read(state_file)
                    if state["companyId"] != request["companyId"]:
                        return self.reply(409, {"error": "RUN_ID_CONFLICT"})
                    return self.reply(200, state)
                if len(active) >= 40:
                    return self.reply(429, {"error": "QUEUE_FULL"})
                folder.mkdir(mode=0o700)
                write(folder / "request.json", request)
                state = {"id": request["id"], "companyId": request["companyId"], "status": "queued", "createdAt": time.time()}
                write(state_file, state)
                active[state["id"]] = state
            self.reply(202, state)
        except Exception as error:
            code = str(error)
            if not re.fullmatch(r"[A-Z0-9_]{1,80}", code):
                code = "INVALID_REQUEST"
            self.reply(400, {"error": code})

if __name__ == "__main__":
    recover_active()
    threading.Thread(target=work, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
