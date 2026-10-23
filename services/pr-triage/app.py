"""Authenticated, asynchronous wrapper around PR-Agent's reviewer.

Why asynchronous: a review takes minutes and the caller (a Paperclip plugin) cannot hold a request that long.
Why one job at a time: PR-Agent keeps its settings (including the GitHub token) in process-wide state.

The service never publishes anything to GitHub. It receives a short-lived, read-only token per job, runs the
reviewer with `publish_output=false`, and returns the parsed prediction as JSON, together with the repository's
risk radar hits (see repo_rules.py).
"""

import asyncio
import hashlib
import hmac
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from itertools import islice
from typing import Any, Optional

import yaml
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from repo_rules import SETTINGS_FILE, RepoRules, applied, evaluate_radar, load_repo_rules, reviewer_overrides

JOB_TTL_SECONDS = 3600
# The radar only needs paths and patches; GitHub stops listing files at 3000 anyway.
MAX_RADAR_FILES = 300
JOB_TIMEOUT_SECONDS = int(os.environ.get("TRIAGE_JOB_TIMEOUT_SECONDS", "900"))
MAX_QUEUED = int(os.environ.get("TRIAGE_MAX_QUEUED", "20"))
MAX_ISSUES = 8
MAX_TEXT = 1500

SERVICE_TOKEN = os.environ.get("PR_TRIAGE_TOKEN", "")
if len(SERVICE_TOKEN) < 24:
    raise RuntimeError("PR_TRIAGE_TOKEN must be set (at least 24 characters)")



class TriageRequest(BaseModel):
    repo: str = Field(pattern=r"^[\w.-]+/[\w.-]+$", max_length=200)
    number: int = Field(gt=0)
    head_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    token: str = Field(min_length=10, max_length=400)


class Job:
    def __init__(self, job_id: str, request: TriageRequest):
        self.id = job_id
        self.request = request
        self.status = "queued"
        self.result: Optional[dict[str, Any]] = None
        self.error: Optional[str] = None
        self.created = time.time()


jobs: dict[str, Job] = {}
# Created with the application (an asyncio.Queue is bound to one event loop).
queue: "asyncio.Queue[Job]" = asyncio.Queue()


def require_auth(authorization: str = Header(default="")) -> None:
    supplied = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied.encode(), SERVICE_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


def job_id_for(request: TriageRequest) -> str:
    key = f"{request.repo.lower()}#{request.number}@{request.head_sha}"
    return hashlib.sha256(key.encode()).hexdigest()[:20]


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:MAX_TEXT]


def parse_prediction(prediction: Optional[str]) -> dict[str, Any]:
    """Turns PR-Agent's YAML answer into a small, bounded, JSON-safe structure."""
    if not prediction:
        raise ValueError("empty prediction")
    body = re.sub(r"^```(?:yaml)?\s*|\s*```\s*$", "", prediction.strip(), flags=re.IGNORECASE)
    data = yaml.safe_load(body)
    review = data.get("review") if isinstance(data, dict) else None
    if not isinstance(review, dict):
        raise ValueError("prediction has no review section")
    issues = []
    for item in (review.get("key_issues_to_review") or [])[:MAX_ISSUES]:
        if not isinstance(item, dict):
            continue
        issues.append(
            {
                "file": _text(item.get("relevant_file")),
                "header": _text(item.get("issue_header")),
                "content": _text(item.get("issue_content")),
                "start_line": item.get("start_line") if isinstance(item.get("start_line"), int) else None,
                "end_line": item.get("end_line") if isinstance(item.get("end_line"), int) else None,
            }
        )
    effort = review.get("estimated_effort_to_review_[1-5]")
    effort_match = re.search(r"[1-5]", str(effort or ""))
    return {
        "effort": int(effort_match.group()) if effort_match else None,
        "relevant_tests": _text(review.get("relevant_tests")),
        "security_concerns": _text(review.get("security_concerns")),
        "key_issues": issues,
    }


def fetch_repo_context(request: TriageRequest) -> tuple[RepoRules, list[tuple[str, str]]]:
    """Reads the repository's rules (default branch) and the pull request's patches. Blocking: run it in a thread."""
    from github import Github, GithubException, UnknownObjectException

    repo = Github(login_or_token=request.token, per_page=100).get_repo(request.repo)
    try:
        rules = load_repo_rules(repo.get_contents(SETTINGS_FILE).decoded_content)
    except UnknownObjectException:
        rules = load_repo_rules(None)
    except GithubException as error:
        # Reported in the result, so a token without Contents access shows up instead of silently using defaults.
        rules = RepoRules(status=f"unreadable: GitHub {error.status}")
    files = [(f.filename, f.patch or "") for f in islice(repo.get_pull(request.number).get_files(), MAX_RADAR_FILES)]
    return rules, files


