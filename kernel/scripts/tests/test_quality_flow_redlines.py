#!/usr/bin/env python3
"""Cross-stage redlines that prevent quality loops and review bypasses."""

import json
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.moonlight import step_kind  # noqa: E402


def read(relative):
    with open(os.path.join(ROOT, relative), encoding="utf-8") as stream:
        return stream.read()


class QualityFlowRedlineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.flow = json.loads(read("flow/flow.json"))

    def test_quality_agents_never_commit_their_own_changes(self):
        for name in (
                "verify_ponytail.md", "verify_codecheck.md",
                "tw_codecheck.md", "rf_codecheck.md",
                "verify_ut.md", "tw_ut.md", "rf_ut.md",
                "quality_recompile.md", "quality_rework.md"):
            with self.subTest(name=name):
                content = read("flow/steps/" + name).lower()
                self.assertNotIn("git commit", content)
                self.assertNotIn("git add ", content)

    def test_legacy_recompile_cannot_return_to_ponytail(self):
        content = read("flow/steps/verify_recompile.md")
        self.assertNotIn("Ponytail", content)
        self.assertIn("统一质量改动检视", content)
        self.assertEqual(
            "quality_review",
            self.flow["steps"]["verify_recompile"]["next"])

    def test_every_quality_compile_bridge_is_moonlight_quality(self):
        for step_id, step in self.flow["steps"].items():
            evidence = step.get("evidence") or ()
            if step.get("next") != "quality_review" or not any(
                    row.get("agent") == "COMPILE" for row in evidence):
                continue
            with self.subTest(step=step_id):
                self.assertEqual("compile", step_kind(step_id))

    def test_delivery_cannot_bypass_exact_manifest_commit(self):
        delivery = self.flow["steps"]["delivery_review"]
        self.assertNotIn("skip_in_moonlight", delivery)
        self.assertIn("delivery_manifest_committed", {
            row["type"] for row in delivery["evidence"]})

    def test_unchanged_domain_archive_does_not_reuse_committed_source(self):
        guidance = read("flow/steps/delivery_review.md")
        self.assertIn("manifest set --unchanged", guidance)
        self.assertIn("已经提交的源码", guidance)
        self.assertIn("无需创建空提交", guidance)

    def test_ut_unlock_guidance_matches_the_parser_and_never_precommits(self):
        prompt = read("flow/steps/verify_ut.md")
        self.assertNotIn("--ack", prompt)
        lifecycle = read(
            "scripts/mae_flow_core/cli_commands/lifecycle.py")
        self.assertNotIn("修复后按 [单号][类型] 规范 commit", lifecycle)


if __name__ == "__main__":
    unittest.main()
