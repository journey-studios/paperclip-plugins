import asyncio
import os
import unittest
from unittest import mock

os.environ.setdefault("PR_TRIAGE_TOKEN", "t" * 32)

import app as service  # noqa: E402
import repo_rules  # noqa: E402

SHA = "a" * 40

RULES = b"""
[pr_reviewer]
extra_instructions = "Flag hardcoded hex colors."
num_max_findings = 5

[ignore]
glob = ["apps/web/src/routeTree.gen.ts"]

[[review_radar.rules]]
id = "rls-notes"
paths = ["supabase/migrations/*.sql"]
added_matches = "(?i)policy[^\\\\n]*notes"
note = "Run the RLS check before and after."

[[review_radar.rules]]
id = "wrangler"
paths = ["apps/*/wrangler.toml", "apps/*/wrangler.jsonc"]
note = "Named environments do not inherit top-level bindings."
"""

PREDICTION = """review:
  estimated_effort_to_review_[1-5]: |
    1
  key_issues_to_review: []
  security_concerns: |
    No
"""


class FakeSettings:
    """Mimics the dotted get/set of PR-Agent's Dynaconf settings."""

    def __init__(self, values):
        self.values = dict(values)

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = value


class ParseTests(unittest.TestCase):
    def test_absent_file_uses_defaults(self):
        rules = repo_rules.load_repo_rules(None)
        self.assertEqual(rules.status, "absent")
        self.assertEqual(rules.radar, [])

    def test_valid_file(self):
        rules = repo_rules.load_repo_rules(RULES)
        self.assertEqual(rules.status, "loaded")
        self.assertEqual(rules.extra_instructions, "Flag hardcoded hex colors.")
        self.assertEqual(rules.num_max_findings, 5)
        self.assertEqual(rules.ignore_globs, ["apps/web/src/routeTree.gen.ts"])
        self.assertEqual([rule.id for rule in rules.radar], ["rls-notes", "wrangler"])

    def test_invalid_file_is_rejected_as_a_whole(self):
        cases = {
            b"not = [valid": "not valid TOML",
            b"[pr_reviewer]\nnum_max_findings = 99": "num_max_findings",
            b"[pr_reviewer]\nnum_max_findings = true": "num_max_findings",
            b"[[review_radar.rules]]\nid = 'a b'\npaths = ['x']\nnote = 'n'": "id may only use",
            b"[[review_radar.rules]]\nid = 'a'\npaths = []\nnote = 'n'": "paths must not be empty",
            b"[[review_radar.rules]]\nid = 'a'\npaths = ['x']\nnote = 'n'\nadded_matches = '('": "regular expression",
            b"[[review_radar.rules]]\nid = 'a'\npaths = ['x']\nnote = 'n'\nurl = 'http://x'": "unknown keys",
            b"[[review_radar.rules]]\nid = 'a'\npaths = ['x']\nnote = 'n'\n[[review_radar.rules]]\nid = 'a'\npaths = ['y']\nnote = 'n'": "unique",
        }
        for raw, expected in cases.items():
            rules = repo_rules.load_repo_rules(raw)
            self.assertTrue(rules.status.startswith("invalid: "), raw)
            self.assertIn(expected, rules.status, raw)
            self.assertIsNone(rules.extra_instructions)
            self.assertEqual(rules.radar, [])

    def test_oversized_file_is_rejected(self):
        raw = b"# " + b"x" * repo_rules.MAX_SETTINGS_BYTES
        self.assertIn("larger than", repo_rules.load_repo_rules(raw).status)

    def test_keys_outside_the_allowlist_are_never_applied(self):
        raw = b'[openai]\napi_base = "http://evil"\n[github]\nuser_token = "x"\n[config]\nmodel = "other"'
        rules = repo_rules.load_repo_rules(raw)
        self.assertEqual(rules.status, "loaded")
        self.assertEqual(repo_rules.reviewer_overrides(rules, FakeSettings({})), {})


class RadarTests(unittest.TestCase):
    def setUp(self):
        self.rules = repo_rules.load_repo_rules(RULES).radar

    def test_path_and_added_line_rules(self):
        files = [
            ("supabase/migrations/20261022_notes.sql", "@@\n+create policy read_notes on notes for select using (true);"),
            ("supabase/migrations/20261022_other.sql", "@@\n+alter table campaigns add column x int;"),
            ("apps/workers/wrangler.toml", "@@\n+[vars]"),
            ("apps/web/src/a.ts", "@@\n+const policy = 'notes'"),
        ]
        hits = {hit["id"]: hit for hit in repo_rules.evaluate_radar(self.rules, files)}
        self.assertEqual(hits["rls-notes"]["files"], ["supabase/migrations/20261022_notes.sql"])
        self.assertEqual(hits["wrangler"]["files"], ["apps/workers/wrangler.toml"])

    def test_removed_lines_do_not_match(self):
        files = [("supabase/migrations/x.sql", "@@\n-create policy p on notes for select using (true);\n+-- cleanup")]
        self.assertEqual(repo_rules.evaluate_radar(self.rules, files), [])

    def test_hits_are_bounded(self):
        files = [(f"apps/w{i}/wrangler.toml", "") for i in range(15)]
        hit = repo_rules.evaluate_radar(self.rules, files)[0]
        self.assertEqual(len(hit["files"]), repo_rules.MAX_FILES_PER_HIT)
        self.assertEqual(hit["more_files"], 5)


