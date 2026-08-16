#!/usr/bin/env python3
"""Story-centered pre-code workflow regression."""

import json
import os
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class Spec2CodeWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(
                os.path.join(ROOT, "flow", "flow.json"),
                encoding="utf-8") as stream:
            cls.flow = json.load(stream)

    def test_full_chain_uses_story_as_the_only_precode_design_artifact(self):
        steps = self.flow["steps"]
        self.assertEqual("grill", steps["branch_create"]["next"]["full"])
        self.assertEqual("story", steps["open"]["next"])
        self.assertEqual("build", steps["story"]["next"])
        self.assertEqual("story", steps["design"]["next"])
        self.assertEqual("story", steps["story_ask"]["next"])

    def test_all_workflows_use_one_implementation_and_precommit_review(self):
        steps = self.flow["steps"]
        self.assertEqual("build", steps["hf_open"]["next"])
        self.assertEqual("build", steps["tw_open"]["next"])
        self.assertEqual("build", steps["rf_triage"]["next"])
        self.assertEqual({
            "disabled": "build_review",
            "enabled": "build_agent_review",
        }, steps["build"]["next"])
        self.assertEqual("build_review", steps["build_agent_review"]["next"])
        self.assertEqual("build_commit", steps["build_review"]["next"]["continue"])
        self.assertEqual("build_rework", steps["build_review"]["next"]["revise"])
        self.assertEqual("build_review", steps["build_rework"]["next"])

    def test_quality_changes_share_one_review_and_commit_corridor(self):
        steps = self.flow["steps"]
        # 精简与规范修复各自的编译节点回到质量链，不再各拉一轮人工检视;
        # UT 之后统一检视一次。
        self.assertEqual(
            "verify_codecheck", steps["verify_post_ponytail_compile"]["next"])
        self.assertEqual(
            "verify_ut", steps["verify_codecheck_compile"]["next"])
        self.assertEqual(
            "quality_review", steps["quality_recompile"]["next"])
        self.assertEqual(
            "quality_commit", steps["quality_review"]["next"]["continue"])
        self.assertEqual(
            "quality_rework", steps["quality_review"]["next"]["revise"])
        self.assertEqual(
            {
                "verify_codecheck", "tw_codecheck", "rf_codecheck",
                "verify_spec", "tw_verify", "domain_archive",
            },
            set(steps["quality_commit"]["dynamic_next"]),
        )
        self.assertTrue(steps["quality_review"]["skip_in_moonlight"])
        self.assertEqual(
            "continue", steps["quality_review"]["moonlight_choice"])

    def test_story_loop_binds_local_spec_grill_and_story(self):
        steps = self.flow["steps"]
        evidence = steps["open"]["evidence"]
        self.assertIn("local_spec_valid", tuple(
            item["type"] for item in evidence))
        self.assertEqual(
            [".mae-flow-work/{单号}/grill.md"],
            next(item for item in evidence if item["type"] == "glob")["any"],
        )
        self.assertEqual(
            [".mae-flow-work/{单号}/story.md"],
            steps["story"]["evidence"][0]["any"],
        )

    def test_other_workflow_entries_remain_unchanged(self):
        steps = self.flow["steps"]
        self.assertEqual("code_reviewer_ask", steps["workflow_select"]["next"])
        reviewer = steps["code_reviewer_ask"]
        self.assertEqual("code_reviewer", reviewer["choice_key"])
        self.assertEqual({"disabled", "enabled"}, set(reviewer["choices"]))
        self.assertEqual("branch_create", reviewer["next"])
        self.assertTrue(reviewer["skip_in_moonlight"])
        self.assertEqual("enabled", reviewer["moonlight_choice"])
        self.assertEqual("hf_open", steps["branch_create"]["next"]["hotfix"])
        self.assertEqual("tw_open", steps["branch_create"]["next"]["tweak"])
        self.assertEqual("rf_triage", steps["branch_create"]["next"]["review"])
        self.assertEqual("build", steps["hf_open"]["next"])
        self.assertEqual("build", steps["tw_open"]["next"])

    def test_branch_prompt_explains_moonlight_noninteractive_resolution(self):
        with open(
                os.path.join(ROOT, "flow", "steps", "branch_create.md"),
                encoding="utf-8") as stream:
            prompt = stream.read()
        self.assertIn("禁止执行 AskUserQuestion", prompt)
        self.assertIn(".mae-flow.json.last", prompt)
        self.assertIn("自动登记硬阻塞", prompt)


if __name__ == "__main__":
    unittest.main()
