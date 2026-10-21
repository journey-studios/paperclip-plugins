import asyncio
import os
import unittest

os.environ["PR_TRIAGE_TOKEN"] = "t" * 32

import app as service  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SHA = "a" * 40
AUTH = {"Authorization": "Bearer " + "t" * 32}
BODY = {"repo": "wallynm/tesselapp", "number": 5, "head_sha": SHA, "token": "ghs_exampletoken123"}

PREDICTION = """```yaml
review:
  estimated_effort_to_review_[1-5]: |
    2
  relevant_tests: |
    No
  key_issues_to_review:
    - relevant_file: |
        src/a.ts
      issue_header: |
        Possible null access
      issue_content: |
        value may be undefined here
      start_line: 10
      end_line: 12
  security_concerns: |
    No
```"""


class ParseTests(unittest.TestCase):
    def test_parses_fenced_yaml(self):
        result = service.parse_prediction(PREDICTION)
        self.assertEqual(result["effort"], 2)
        self.assertEqual(result["key_issues"][0]["file"], "src/a.ts")
        self.assertEqual(result["key_issues"][0]["start_line"], 10)
        self.assertEqual(result["security_concerns"], "No")

    def test_bounds_and_rejects_garbage(self):
        many = "review:\n  key_issues_to_review:\n" + "".join(f"    - relevant_file: f{i}\n      issue_header: h\n      issue_content: c\n" for i in range(30))
        self.assertEqual(len(service.parse_prediction(many)["key_issues"]), service.MAX_ISSUES)
        for bad in ("", None, "just text", "- a\n- b"):
            with self.assertRaises(Exception):
                service.parse_prediction(bad)


class ApiTests(unittest.TestCase):
    def setUp(self):
        service.jobs.clear()

        async def fake_review(request):
            return service.parse_prediction(PREDICTION)

        service.run_review = fake_review

    def test_requires_a_valid_token(self):
        with TestClient(service.app) as client:
            self.assertEqual(client.post("/v1/triage", json=BODY).status_code, 401)
            self.assertEqual(client.post("/v1/triage", json=BODY, headers={"Authorization": "Bearer nope"}).status_code, 401)
            self.assertEqual(client.get("/healthz").status_code, 200)

    def test_validates_input(self):
        with TestClient(service.app) as client:
            for patch in ({"repo": "not a repo"}, {"number": 0}, {"head_sha": "abc"}, {"token": ""}):
                self.assertEqual(client.post("/v1/triage", json={**BODY, **patch}, headers=AUTH).status_code, 422, patch)

    def test_job_runs_and_is_idempotent(self):
        with TestClient(service.app) as client:
            first = client.post("/v1/triage", json=BODY, headers=AUTH)
            self.assertEqual(first.status_code, 202)
            again = client.post("/v1/triage", json=BODY, headers=AUTH)
            self.assertEqual(first.json()["id"], again.json()["id"])
            job_id = first.json()["id"]
            for _ in range(50):
                payload = client.get(f"/v1/triage/{job_id}", headers=AUTH).json()
                if payload["status"] in ("done", "failed"):
                    break
                import time; time.sleep(0.05)
            self.assertEqual(payload["status"], "done")
            self.assertEqual(payload["result"]["key_issues"][0]["header"], "Possible null access")
            self.assertEqual(client.get("/v1/triage/unknown", headers=AUTH).status_code, 404)

    def test_failure_is_reported_without_the_token(self):
        async def failing(request):
            raise RuntimeError(f"boom {request.token}")

        service.run_review = failing
        with TestClient(service.app) as client:
            job_id = client.post("/v1/triage", json={**BODY, "number": 6}, headers=AUTH).json()["id"]
            for _ in range(50):
                payload = client.get(f"/v1/triage/{job_id}", headers=AUTH).json()
                if payload["status"] == "failed":
                    break
                import time; time.sleep(0.05)
            self.assertEqual(payload["status"], "failed")
            self.assertNotIn("ghs_exampletoken123", payload["error"])


if __name__ == "__main__":
    unittest.main()
