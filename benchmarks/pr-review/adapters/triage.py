"""Replay the deployed PRReviewer, with frozen Git input and no publication provider."""

import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, "/srv/pr-triage")
os.environ["PR_TRIAGE_TOKEN"] = "benchmark-local-no-publication-token"
os.environ["OPENAI.API_BASE"] = "http://benchmark-gateway:8080/v1"
os.environ["OPENAI.KEY"] = "benchmark-no-provider-key"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"


async def main():
    # config_loader reads the current repo's pyproject at import time; only frozen base rules may override it.
    os.chdir("/tmp")
    from app import parse_prediction
    from repo_rules import applied, load_repo_rules, reviewer_overrides
    from pr_agent.config_loader import get_settings
    import pr_agent.git_providers as providers
    from pr_agent.git_providers.local_git_provider import LocalGitProvider
    from pr_agent.tools.pr_reviewer import PRReviewer
    from pr_agent.algo.pr_processing import get_pr_diff
    from loguru import logger

    # PR-Agent's default DEBUG includes prompts and full response metadata.
    logger.remove()
    logger.add(sys.stderr, level="ERROR")
    os.chdir("/work/repo")
    config = json.loads(Path("/config/reviewer.json").read_text())
    pr = json.loads(Path("/work/pr/pr.json").read_text())

    class FrozenProvider(LocalGitProvider):
        def get_pr_title(self):
            return pr["title"]

        def get_pr_description_full(self):
            return pr.get("body", "")

        def get_pr_branch(self):
            return "review-head"

        def get_commit_messages(self):
            return "\n".join(commit.message for commit in self.repo.iter_commits("review-base..HEAD"))

    providers._GIT_PROVIDERS["benchmark"] = FrozenProvider
    settings = get_settings()
    for key, value in config["settings"].items():
        if not key.upper().startswith(("CONFIG.", "PR_REVIEWER.", "PR_REVIEW_PROMPT.", "IGNORE.")):
            raise ValueError("Setting outside the replay allowlist")
        settings.set(key, value)
    settings.set("CONFIG.GIT_PROVIDER", "benchmark")
    settings.set("CONFIG.MODEL", "openai/" + config["requestModel"])
    settings.set("CONFIG.FALLBACK_MODELS", [])
    settings.set("CONFIG.PUBLISH_OUTPUT", False)
    settings.set("CONFIG.PUBLISH_OUTPUT_PROGRESS", False)
    settings.set("CONFIG.ENABLE_CUSTOM_LABELS", False)
    settings.set("CONFIG.VERBOSITY_LEVEL", 0)
    settings.set("OPENAI.API_BASE", os.environ["OPENAI.API_BASE"])
    settings.set("OPENAI.KEY", os.environ["OPENAI.KEY"])
    rules = load_repo_rules(Path("/work/pr/rules.toml").read_bytes() or None)
    with applied(settings, reviewer_overrides(rules, settings)):
        reviewer = PRReviewer("review-base", args=[])
        await reviewer.run()
    result = parse_prediction(reviewer.prediction)
    rendered = reviewer.patches_diff or ""
    with applied(settings, {**reviewer_overrides(rules, settings), "CONFIG.MAX_MODEL_TOKENS": 1_000_000, "CONFIG.CUSTOM_MODEL_MAX_TOKENS": 1_000_000}):
        complete_diff = get_pr_diff(reviewer.git_provider, reviewer.token_handler, settings.get("CONFIG.MODEL"), add_line_numbers_to_hunks=True, disable_extra_lines=False)
    represented = sorted(set(re.findall(r"^## File: '(.+)'\s*$", rendered, re.MULTILINE)))
    changed = json.loads(Path("/work/pr/coverage.json").read_text())["changedPaths"]
    coverage = "partial"
    if rendered == complete_diff and set(represented) == set(changed):
        coverage = "complete"
    Path("/out/review.json").write_text(json.dumps(result))
    Path("/out/adapter.json").write_text(json.dumps({
        "coverage": coverage, "coverageEvidence": {
            "renderedDiffSha256": hashlib.sha256(rendered.encode()).hexdigest(),
            "renderedDiffBytes": len(rendered.encode()),
            "uncappedDiffBytes": len(complete_diff.encode()),
            "contextWasTruncated": rendered != complete_diff,
            "representedFiles": represented, "changedFileCount": len(changed),
            "maxModelTokens": settings.get("CONFIG.MAX_MODEL_TOKENS"),
            "customModelMaxTokens": settings.get("CONFIG.CUSTOM_MODEL_MAX_TOKENS"),
            "repoRules": rules.status,
        }
    }))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # PR-Agent/provider errors can contain endpoints, headers or model content.
        sys.stderr.write("Triage replay failed; no valid review artifact\n")
        sys.exit(1)
