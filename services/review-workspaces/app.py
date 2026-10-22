"""Prepares a git worktree of a pull request at its exact head commit, for the reviewer agent to read.

Why a service: the reviewer agent has no checkout of the repository and must not hold GitHub credentials. The
plugin hands this service a short-lived, read-only installation token per request; the token only lives in the
environment of the git commands (never in argv, URLs or on disk), and is dropped when the job ends.

Why the same path inside this container and the agent's: a worktree's `.git` file points at its mirror by
absolute path, so both containers mount the volume at WORKSPACES_ROOT.

Layout under WORKSPACES_ROOT:
  .mirrors/<owner>/<repo>.git        bare, shallow mirror per repository
  <owner>__<repo>/<number>-<sha12>   detached worktree at the head commit
  <owner>__<repo>/<number>-<sha12>.ready   "ok" or "error: ..." once the job ends
Worktrees are removed after WORKSPACE_TTL_HOURS; there is no other cleanup to call.
"""

import asyncio
import base64
import hmac
import os
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("WORKSPACES_ROOT", "/paperclip/review-worktrees"))
REMOTE_URL = os.environ.get("REMOTE_URL_TEMPLATE", "https://github.com/{repo}.git")
TTL_SECONDS = int(os.environ.get("WORKSPACE_TTL_HOURS", "24")) * 3600
MAX_WORKTREES = int(os.environ.get("MAX_WORKTREES", "40"))
FETCH_DEPTH = int(os.environ.get("FETCH_DEPTH", "200"))
GIT_TIMEOUT_SECONDS = int(os.environ.get("GIT_TIMEOUT_SECONDS", "600"))
MAX_QUEUED = 20
SWEEP_INTERVAL_SECONDS = 600

SERVICE_TOKEN = os.environ.get("REVIEW_WORKSPACES_TOKEN", "")
if len(SERVICE_TOKEN) < 24:
    raise RuntimeError("REVIEW_WORKSPACES_TOKEN must be set (at least 24 characters)")


class WorkspaceRequest(BaseModel):
    repo: str = Field(pattern=r"^[A-Za-z0-9_][\w.-]*/[A-Za-z0-9_][\w.-]*$", max_length=200)  # no leading dot: no "..", no hidden dirs
    number: int = Field(gt=0)
    head_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    token: str = Field(min_length=10, max_length=400)


def worktree_path(repo: str, number: int, sha: str) -> Path:
    owner, name = repo.lower().split("/")
    return ROOT / f"{owner}__{name}" / f"{number}-{sha[:12]}"


def marker_path(path: Path) -> Path:
    return path.with_name(path.name + ".ready")


def mirror_path(repo: str) -> Path:
    owner, name = repo.lower().split("/")
    return ROOT / ".mirrors" / owner / f"{name}.git"


def read_marker(path: Path) -> Optional[str]:
    try:
        return marker_path(path).read_text().strip()
    except FileNotFoundError:
        return None


def write_marker(path: Path, text: str) -> None:
    # Written atomically: the reviewer waits for this file and must never read half of it.
    marker = marker_path(path)
    tmp = marker.with_name(marker.name + ".tmp")
    tmp.write_text(text + "\n")
    tmp.replace(marker)


def auth_env(token: str) -> dict[str, str]:
    """Git reads the header from the environment, so the token never appears in argv or in the mirror's config."""
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}",
    }


class GitError(RuntimeError):
    pass