class OverrideTests(unittest.TestCase):
    def test_overrides_extend_ignore_and_are_restored(self):
        settings = FakeSettings({"IGNORE.GLOB": ["vendor/**"], "PR_REVIEWER.EXTRA_INSTRUCTIONS": "", "PR_REVIEWER.NUM_MAX_FINDINGS": 3})
        rules = repo_rules.load_repo_rules(RULES)
        overrides = repo_rules.reviewer_overrides(rules, settings)
        self.assertEqual(overrides["IGNORE.GLOB"], ["vendor/**", "apps/web/src/routeTree.gen.ts"])
        with self.assertRaises(RuntimeError):
            with repo_rules.applied(settings, overrides):
                self.assertEqual(settings.get("PR_REVIEWER.NUM_MAX_FINDINGS"), 5)
                raise RuntimeError("review failed")
        self.assertEqual(settings.get("IGNORE.GLOB"), ["vendor/**"])
        self.assertEqual(settings.get("PR_REVIEWER.EXTRA_INSTRUCTIONS"), "")
        self.assertEqual(settings.get("PR_REVIEWER.NUM_MAX_FINDINGS"), 3)


class FetchTests(unittest.TestCase):
    """The GitHub reads, against a fake PyGithub (the real one is in the image)."""

    def fetch(self, contents):
        from github import GithubException, UnknownObjectException

        files = [mock.Mock(filename="a.ts", patch="+x"), mock.Mock(filename="b.png", patch=None)]
        repo = mock.Mock()
        repo.get_pull.return_value.get_files.return_value = files
        errors = {404: UnknownObjectException(404, {}, {}), 403: GithubException(403, {}, {})}
        if contents in errors:
            repo.get_contents.side_effect = errors[contents]
        else:
            repo.get_contents.return_value = mock.Mock(decoded_content=contents)
        request = service.TriageRequest(repo="wallynm/tesselapp", number=7, head_sha=SHA, token="ghs_exampletoken123")
        with mock.patch("github.Github") as github:
            github.return_value.get_repo.return_value = repo
            rules, patches = service.fetch_repo_context(request)
        repo.get_contents.assert_called_once_with(".pr_agent.toml")
        return rules, patches

    def test_reads_rules_and_patches(self):
        rules, patches = self.fetch(RULES)
        self.assertEqual(rules.status, "loaded")
        self.assertEqual(patches, [("a.ts", "+x"), ("b.png", "")])

    def test_missing_and_unreadable_files_are_told_apart(self):
        self.assertEqual(self.fetch(404)[0].status, "absent")
        self.assertEqual(self.fetch(403)[0].status, "unreadable: GitHub 403")


class RunReviewTests(unittest.TestCase):
    """Runs inside the PR-Agent image: the real settings object, a fake reviewer and a fake GitHub."""

    def test_rules_apply_during_the_review_only(self):
        from pr_agent.config_loader import get_settings

        settings = get_settings()
        before = (settings.get("PR_REVIEWER.EXTRA_INSTRUCTIONS"), list(settings.get("IGNORE.GLOB")))
        seen = {}

        class FakeReviewer:
            def __init__(self, url, args):
                seen["url"] = url
                seen["instructions"] = settings.get("PR_REVIEWER.EXTRA_INSTRUCTIONS")
                seen["findings"] = settings.get("PR_REVIEWER.NUM_MAX_FINDINGS")
                seen["ignore"] = list(settings.get("IGNORE.GLOB"))
                seen["token"] = settings.get("GITHUB.USER_TOKEN")
                self.prediction = PREDICTION

            async def run(self):
                return None

        context = (repo_rules.load_repo_rules(RULES), [("apps/api/wrangler.toml", "")])
        request = service.TriageRequest(repo="wallynm/tesselapp", number=7, head_sha=SHA, token="ghs_exampletoken123")
        with mock.patch.object(service, "fetch_repo_context", return_value=context), mock.patch("pr_agent.tools.pr_reviewer.PRReviewer", FakeReviewer):
            result = asyncio.run(service.run_review(request))

        self.assertEqual(seen["url"], "https://github.com/wallynm/tesselapp/pull/7")
        self.assertEqual(seen["instructions"], "Flag hardcoded hex colors.")
        self.assertEqual(seen["findings"], 5)
        self.assertIn("apps/web/src/routeTree.gen.ts", seen["ignore"])
        self.assertEqual(seen["token"], "ghs_exampletoken123")
        self.assertEqual(result["repo_rules"], "loaded")
        self.assertEqual([hit["id"] for hit in result["radar"]], ["wrangler"])
        self.assertEqual(result["effort"], 1)
        self.assertEqual((settings.get("PR_REVIEWER.EXTRA_INSTRUCTIONS"), list(settings.get("IGNORE.GLOB"))), before)
        self.assertEqual(settings.get("GITHUB.USER_TOKEN"), "")


if __name__ == "__main__":
    unittest.main()
