import asyncio
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

WORK = Path(tempfile.mkdtemp())
os.environ["REVIEW_WORKSPACES_TOKEN"] = "t" * 32
os.environ["WORKSPACES_ROOT"] = str(WORK / "root")
os.environ["REMOTE_URL_TEMPLATE"] = f"file://{WORK}/remotes/{{repo}}.git"

import app as service  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer " + "t" * 32}
TOKEN = "ghs_exampletoken123"


def sh(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def make_remote():
    """A local 'GitHub': a bare repository with main and a pull request ref two commits ahead."""
    remote = WORK / "remotes" / "wallynm" / "tesselapp.git"
    src = WORK / "src"
    sh("git", "init", "--quiet", "-b", "main", str(src))
    shas = []
    for n in (1, 2, 3):
        (src / "file.txt").write_text(f"version {n}\n")
        sh("git", "add", ".", cwd=src)
        sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", f"c{n}", cwd=src)
        shas.append(sh("git", "rev-parse", "HEAD", cwd=src))
    base, head = shas[0], shas[-1]
    global MIDDLE
    MIDDLE = shas[1]
    sh("git", "clone", "--quiet", "--bare", str(src), str(remote))
    sh("git", "update-ref", "refs/pull/7/head", head, cwd=remote)
    sh("git", "update-ref", "refs/pull/11/head", MIDDLE, cwd=remote)
    sh("git", "update-ref", "refs/heads/main", base, cwd=remote)
    return base, head


BASE, HEAD = make_remote()
BODY = {"repo": "wallynm/tesselapp", "number": 7, "head_sha": HEAD, "token": TOKEN}


def wait_marker(path: Path) -> str:
    for _ in range(200):
        text = service.read_marker(path)
        if text:
            return text
        time.sleep(0.05)
    raise AssertionError("no marker")


class WorkspaceTests(unittest.TestCase):
    def test_requires_auth_and_valid_input(self):
        with TestClient(service.app) as client:
            self.assertEqual(client.post("/v1/workspaces", json=BODY).status_code, 401)
            for patch in ({"repo": "../x"}, {"number": 0}, {"head_sha": "abc"}):
                self.assertEqual(client.post("/v1/workspaces", json={**BODY, **patch}, headers=AUTH).status_code, 422, patch)

    def test_worktree_at_the_exact_head_commit_then_ready(self):
        with TestClient(service.app) as client:
            answer = client.post("/v1/workspaces", json=BODY, headers=AUTH).json()
            path = Path(answer["path"])
            self.assertEqual(path, Path(os.environ["WORKSPACES_ROOT"]) / "wallynm__tesselapp" / f"7-{HEAD[:12]}")
            self.assertEqual(wait_marker(path), "ok")
            self.assertEqual(sh("git", "rev-parse", "HEAD", cwd=path), HEAD)
            self.assertEqual((path / "file.txt").read_text(), "version 3\n")
            self.assertEqual(client.post("/v1/workspaces", json=BODY, headers=AUTH).json()["status"], "ready")
            config = (service.mirror_path("wallynm/tesselapp") / "config").read_text()
            self.assertNotIn(TOKEN, config, "the token is never written to the mirror")

    def test_a_commit_that_does_not_exist_reports_an_error_without_the_token(self):
        with TestClient(service.app) as client:
            path = Path(client.post("/v1/workspaces", json={**BODY, "number": 8, "head_sha": "f" * 40}, headers=AUTH).json()["path"])
            marker = wait_marker(path)
            self.assertTrue(marker.startswith("error: "), marker)
            self.assertNotIn(TOKEN, marker)
            # The same worker keeps serving after a failure.
            path = Path(client.post("/v1/workspaces", json={**BODY, "number": 11, "head_sha": MIDDLE}, headers=AUTH).json()["path"])
            self.assertEqual(wait_marker(path), "ok")
            self.assertEqual((path / "file.txt").read_text(), "version 2\n")

    def test_sweep_removes_expired_worktrees(self):
        with TestClient(service.app) as client:
            path = Path(client.post("/v1/workspaces", json={**BODY, "number": 7}, headers=AUTH).json()["path"])
            wait_marker(path)
        self.assertGreaterEqual(asyncio.run(service.sweep(now=time.time() + service.TTL_SECONDS + 60)), 1)
        self.assertFalse(path.exists())
        self.assertIsNone(service.read_marker(path))


class HardeningTests(unittest.TestCase):
    def test_git_never_sees_the_service_token(self):
        self.assertNotIn("REVIEW_WORKSPACES_TOKEN", service.auth_env(TOKEN))
        self.assertNotIn("REVIEW_WORKSPACES_TOKEN", service.GIT_BASE_ENV)

    def test_sweep_removes_directories_a_dead_job_left_without_a_marker(self):
        orphan = Path(os.environ["WORKSPACES_ROOT"]) / "wallynm__tesselapp" / "99-deadbeef0000"
        orphan.mkdir(parents=True)
        (orphan / "half.txt").write_text("x")
        asyncio.run(service.sweep(now=time.time() + 60))
        self.assertTrue(orphan.exists(), "a fresh directory may still be in progress")
        asyncio.run(service.sweep(now=time.time() + service.ORPHAN_SECONDS + 60))
        self.assertFalse(orphan.exists())


if __name__ == "__main__":
    unittest.main()