async def git(*args: str, cwd: Optional[Path] = None, env: Optional[dict[str, str]] = None) -> str:
    process = await asyncio.create_subprocess_exec(
        "git", *args, cwd=cwd, env=env or {**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout=GIT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        raise GitError(f"git {args[0]} timed out")
    if process.returncode != 0:
        raise GitError(f"git {args[0]} failed: {err.decode(errors='replace').strip()[:300]}")
    return out.decode(errors="replace")


async def has_commit(mirror: Path, sha: str) -> bool:
    try:
        await git("cat-file", "-e", f"{sha}^{{commit}}", cwd=mirror)
        return True
    except GitError:
        return False


async def prepare(request: WorkspaceRequest) -> None:
    path = worktree_path(request.repo, request.number, request.head_sha)
    mirror = mirror_path(request.repo)
    env = auth_env(request.token)
    if not (mirror / "HEAD").exists():
        mirror.mkdir(parents=True, exist_ok=True)
        await git("init", "--bare", "--quiet", cwd=mirror)
        await git("remote", "add", "origin", REMOTE_URL.format(repo=request.repo), cwd=mirror)
    # `pull/N/head` also covers pull requests from forks; the exact SHA is fetched when the ref has moved on.
    await git("fetch", "--quiet", "--no-tags", f"--depth={FETCH_DEPTH}", "origin",
              f"+refs/pull/{request.number}/head:refs/pull/{request.number}/head", cwd=mirror, env=env)
    if not await has_commit(mirror, request.head_sha):
        await git("fetch", "--quiet", "--no-tags", f"--depth={FETCH_DEPTH}", "origin", request.head_sha, cwd=mirror, env=env)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        # Left over by a job that died before writing its marker.
        await remove_worktree(mirror, path)
    await git("worktree", "add", "--quiet", "--detach", str(path), request.head_sha, cwd=mirror)


async def remove_worktree(mirror: Path, path: Path) -> None:
    if not (mirror / "HEAD").exists():
        shutil.rmtree(path, ignore_errors=True)
        return
    try:
        await git("worktree", "remove", "--force", str(path), cwd=mirror)
    except GitError:
        shutil.rmtree(path, ignore_errors=True)
    await git("worktree", "prune", cwd=mirror)


def _scrub(message: str, token: str) -> str:
    return message.replace(token, "<token>")[:400]


queue: "asyncio.Queue[WorkspaceRequest]" = asyncio.Queue()
pending: set[str] = set()


async def worker() -> None:
    while True:
        request = await queue.get()
        path = worktree_path(request.repo, request.number, request.head_sha)
        try:
            # Before anything can fail: the error marker needs this directory too.
            path.parent.mkdir(parents=True, exist_ok=True)
            await prepare(request)
            write_marker(path, "ok")
        except Exception as error:  # noqa: BLE001 - reported to the reviewer through the marker, never raised
            try:
                write_marker(path, _scrub(f"error: {type(error).__name__}: {error}", request.token))
            except OSError:
                pass  # the worker must survive; the reviewer's wait times out and the package says to go diff-only
        finally:
            request.token = ""
            pending.discard(str(path))
            queue.task_done()


def _worktrees() -> list[Path]:
    return [m.with_name(m.name.removesuffix(".ready")) for m in ROOT.glob("*__*/*.ready")]


async def sweep(now: Optional[float] = None) -> int:
    """Removes expired worktrees, then the oldest ones beyond MAX_WORKTREES. Returns how many were removed."""
    now = now or time.time()
    entries = sorted(_worktrees(), key=lambda p: marker_path(p).stat().st_mtime, reverse=True)
    removed = 0
    for index, path in enumerate(entries):
        if str(path) in pending:
            continue
        if now - marker_path(path).stat().st_mtime <= TTL_SECONDS and index < MAX_WORKTREES:
            continue
        owner, name = path.parent.name.split("__", 1)
        await remove_worktree(ROOT / ".mirrors" / owner / f"{name}.git", path)
        marker_path(path).unlink(missing_ok=True)
        removed += 1
    return removed


async def sweeper() -> None:
    while True:
        try:
            await sweep()
        except Exception:  # noqa: BLE001 - a failed sweep is retried on the next tick
            pass
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def require_auth(authorization: str = Header(default="")) -> None:
    supplied = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied.encode(), SERVICE_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global queue
    queue = asyncio.Queue()
    ROOT.mkdir(parents=True, exist_ok=True)
    tasks = [asyncio.create_task(worker()), asyncio.create_task(sweeper())]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


app = FastAPI(title="review-workspaces", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "queued": queue.qsize()}


@app.post("/v1/workspaces", status_code=202, dependencies=[Depends(require_auth)])
async def submit(request: WorkspaceRequest) -> dict[str, str]:
    path = worktree_path(request.repo, request.number, request.head_sha)
    marker = read_marker(path)
    if marker == "ok" or str(path) in pending:
        return {"path": str(path), "marker": str(marker_path(path)), "status": "ready" if marker == "ok" else "preparing"}
    if queue.qsize() >= MAX_QUEUED:
        raise HTTPException(status_code=429, detail="queue is full")
    # A failed earlier attempt is retried: its marker goes away so the reviewer waits for the new one.
    marker_path(path).unlink(missing_ok=True)
    pending.add(str(path))
    queue.put_nowait(request)
    return {"path": str(path), "marker": str(marker_path(path)), "status": "preparing"}
