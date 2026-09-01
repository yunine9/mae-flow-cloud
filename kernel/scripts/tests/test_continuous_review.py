#!/usr/bin/env python3
"""Cloud continuous-review is opt-in, durable and never a fresh workflow."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import cli_runtime  # noqa: E402,F401
from mae_flow_core.cli_commands import delivery_commands as delivery  # noqa: E402
from mae_flow_core.cli_commands.external_repair_gate import (  # noqa: E402
    gate_repair_commit,
)
from mae_flow_core.cli_commands.pipeline_commands import (  # noqa: E402
    _route_external_verification,
)
from mae_flow_core.workflow.execution_contract import SCHEMA  # noqa: E402


HEAD = "a" * 40


def contract(enabled=True):
    return {
        "schema": SCHEMA,
        "host": "cloud",
        "compile": "pipeline",
        "ut_write": "agent",
        "ut_run": "pipeline",
        "codecheck": "pipeline",
        "git_push": "host",
        "continuous_review": enabled,
        "source": "order",
    }


def state(step="delivery_watch"):
    return {
        "current": step,
        "execution_contract": contract(),
        "config": {"单号": "REQ-7", "分支名": "main_u_REQ-7"},
        "choices": {"workflow": "full"},
        "history": [{"step": "external_verify", "result": "pipeline:pass"}],
        "step_heads": {step: HEAD},
        "quality": {"external_verification": {
            "verdict": "PASS", "sha": HEAD,
        }},
        "initial_dirty": [],
    }


def batch(batch_id="fb-1", base=HEAD):
    return {
        "schema": delivery.BATCH_SCHEMA,
        "batch_id": batch_id,
        "task_id": "task-7",
        "base_sha": base,
        "opened_at": "2026-09-01T12:00:00+08:00",
        "items": [{
            "id": "workspace:an-1",
            "source": "workspace",
            "source_id": "an-1",
            "source_revision": 0,
            "kind": "code_review",
            "summary": "空值场景需要处理",
            "material": "../feedback/fb-1/an-1.json",
            "verification": "author",
        }],
    }


class TempProject(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.tmp.name)
        subprocess.run(["git", "init", "-q"], check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "config", "user.name", "Test"], check=True)
        with open("tracked.txt", "w", encoding="utf-8") as stream:
            stream.write("base\n")
        subprocess.run(["git", "add", "tracked.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "base"], check=True)
        self.head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip()

    def tearDown(self):
        os.chdir(self.old)
        self.tmp.cleanup()

    def write_json(self, name, value):
        with open(name, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
        return os.path.abspath(name)


class DeliveryCommandTests(TempProject):
    def live_state(self, step="delivery_watch"):
        value = state(step)
        value["step_heads"] = {step: self.head}
        value["quality"]["external_verification"]["sha"] = self.head
        return value

    def test_feedback_open_preserves_identity_and_is_idempotent(self):
        value = self.live_state()
        before_config = json.loads(json.dumps(value["config"], ensure_ascii=False))
        before_choices = json.loads(json.dumps(value["choices"], ensure_ascii=False))
        before_history = list(value["history"])
        payload = batch(base=self.head)
        path = self.write_json("batch.json", payload)
        args = SimpleNamespace(delivery_action="feedback-open", file=path)
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual("feedback_triage", value["current"])
        self.assertEqual(before_config, value["config"])
        self.assertEqual(before_choices, value["choices"])
        self.assertEqual(before_history, value["history"][:len(before_history)])
        self.assertEqual(1, value["delivery_loop"]["delivery_round"])
        self.assertFalse(os.path.exists(".mae-flow.json.last"))
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual(first, value)

    def test_feedback_open_rejects_wrong_base_and_disabled_contract(self):
        value = self.live_state()
        path = self.write_json("wrong.json", batch(base="b" * 40))
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-open", file=path))
        value = self.live_state()
        value["execution_contract"]["continuous_review"] = False
        path = self.write_json("disabled.json", batch(base=self.head))
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-open", file=path))

    def test_explained_result_returns_to_watch_without_losing_quality(self):
        value = self.live_state()
        open_path = self.write_json("batch.json", batch(base=self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=open_path))
        old_quality = json.loads(json.dumps(value["quality"]))
        result_path = self.write_json("result.json", {
            "schema": delivery.RESULT_SCHEMA,
            "batch_id": "fb-1",
            "changed": False,
            "results": [{
                "id": "workspace:an-1", "status": "explained",
                "summary": "现有空值分支已经覆盖", "evidence": "src/a.py:8",
            }],
        })
        args = SimpleNamespace(delivery_action="feedback-result", file=result_path)
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual("delivery_watch", value["current"])
        self.assertEqual(old_quality, value["quality"])
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual(first, value)

    def test_result_requires_one_receipt_per_item(self):
        value = self.live_state()
        open_path = self.write_json("batch.json", batch(base=self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=open_path))
        result_path = self.write_json("result.json", {
            "schema": delivery.RESULT_SCHEMA, "batch_id": "fb-1", "results": [],
        })
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-result", file=result_path))

    def test_merged_close_is_the_only_terminal_transition_and_is_idempotent(self):
        value = self.live_state()
        args = SimpleNamespace(
            delivery_action="close", reason="merged", sha=self.head,
            event_id="merge-7")
        flow = {"steps": {"end": {"terminal": True}}}
        delivery.cmd_delivery(flow, value, args)
        self.assertEqual("end", value["current"])
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery(flow, value, args)
        self.assertEqual(first, value)


class PipelineRoutingTests(unittest.TestCase):
    def test_continuous_pass_enters_delivery_watch(self):
        value = state("external_verify")
        with mock.patch.object(
                cli_runtime, "complete_verified_feedback", return_value=False), mock.patch.object(
                cli_runtime, "advance") as advance:
            _route_external_verification(
                {"steps": {}}, value,
                {"verdict": "PASS", "sha": HEAD, "reason": "green"})
        self.assertEqual("delivery_watch", advance.call_args.args[3]["next"])

    def test_legacy_cloud_pass_keeps_end_semantics(self):
        value = state("external_verify")
        value["execution_contract"]["continuous_review"] = False
        with mock.patch.object(cli_runtime, "advance") as advance:
            _route_external_verification(
                {"steps": {}}, value,
                {"verdict": "PASS", "sha": HEAD, "reason": "green"})
        self.assertEqual("end", advance.call_args.args[3]["next"])


class FeedbackAuthorizationTests(unittest.TestCase):
    def test_feedback_commit_scope_remains_exact_and_names_both_sides(self):
        value = state("feedback_triage")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-1",
            "batches": [{"batch_id": "fb-1", "status": "repairing"}],
        }
        value["delivery_repair_authorization"] = {
            "schema": "mae-flow-feedback-repair/1", "status": "ready",
            "batch_id": "fb-1", "base_sha": HEAD,
            "baseline_dirty": ["user.txt"],
        }
        messages = []

        def die(_rule, message):
            messages.append(message)
            raise RuntimeError(message)

        with mock.patch.object(cli_runtime, "_dirty_paths", return_value=(
                "user.txt", "src/fix.py", "tests/fix_test.py", "target/a.o")), mock.patch.object(
                cli_runtime, "sh", return_value=HEAD):
            with self.assertRaises(RuntimeError):
                gate_repair_commit(value, {"paths": ("src/fix.py", "extra.py")}, die)
        self.assertIn("tests/fix_test.py", messages[0])
        self.assertIn("extra.py", messages[0])
        self.assertNotIn("target/a.o", messages[0])


if __name__ == "__main__":
    unittest.main()
