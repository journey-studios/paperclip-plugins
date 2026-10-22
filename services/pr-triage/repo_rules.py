"""Per-repository rules read from `.pr_agent.toml` on the repository's default branch.

Why only the default branch: a pull request must not be able to change the rules it is checked against.
Why an allowlist instead of PR-Agent's own `apply_repo_settings`: that merges every key of the file into the
process-wide settings, so a repository could point the model endpoint or the token elsewhere, and the values
would leak into the next repository's job.

Two things come from the file:
- reviewer guidance PR-Agent understands (`[pr_reviewer] extra_instructions`, `num_max_findings`, `[ignore] glob`);
- the risk radar (`[[review_radar.rules]]`): deterministic path (and optionally added-line) rules whose note is
  shown when the pull request touches them. No model is involved, so a radar note never hallucinates.
"""

import copy
import fnmatch
import re
import tomllib
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

SETTINGS_FILE = ".pr_agent.toml"
MAX_SETTINGS_BYTES = 64 * 1024
MAX_EXTRA_INSTRUCTIONS = 4000
MAX_FINDINGS_RANGE = (1, 10)
MAX_IGNORE_GLOBS = 50
MAX_RULES = 30
MAX_RULE_PATHS = 20
MAX_PATTERN = 300
MAX_NOTE = 500
MAX_FILES_PER_HIT = 10
# Bounds the regex work of the radar on very large pull requests.
MAX_SCANNED_CHARS_PER_FILE = 50_000
RULE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")


class RulesError(ValueError):
    """The file exists but is not acceptable; the job runs with the defaults and reports why."""


@dataclass
class RadarRule:
    id: str
    paths: list[str]
    note: str
    added_matches: Optional[re.Pattern] = None


@dataclass
class RepoRules:
    status: str = "absent"
    extra_instructions: Optional[str] = None
    num_max_findings: Optional[int] = None
    ignore_globs: list[str] = field(default_factory=list)
    radar: list[RadarRule] = field(default_factory=list)


