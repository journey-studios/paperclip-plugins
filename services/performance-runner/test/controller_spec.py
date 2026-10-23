import importlib.util
import json
import os
import shutil
import time
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

temp = tempfile.TemporaryDirectory()
token_file = Path(temp.name) / "token"
token_file.write_text("test-only-not-a-credential")
os.environ["PERFORMANCE_DATA"] = str(Path(temp.name) / "runs")
os.environ["PERFORMANCE_TOKEN_FILE"] = str(token_file)
spec = importlib.util.spec_from_file_location("controller", Path(__file__).parents[1] / "controller.py")
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
company = "11111111-1111-4111-8111-111111111111"
other = "22222222-2222-4222-8222-222222222222"
run_id = "33333333-3333-4333-8333-333333333333"

class ControllerSpec(unittest.TestCase):
    def setUp(self):
        for folder in controller.ROOT.iterdir():
            if folder.is_dir():
                shutil.rmtree(folder)
        with controller.lock:
            controller.active.clear()

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), controller.Handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path, body=None, token="test-only-not-a-credential"):
        data = None
        if body is not None:
            data = json.dumps(body).encode()
        request = Request(self.url + path, data=data, headers={"Authorization": "Bearer " + token})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def payload(self):
        return {"id": run_id, "companyId": company, "target": {"environment": "prod", "url": "https://dash.tessel.app/chat", "authProfile": "public"}}

    def test_no_credentials_rejected(self):
        self.assertEqual(self.request("/health", token="wrong")[0], 401)

    def test_disallowed_origin_rejected(self):
        body = self.payload()
        body["target"]["url"] = "http://169.254.169.254/latest/meta-data"
        self.assertEqual(self.request("/runs", body)[0], 400)

    def test_credentials_in_url_rejected(self):
        body = self.payload()
        body["target"]["url"] = "https://a:b@dash.tessel.app/chat"
        self.assertEqual(self.request("/runs", body)[0], 400)

    def test_cross_environment_profile_rejected(self):
        body = self.payload()
        body["target"]["authProfile"] = "staging"
        self.assertEqual(self.request("/runs", body)[0], 400)

    def test_queue_is_idempotent_and_company_scoped(self):
        first = self.request("/runs", self.payload())
        second = self.request("/runs", self.payload())
        self.assertEqual(first[0], 202)
        self.assertEqual(second[0], 200)
        self.assertEqual(first[1], second[1])
        self.assertEqual(self.request(f"/runs/{run_id}?companyId={other}")[0], 404)
        self.assertEqual(self.request(f"/runs/{run_id}?companyId={company}")[0], 200)
        payload = self.payload()
        payload["companyId"] = other
        self.assertEqual(self.request("/runs", payload)[0], 409)

    def test_missing_auth_profile_fails_without_starting_container(self):
        from unittest.mock import patch
        body = self.payload()
        body["id"] = "55555555-5555-4555-8555-555555555555"
        body["target"]["authProfile"] = "prod"
        self.request("/runs", body)
        folder = controller.ROOT / body["id"]
        with patch.object(controller.subprocess, "run") as docker:
            controller.run_one(folder, controller.read(folder / "state.json"))
            docker.assert_not_called()
        state = controller.read(folder / "state.json")
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["errorCode"], "AUTH_PROFILE_NOT_CONFIGURED")

    def test_executor_uses_non_root_and_isolated_network(self):
        from unittest.mock import patch
        self.request("/runs", self.payload())
        folder = controller.ROOT / run_id
        controller.write(folder / "result.json", {"ok": True, "result": {}})
        with patch.object(controller.os, "chown") as ownership, patch.object(controller.subprocess, "run") as docker:
            docker.return_value.returncode = 0
            controller.run_one(folder, controller.read(folder / "state.json"))
        arguments = docker.call_args_list[0].args[0]
        self.assertEqual(arguments[arguments.index("--network") + 1], "journey-performance-egress")
        self.assertEqual(arguments[arguments.index("--user") + 1], f"{controller.RUNNER_UID}:{controller.RUNNER_GID}")
        self.assertNotEqual(controller.RUNNER_UID, 0)
        self.assertEqual(ownership.call_count, 2)

    def test_retention_requires_durable_ack_and_company_match(self):
        self.request("/runs", self.payload())
        file = controller.ROOT / run_id / "state.json"
        state = controller.read(file)
        state.update(status="completed", finishedAt=time.time() - 10 * 86400)
        controller.write(file, state)
        controller.recover_active()
        self.assertEqual(controller.clean_acknowledged(time.time()), 0)
        self.assertEqual(self.request(f"/runs/{run_id}/ack", {"companyId": other})[0], 404)
        self.assertEqual(self.request(f"/runs/{run_id}/ack", {"companyId": company})[0], 200)
        self.assertEqual(controller.clean_acknowledged(time.time()), 0)
        state = controller.read(file)
        state["acknowledgedAt"] = time.time() - 8 * 86400
        controller.write(file, state)
        self.assertEqual(controller.clean_acknowledged(time.time()), 1)
        self.assertFalse(file.parent.exists())

    def test_recovery_indexes_pending_and_never_acknowledges_running_work(self):
        self.request("/runs", self.payload())
        controller.active.clear()
        controller.recover_active()
        self.assertIn(run_id, controller.active)
        self.assertEqual(self.request(f"/runs/{run_id}/ack", {"companyId": company})[0], 409)
        self.assertEqual(controller.clean_acknowledged(time.time() + 10 * 86400), 0)

if __name__ == "__main__":
    unittest.main()