async def run_review(request: TriageRequest) -> dict[str, Any]:
    """Runs PR-Agent's reviewer without publishing. Imported lazily so tests do not need PR-Agent."""
    from pr_agent.config_loader import get_settings
    runtime = configure_runtime()
    from pr_agent.tools.pr_reviewer import PRReviewer

    rules, files = await asyncio.to_thread(fetch_repo_context, request)
    radar = evaluate_radar(rules.radar, files)
    settings = get_settings()
    settings.set("GITHUB.USER_TOKEN", request.token)
    settings.set("CONFIG.PUBLISH_OUTPUT", False)
    settings.set("CONFIG.PUBLISH_OUTPUT_PROGRESS", False)
    try:
        with applied(settings, reviewer_overrides(rules, settings)):
            reviewer = PRReviewer(f"https://github.com/{request.repo}/pull/{request.number}", args=[])
            if reviewer.git_provider.pr.head.sha != request.head_sha:
                raise ValueError("pull request head changed before triage")
            await reviewer.run()
            prediction = reviewer.prediction
            coverage = review_coverage(reviewer, settings)
    finally:
        settings.set("GITHUB.USER_TOKEN", "")
    return {**parse_prediction(prediction), "radar": radar, "repo_rules": rules.status, "coverage": coverage, "runtime": runtime}


def configure_runtime() -> dict[str, Any]:
    from pr_agent.config_loader import get_settings
    from pr_agent.log import get_logger
    from pr_agent.algo.utils import get_max_tokens

    settings = get_settings()
    level = str(settings.get("CONFIG.LOG_LEVEL") or "INFO").upper()
    if level not in ("INFO", "WARNING", "ERROR", "CRITICAL"):
        raise ValueError("CONFIG.LOG_LEVEL must be INFO or higher; DEBUG exposes review content")
    logger = get_logger()
    logger.remove()
    # Exception diagnostics can expose local prompts/tokens even above DEBUG.
    logger.add(sys.stdout, level=level, diagnose=False, backtrace=False)
    model = settings.get("CONFIG.MODEL")
    return {"configured_model": model, "resolved_model": None, "effective_max_tokens": get_max_tokens(model),
            "log_level": level, "cost_usd": None, "billing": "unknown"}


def summarize_coverage(rendered: str, complete: str, changed: list[str]) -> dict[str, Any]:
    represented = set(re.findall(r"^## File: '(.+)'\s*$", rendered, re.MULTILINE))
    missing = sorted(set(changed) - represented)
    truncated = rendered != complete
    status = "partial"
    if rendered and not truncated and not missing and represented == set(changed):
        status = "complete"
    return {"status": status, "context_truncated": truncated, "reviewed_files": len(represented),
            "total_files": len(set(changed)), "missing_files": missing[:20], "rendered_diff_bytes": len(rendered.encode())}


def review_coverage(reviewer, settings) -> dict[str, Any]:
    from pr_agent.algo.language_handler import sort_files_by_main_languages
    from pr_agent.algo.pr_processing import cap_and_log_extra_lines, pr_generate_extended_diff

    try:
        # Render the uncapped diff through the same upstream renderer, without its pruning step.
        # Raising a custom cap would not uncap models with a built-in maximum.
        provider = reviewer.git_provider
        languages = sort_files_by_main_languages(provider.get_languages(), provider.get_diff_files())
        patches, _, _ = pr_generate_extended_diff(
            languages, reviewer.token_handler, True,
            patch_extra_lines_before=cap_and_log_extra_lines(settings.get("CONFIG.PATCH_EXTRA_LINES_BEFORE"), "before"),
            patch_extra_lines_after=cap_and_log_extra_lines(settings.get("CONFIG.PATCH_EXTRA_LINES_AFTER"), "after"))
        complete = "\n".join(patches)
        return summarize_coverage(reviewer.patches_diff or "", complete, reviewer.git_provider.get_files())
    except Exception as error:
        # A measurement failure is explicit missing evidence, never "complete" coverage.
        return {"status": "unknown", "measurement_error": type(error).__name__}


def _scrub(message: str, token: str) -> str:
    return message.replace(token, "<token>")[:400]


async def worker() -> None:
    while True:
        job = await queue.get()
        job.status = "running"
        try:
            job.result = await asyncio.wait_for(run_review(job.request), timeout=JOB_TIMEOUT_SECONDS)
            job.status = "done"
        except Exception as error:  # noqa: BLE001 - the failure is reported to the caller, never raised
            job.status = "failed"
            job.error = _scrub(f"{type(error).__name__}: {error}", job.request.token)
        finally:
            job.request.token = ""
            queue.task_done()


def _purge_expired() -> None:
    cutoff = time.time() - JOB_TTL_SECONDS
    for job_id in [j.id for j in jobs.values() if j.created < cutoff and j.status in ("done", "failed")]:
        jobs.pop(job_id, None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global queue
    configure_runtime()
    queue = asyncio.Queue()
    task = asyncio.create_task(worker())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="pr-triage", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "queued": queue.qsize(), "running": sum(job.status == "running" for job in jobs.values()), "jobs": len(jobs)}


@app.post("/v1/triage", status_code=202, dependencies=[Depends(require_auth)])
async def submit(request: TriageRequest) -> dict[str, str]:
    _purge_expired()
    job_id = job_id_for(request)
    existing = jobs.get(job_id)
    if existing and existing.status != "failed":
        return {"id": existing.id, "status": existing.status}
    if queue.qsize() >= MAX_QUEUED:
        raise HTTPException(status_code=429, detail="queue is full")
    job = Job(job_id, request)
    jobs[job_id] = job
    queue.put_nowait(job)
    return {"id": job.id, "status": job.status}


@app.get("/v1/triage/{job_id}", dependencies=[Depends(require_auth)])
async def status(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="unknown job")
    payload: dict[str, Any] = {"id": job.id, "status": job.status}
    if job.status == "done":
        payload["result"] = job.result
    if job.status == "failed":
        payload["error"] = job.error
    return payload
