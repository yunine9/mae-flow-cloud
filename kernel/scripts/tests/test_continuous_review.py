#!/usr/bin/env python3
"""Cloud continuous-review is opt-in, durable and never a fresh workflow."""

import hashlib
import base64
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
    _route_external_verification, cmd_pipeline,
)
from mae_flow_core.cli_commands.host_capability import verify_host_proof  # noqa: E402
from mae_flow_core.cli_commands import host_capability  # noqa: E402
from mae_flow_core.cli_commands import host_receipts  # noqa: E402
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


def without_host_nonces(value):
    copied = json.loads(json.dumps(value, ensure_ascii=False))
    for key in ("host_capability_nonces", "state_version", "revision", "updated_at"):
        copied.pop(key, None)
    return copied


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
    def setUp(self):
        super().setUp()
        self.proof = mock.patch.object(
            delivery, "_verify_host_proof", return_value={
                "root": "/host-only",
                "proof": {"nonce": "test-proof-nonce"},
                "payload": {},
            })
        self.proof.start()
        self.save_proof = mock.patch.object(delivery, "save_with_host_proof")
        self.save_proof.start()
        self.trusted = mock.patch.object(
            delivery, "trusted_pipeline_projection", return_value=True)
        self.trusted.start()

    def tearDown(self):
        self.trusted.stop()
        self.save_proof.stop()
        self.proof.stop()
        super().tearDown()

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
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_old_cloud_terminal_can_be_adopted_without_reinit_or_history_loss(self):
        value = self.live_state("end")
        value["execution_contract"]["continuous_review"] = False
        before = list(value["history"])
        path = self.write_json("migration.json", {
            "schema": delivery.BATCH_SCHEMA,
            "mode": "adopt-watch",
            "batch_id": "migration:task-7",
        })
        args = SimpleNamespace(delivery_action="feedback-open", file=path)
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual("delivery_watch", value["current"])
        self.assertTrue(value["execution_contract"]["continuous_review"])
        self.assertEqual(before, value["history"])
        self.assertFalse(os.path.exists(".mae-flow.json.last"))
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

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
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_result_requires_one_receipt_per_item(self):
        value = self.live_state()
        open_path = self.write_json("batch.json", batch(base=self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=open_path))
        result_path = self.write_json("result.json", {
            "schema": delivery.RESULT_SCHEMA, "batch_id": "fb-1", "results": [],
        })
        with self.assertRaises(SystemExit):
            with mock.patch.object(
                    delivery, "_verify_host_proof", return_value="queue-test-proof"):
                delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                    delivery_action="feedback-result", file=result_path))

    def test_red_feedback_replaces_awaiting_writer_and_later_pass_closes_both(self):
        value = self.live_state("external_verify")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "delivery_round": 1,
            "active_batch_id": "fb-old",
            "close_events": [],
            "batches": [{
                "batch_id": "fb-old", "status": "awaiting_verification",
                "base_sha": self.head, "items": [],
            }],
        }
        path = self.write_json("red.json", batch("fb-red", self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=path))
        old, current = value["delivery_loop"]["batches"]
        self.assertEqual("addressed", old["status"])
        self.assertEqual("repairing", current["status"])
        self.assertEqual("fb-red", value["delivery_loop"]["active_batch_id"])
        self.assertEqual("feedback_triage", value["current"])
        current["status"] = "awaiting_verification"
        self.assertFalse(delivery.complete_verified_feedback(value, self.head))
        self.assertEqual(["closed", "closed"],
                         [item["status"] for item in value["delivery_loop"]["batches"]])

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
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_merged_close_records_clean_local_commits_not_in_mr(self):
        value = self.live_state()
        with open("tracked.txt", "a", encoding="utf-8") as stream:
            stream.write("local-only\n")
        subprocess.run(["git", "add", "tracked.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "local-only"], check=True)
        local_head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip()
        args = SimpleNamespace(
            delivery_action="close", reason="merged", sha=self.head,
            event_id="merge-with-local")
        delivery.cmd_delivery({"steps": {"end": {"terminal": True}}}, value, args)
        event = value["delivery_loop"]["close_events"][-1]
        self.assertEqual(local_head, event["local_head"])
        self.assertEqual([local_head], [
            item["sha"] for item in event["unpushed_local_commits"]])
        self.assertEqual([], event["unpushed_local_paths"])


class DeliveryHostProofTests(TempProject):
    def trusted_layout(self, exponent="AQAB"):
        root = tempfile.TemporaryDirectory()
        workspace = os.path.join(root.name, "task-7")
        repository = os.path.join(workspace, "repo")
        os.makedirs(repository)
        old = os.getcwd()
        os.chdir(repository)
        trust = os.path.join(root.name, ".host-capabilities")
        os.makedirs(trust, mode=0o700)
        trust = os.path.realpath(trust)
        os.chmod(trust, 0o700)
        n = base64.urlsafe_b64encode(b"\x80" + b"\0" * 255).decode().rstrip("=")
        authority = {
            "schema": "mae-flow-host-authority/1", "alg": "RS256",
            "key_id": hashlib.sha256((n + "." + exponent).encode()).hexdigest()[:24],
            "task_id": "task-7", "n": n, "e": exponent,
        }
        capability = os.path.join(
            trust, hashlib.sha256(b"task-7").hexdigest() + ".json")
        with open(capability, "w", encoding="utf-8") as stream:
            json.dump({"schema": "mae-flow-host-capability/1",
                       "authority": authority, "private_key": "not-readable"}, stream)
        os.chmod(capability, 0o600)
        binding = os.path.join(
            trust, "binding-" + hashlib.sha256(
                os.path.realpath(repository).encode("utf-8")).hexdigest() + ".json")
        with open(binding, "w", encoding="utf-8") as stream:
            json.dump({
                "schema": "mae-flow-host-binding/1",
                "task_id": "task-7",
                "workspace": os.path.realpath(workspace),
                "cwd": os.path.realpath(repository),
                "continuous_review": True,
            }, stream)
        os.chmod(binding, 0o600)
        return root, old, trust, authority

    def test_forged_proof_is_rejected_even_when_shell_obfuscation_evades_hint(self):
        value = state()
        value["execution_contract"]["host_authority"] = {
            "schema": "mae-flow-host-authority/1",
            "alg": "RS256", "key_id": "test", "task_id": "task-7",
            "n": "AQ", "e": "Aw",
        }
        payload = batch(base=self.head)
        payload_path = self.write_json("batch.json", payload)
        proof_path = self.write_json("forged.json", {
            "schema": "mae-flow-host-proof/1",
            "task_id": "task-7", "action": "feedback-open",
            "payload_digest": hashlib.sha256(
                json.dumps(payload, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")).hexdigest(),
            "nonce": "forged", "issued_at": int(delivery.time.time()),
            "signature": "ZmFrZQ",
        })
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-open", file=payload_path,
                host_proof=proof_path))
        self.assertNotIn("delivery_loop", value)

    def test_mutated_state_authority_cannot_replace_external_trust_root(self):
        root, old, trust, authority = self.trusted_layout()
        try:
            value = state()
            value["execution_contract"]["host_authority"] = {
                **authority, "key_id": "attacker", "e": "AQ",
            }
            payload = batch(base=HEAD)
            proof = {
                "schema": "mae-flow-host-proof/1", "task_id": "task-7",
                "action": "feedback-open",
                "payload_digest": hashlib.sha256(
                    json.dumps(payload, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")).encode()).hexdigest(),
                "nonce": "forged", "issued_at": int(delivery.time.time()),
                "signature": "ZmFrZQ",
            }
            proof_path = os.path.join(trust, "proof-forged.json")
            with open(proof_path, "w", encoding="utf-8") as stream:
                json.dump(proof, stream)
            os.chmod(proof_path, 0o600)
            with self.assertRaises(SystemExit):
                verify_host_proof(value, proof_path, "feedback-open", payload)
            self.assertNotIn("delivery_loop", value)
        finally:
            os.chdir(old)
            root.cleanup()

    def test_weak_rsa_exponent_is_rejected_at_external_root(self):
        root, old, trust, authority = self.trusted_layout("AQ")
        try:
            value = state()
            value["execution_contract"]["host_authority"] = authority
            proof_path = os.path.join(trust, "proof-weak.json")
            with open(proof_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "schema": "mae-flow-host-proof/1", "task_id": "task-7",
                    "action": "feedback-open", "payload_digest": "0" * 64,
                    "nonce": "weak", "issued_at": int(delivery.time.time()),
                    "signature": "ZmFrZQ",
                }, stream)
            os.chmod(proof_path, 0o600)
            with self.assertRaises(SystemExit):
                verify_host_proof(value, proof_path, "feedback-open", batch())
        finally:
            os.chdir(old)
            root.cleanup()

    def test_continuous_pipeline_record_requires_host_proof(self):
        value = state("external_verify")
        facts = self.write_json("pipeline.json", {
            "sha": self.head, "status": "success",
        })
        with self.assertRaises(SystemExit):
            cmd_pipeline({"steps": {}}, value, SimpleNamespace(
                action="record", file=facts, host_proof=None))
        self.assertNotIn("pipeline", value.get("quality", {}))

    def test_external_binding_cannot_be_disabled_from_mutable_state(self):
        root, old, _trust, _authority = self.trusted_layout()
        try:
            value = state("external_verify")
            value["execution_contract"].pop("continuous_review", None)
            value["execution_contract"].pop("host_authority", None)
            facts = self.write_json("pipeline.json", {
                "sha": HEAD, "status": "success",
            })
            with self.assertRaises(SystemExit):
                cmd_pipeline({"steps": {}}, value, SimpleNamespace(
                    action="record", file=facts, host_proof=None))
            self.assertNotIn("pipeline", value.get("quality", {}))
        finally:
            os.chdir(old)
            root.cleanup()

    def test_host_projection_seals_complete_lifecycle(self):
        value = state("delivery_watch")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-1",
            "batches": [{
                "batch_id": "fb-1", "status": "closed",
                "results": [{"id": "one", "status": "fixed"}],
            }],
            "close_events": [],
        }
        value["quality"] = {"external_verification": {
            "verdict": "PASS", "sha": HEAD,
        }}
        projection = host_receipts.host_projection(
            value, "pipeline-record", {})
        self.assertEqual(host_receipts.LIFECYCLE_SCHEMA, projection["schema"])
        self.assertEqual("delivery_watch", projection["current"])
        self.assertEqual("fb-1", projection["active_batch_id"])
        # 封的是摘要不是正文,但每一处篡改仍然照样翻脸。
        for mutate in (
            lambda st: st["delivery_loop"]["batches"][0].__setitem__(
                "status", "awaiting_verification"),
            lambda st: st["delivery_loop"]["batches"][0]["results"][0].__setitem__(
                "status", "explained"),
            lambda st: st["quality"]["external_verification"].__setitem__(
                "sha", "b" * 40),
            lambda st: st.__setitem__("current", "end"),
            lambda st: st.__setitem__("user_intervention", {"id": "forged"}),
        ):
            tampered = json.loads(json.dumps(value, ensure_ascii=False))
            mutate(tampered)
            self.assertNotEqual(
                projection,
                host_receipts.host_projection(tampered, "pipeline-record", {}))

    def test_receipt_size_stays_constant_under_heavy_feedback(self):
        """一轮量大但完全合法的检视不得把收据撑过读取上限。

        2026-09-01 实测事故:投影原来封整份 delivery_loop,12 条 350 字的
        MR 意见(内核自己允许单条 4000 字)就越过 32 KiB;此后 feedback、
        pipeline record、连 MR 合入后的 close 全部永久失败,无命令可救。
        """
        value = state("feedback_triage")
        body = "空值分支没覆盖上游返回空值的情况，请补单测并说明预期语义。" * 12
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-big",
            "close_events": [],
            "batches": [{
                "batch_id": "fb-big", "status": "repairing", "base_sha": HEAD,
                "items": [{
                    "id": "mr:d-%s" % index, "source": "mr_discussion",
                    "source_id": "d-%s" % index, "summary": body[:4000],
                    "material": "../reviews/discussions.json",
                    "verification": "reviewer",
                } for index in range(40)],
                "results": [{
                    "id": "mr:d-%s" % index, "status": "fixed",
                    "summary": body[:4000], "evidence": body[:4000],
                } for index in range(40)],
            }],
        }
        raw = len(host_capability._canonical(
            value["delivery_loop"]).encode("utf-8"))
        projection = host_receipts.host_projection(
            value, "feedback-result", {})
        sealed = len(host_capability._canonical(projection).encode("utf-8"))
        self.assertGreater(raw, host_receipts._RECEIPT_LIMIT,
                           "夹具本身必须真的超过读取上限才算复现")
        self.assertLess(sealed, 2048,
                        "投影体积必须与反馈数量无关，否则收据迟早读不回来")

    def test_trusted_receipt_accepts_utf8_projection(self):
        projection = {"summary": "流水线问题已修复", "status": "fixed"}
        payload = {"batch_id": "fb-中文"}
        proof = {
            "schema": host_capability.PROOF_SCHEMA,
            "task_id": "task-7", "action": "feedback-result",
            "payload_digest": hashlib.sha256(
                host_capability._canonical(payload).encode("utf-8")).hexdigest(),
            "nonce": "utf8", "issued_at": int(delivery.time.time()),
            "signature": "signed",
        }
        record = {
            "schema": "mae-flow-host-receipt/1",
            "proof": proof,
            "payload_digest": host_receipts._digest(payload),
            "projection": projection,
            "projection_digest": hashlib.sha256(
                host_capability._canonical(projection).encode("utf-8")).hexdigest(),
        }
        with mock.patch.object(
                host_receipts, "_verify_rsa_sha256", return_value=True):
            self.assertTrue(host_receipts._valid_stored_receipt(
                {"task_id": "task-7"}, record, "feedback-result", projection))
            # 收据绑的是这一把公钥所属的任务，换个任务立刻不认。
            self.assertFalse(host_receipts._valid_stored_receipt(
                {"task_id": "task-8"}, record, "feedback-result", projection))

    def test_proof_reaching_the_trust_root_through_a_symlink_is_accepted(self):
        """<data> 经过软链是常态(macOS 的 /var、容器挂载、盘迁移)。

        原来拿未解引用的 abspath 去和 realpath 化的信任根比,只要中间有
        一层软链就永远不相等,一条宿主命令都过不去(实测)。
        """
        root, old, trust, authority = self.trusted_layout()
        try:
            link = os.path.join(root.name, "link-to-trust")
            os.symlink(trust, link)
            proof_path = os.path.join(trust, "proof-linked.json")
            with open(proof_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "schema": host_capability.PROOF_SCHEMA,
                    "task_id": "task-7", "action": "feedback-open",
                    "payload_digest": "0" * 64, "nonce": "linked",
                    "issued_at": int(delivery.time.time()),
                    "signature": "ZmFrZQ",
                }, stream)
            os.chmod(proof_path, 0o600)
            value = state()
            # 走软链路径进来:必须走到"签名无效"才算路径这关过了；
            # 挂在"不在信任根内"就是本次修复要消灭的那种早死。
            with self.assertRaises(SystemExit):
                host_capability.verify_host_proof(
                    value, os.path.join(link, "proof-linked.json"),
                    "feedback-open", batch())
            payload, resolved = host_capability._proof_payload(
                os.path.join(link, "proof-linked.json"))
            self.assertEqual(trust, resolved)
            self.assertEqual("linked", payload["nonce"])
        finally:
            os.chdir(old)
            root.cleanup()

    def test_one_unreadable_receipt_never_kills_every_later_host_command(self):
        """历史台账体检失败不许升级成拒绝服务。

        原来三个扫描函数对每份历史收据都走严格读取,任何一份权限被动过、
        体积超限或写坏,SystemExit 会掀掉整条宿主命令——反馈、流水线登记
        乃至 MR 合入后的 close 一起永久失败,且无命令可救。
        """
        root, old, trust, _authority = self.trusted_layout()
        try:
            value = state("delivery_watch")
            projection = host_receipts.host_projection(
                value, "pipeline-record", {})
            prefix = host_receipts._receipt_prefix("task-7")
            good = os.path.join(trust, "%sgood.json" % prefix)
            with open(good, "w", encoding="utf-8") as stream:
                stream.write(host_capability._canonical({
                    "schema": host_receipts.RECEIPT_SCHEMA,
                    "proof": {
                        "schema": host_capability.PROOF_SCHEMA,
                        "task_id": "task-7", "action": "pipeline-record",
                        "payload_digest": host_receipts._digest({}),
                        "nonce": "good", "issued_at": 0, "signature": "signed",
                    },
                    "payload_digest": host_receipts._digest({}),
                    "projection": projection,
                    "projection_digest": host_receipts._digest(projection),
                }))
            os.chmod(good, 0o600)
            # 一份写坏的、一份超限的、一份权限被动过的历史收据。
            broken = os.path.join(trust, "%sbroken.json" % prefix)
            with open(broken, "w", encoding="utf-8") as stream:
                stream.write("{ not json")
            os.chmod(broken, 0o600)
            huge = os.path.join(trust, "%shuge.json" % prefix)
            with open(huge, "w", encoding="utf-8") as stream:
                stream.write("x" * (host_receipts._RECEIPT_LIMIT + 1))
            os.chmod(huge, 0o600)
            loose = os.path.join(trust, "%sloose.json" % prefix)
            with open(loose, "w", encoding="utf-8") as stream:
                stream.write("{}")
            os.chmod(loose, 0o644)
            with mock.patch.object(
                    host_receipts, "_verify_rsa_sha256", return_value=True):
                self.assertTrue(host_receipts.trusted_projection(
                    value, "pipeline-record", projection))
                self.assertTrue(host_receipts.trusted_pipeline_projection(
                    value, host_receipts.external_facts(value)))
                # 跳过坏件不等于放行伪证:签名不过照样是 False。
                with mock.patch.object(
                        host_receipts, "_verify_rsa_sha256", return_value=False):
                    self.assertFalse(host_receipts.trusted_projection(
                        value, "pipeline-record", projection))
        finally:
            os.chdir(old)
            root.cleanup()


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

    def test_named_conflict_path_can_cross_baseline_dirty_but_neighbors_cannot(self):
        value = state("feedback_triage")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-conflict",
            "batches": [{"batch_id": "fb-conflict", "status": "repairing"}],
        }
        value["delivery_repair_authorization"] = {
            "schema": "mae-flow-feedback-repair/1", "status": "ready",
            "batch_id": "fb-conflict", "base_sha": HEAD,
            "baseline_dirty": ["src/conflict.py", "user.txt"],
            "allowed_paths": ["src/conflict.py"],
        }
        from mae_flow_core.quality.external_repair import eligible_repair_paths
        self.assertEqual(
            ("src/conflict.py",),
            eligible_repair_paths(value, HEAD,
                                  ("src/conflict.py", "user.txt")),
        )

    def test_queued_batch_cannot_report_result_before_it_is_promoted(self):
        value = state("feedback_triage")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-active",
            "batches": [
                {"batch_id": "fb-active", "status": "repairing", "items": []},
                {"batch_id": "fb-queued", "status": "queued", "items": [
                    {"id": "q-1"},
                ]},
            ],
        }
        payload = {
            "schema": delivery.RESULT_SCHEMA,
            "batch_id": "fb-queued",
            "changed": False,
            "results": [{
                "id": "q-1", "status": "explained", "summary": "done",
            }],
        }
        with tempfile.NamedTemporaryFile("w", encoding="utf-8",
                                         suffix=".json", delete=False) as out:
            json.dump(payload, out)
            path = out.name
        try:
            with mock.patch.object(
                    delivery, "_verify_host_proof", return_value="queue-test-proof"):
                with self.assertRaises(SystemExit):
                    delivery._result({}, value, SimpleNamespace(file=path))
            self.assertEqual("queued", value["delivery_loop"]["batches"][1]["status"])
            self.assertNotIn("result_digest", value["delivery_loop"]["batches"][1])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