def _string(value: Any, where: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RulesError(f"{where} must be a non-empty string")
    if len(value) > max_length:
        raise RulesError(f"{where} is longer than {max_length} characters")
    return value


def _string_list(value: Any, where: str, max_items: int) -> list[str]:
    if not isinstance(value, list) or len(value) > max_items:
        raise RulesError(f"{where} must be a list of at most {max_items} strings")
    return [_string(item, f"{where}[{index}]", MAX_PATTERN) for index, item in enumerate(value)]


def _rule(raw: Any, index: int) -> RadarRule:
    where = f"review_radar.rules[{index}]"
    if not isinstance(raw, dict):
        raise RulesError(f"{where} must be a table")
    unknown = set(raw) - {"id", "paths", "note", "added_matches"}
    if unknown:
        raise RulesError(f"{where} has unknown keys: {', '.join(sorted(unknown))}")
    rule_id = _string(raw.get("id"), f"{where}.id", 40)
    if not RULE_ID.match(rule_id):
        raise RulesError(f"{where}.id may only use letters, digits, '.', '_' and '-'")
    paths = _string_list(raw.get("paths"), f"{where}.paths", MAX_RULE_PATHS)
    if not paths:
        raise RulesError(f"{where}.paths must not be empty")
    pattern = None
    if "added_matches" in raw:
        source = _string(raw["added_matches"], f"{where}.added_matches", MAX_PATTERN)
        try:
            pattern = re.compile(source)
        except re.error as error:
            raise RulesError(f"{where}.added_matches is not a valid regular expression: {error}") from error
    return RadarRule(id=rule_id, paths=paths, note=_string(raw.get("note"), f"{where}.note", MAX_NOTE), added_matches=pattern)


def parse_repo_rules(raw: Optional[bytes]) -> RepoRules:
    """Validates the whole file; any problem rejects it as a whole rather than applying half of it."""
    if raw is None:
        return RepoRules()
    if len(raw) > MAX_SETTINGS_BYTES:
        raise RulesError(f"{SETTINGS_FILE} is larger than {MAX_SETTINGS_BYTES} bytes")
    try:
        data = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise RulesError(f"{SETTINGS_FILE} is not valid TOML: {error}") from error

    rules = RepoRules(status="loaded")
    reviewer = data.get("pr_reviewer", {})
    if not isinstance(reviewer, dict):
        raise RulesError("pr_reviewer must be a table")
    if "extra_instructions" in reviewer:
        rules.extra_instructions = _string(reviewer["extra_instructions"], "pr_reviewer.extra_instructions", MAX_EXTRA_INSTRUCTIONS)
    if "num_max_findings" in reviewer:
        value = reviewer["num_max_findings"]
        low, high = MAX_FINDINGS_RANGE
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise RulesError(f"pr_reviewer.num_max_findings must be an integer from {low} to {high}")
        rules.num_max_findings = value

    ignore = data.get("ignore", {})
    if not isinstance(ignore, dict):
        raise RulesError("ignore must be a table")
    if "glob" in ignore:
        rules.ignore_globs = _string_list(ignore["glob"], "ignore.glob", MAX_IGNORE_GLOBS)

    radar = data.get("review_radar", {})
    if not isinstance(radar, dict):
        raise RulesError("review_radar must be a table")
    raw_rules = radar.get("rules", [])
    if not isinstance(raw_rules, list) or len(raw_rules) > MAX_RULES:
        raise RulesError(f"review_radar.rules must be a list of at most {MAX_RULES} rules")
    rules.radar = [_rule(item, index) for index, item in enumerate(raw_rules)]
    ids = [rule.id for rule in rules.radar]
    if len(ids) != len(set(ids)):
        raise RulesError("review_radar.rules ids must be unique")
    return rules


def load_repo_rules(raw: Optional[bytes]) -> RepoRules:
    try:
        return parse_repo_rules(raw)
    except RulesError as error:
        return RepoRules(status=f"invalid: {error}"[:300])


def _added_lines(patch: str) -> str:
    lines = (line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))
    return "\n".join(lines)[:MAX_SCANNED_CHARS_PER_FILE]


def evaluate_radar(rules: list[RadarRule], files: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """`files` are (path, patch) pairs. In `paths`, `*` also crosses directories (fnmatch semantics)."""
    hits = []
    for rule in rules:
        matched = []
        for path, patch in files:
            if not any(fnmatch.fnmatchcase(path, pattern) for pattern in rule.paths):
                continue
            if rule.added_matches and not rule.added_matches.search(_added_lines(patch or "")):
                continue
            matched.append(path)
        if matched:
            hits.append({"id": rule.id, "note": rule.note, "files": matched[:MAX_FILES_PER_HIT], "more_files": max(0, len(matched) - MAX_FILES_PER_HIT)})
    return hits


def reviewer_overrides(rules: RepoRules, settings: Any) -> dict[str, Any]:
    """The PR-Agent settings this repository changes. Ignore globs extend the service's own, never replace them."""
    overrides: dict[str, Any] = {}
    if rules.extra_instructions is not None:
        overrides["PR_REVIEWER.EXTRA_INSTRUCTIONS"] = rules.extra_instructions
    if rules.num_max_findings is not None:
        overrides["PR_REVIEWER.NUM_MAX_FINDINGS"] = rules.num_max_findings
    if rules.ignore_globs:
        overrides["IGNORE.GLOB"] = list(settings.get("IGNORE.GLOB") or []) + rules.ignore_globs
    return overrides


@contextmanager
def applied(settings: Any, overrides: dict[str, Any]) -> Iterator[None]:
    """Sets the overrides for one job and puts the previous values back, so nothing leaks into the next job."""
    previous = {key: copy.deepcopy(settings.get(key)) for key in overrides}
    try:
        for key, value in overrides.items():
            settings.set(key, value)
        yield
    finally:
        for key, value in previous.items():
            settings.set(key, value)
