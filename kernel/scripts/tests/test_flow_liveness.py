#!/usr/bin/env python3
"""Redline liveness contracts for the stable subtractive workflow."""

import json
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.transitions import transition_targets  # noqa: E402


with open(os.path.join(ROOT, "flow", "flow.json"), encoding="utf-8") as stream:
    FLOW = json.load(stream)


def reachable():
    seen, pending = set(), [FLOW["start"]]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        pending.extend(
            target for target in transition_targets(FLOW["steps"][current])
            if target not in seen)
    return seen


class FlowLivenessTests(unittest.TestCase):
    def test_every_reachable_nonterminal_step_has_a_real_successor(self):
        reached = reachable()
        self.assertIn("end", reached)
        for step_id in reached:
            step = FLOW["steps"][step_id]
            if not step.get("terminal"):
                self.assertTrue(
                    transition_targets(step),
                    "%s 没有下一步，会卡死" % step_id)

    def test_heavy_compatibility_steps_are_not_reachable(self):
        reached = reachable()
        for retired in FLOW.get("compatibility_entries", ()):
            self.assertNotIn(retired, reached)

    def test_story_review_is_single_pass_and_cannot_schedule_itself(self):
        story = FLOW["steps"]["story"]
        self.assertEqual("build", story["next"])
        self.assertEqual(1, sum(
            item.get("agent") == "REVIEWER"
            for item in story.get("evidence", ())))
        for step_id in reachable():
            step = FLOW["steps"][step_id]
            if step_id != "open":
                self.assertNotIn("story", transition_targets(step))

    def test_build_has_one_compile_then_optional_precheck_and_human_review(self):
        build = FLOW["steps"]["build"]
        self.assertIn("COMPILE", [
            item.get("agent") for item in build.get("evidence", ())])
        self.assertEqual("build_review", build["next"]["disabled"])
        self.assertEqual("build_agent_review", build["next"]["enabled"])
        self.assertEqual(
            "build_review", FLOW["steps"]["build_agent_review"]["next"])
        self.assertEqual(
            "build_commit", FLOW["steps"]["build_review"]["next"]["continue"])
        self.assertEqual(
            "build_rework", FLOW["steps"]["build_review"]["next"]["revise"])

    def test_quality_review_corridor_has_no_commit_bypass(self):
        steps = FLOW["steps"]
        # 链内的两个编译节点回到质量链本身:精简与规范修复不再各拉一轮人工检视，
        # 全部改动保持未提交，到 UT 之后统一检视一次。
        self.assertEqual(
            "verify_codecheck", steps["verify_post_ponytail_compile"]["next"])
        self.assertEqual(
            "verify_ut", steps["verify_codecheck_compile"]["next"])
        for deferred in ("verify_ponytail", "verify_codecheck"):
            with self.subTest(step=deferred):
                self.assertTrue(
                    steps[deferred]["source_change_defer_review"])
        # UT 经用户裁决改了被测源码仍单独回流,并重跑 CodeCheck。
        self.assertEqual(
            "quality_recompile", steps["verify_ut"]["source_change_recheck"])
        self.assertEqual("quality_review", steps["quality_recompile"]["next"])
        # 唯一的提交走廊仍然只有"检视通过"这一条。
        self.assertEqual(
            "quality_commit", steps["quality_review"]["next"]["continue"])
        self.assertEqual(
            "quality_rework", steps["quality_review"]["next"]["revise"])
        self.assertIn("quality_review_committed", {
            item["type"] for item in steps["quality_commit"]["evidence"]
        })

    def test_no_step_uses_agent_return_text_as_a_transition_choice(self):
        for step_id, step in FLOW["steps"].items():
            serialized = json.dumps(step, ensure_ascii=False)
            for forbidden in (
                    "_RESULT:", "TASK_CARD_SHA256", "reviewer_digest",
                    "capability.retry"):
                self.assertNotIn(forbidden, serialized, step_id)

    def test_every_delivery_path_archives_domain_truth_exactly_once(self):
        self.assertEqual("domain_archive", FLOW["steps"]["verify_spec"]["next"])
        self.assertEqual("domain_archive", FLOW["steps"]["tw_verify"]["next"])
        self.assertEqual("domain_archive", FLOW["steps"]["rf_ut"]["next"])
        self.assertEqual("delivery_review", FLOW["steps"]["domain_archive"]["next"])
        self.assertEqual("push", FLOW["steps"]["delivery_review"]["next"])
        for step_id in reachable():
            if step_id != "domain_archive":
                self.assertNotEqual(
                    "domain_archive",
                    FLOW["steps"][step_id].get("next")
                    if step_id not in {"verify_spec", "tw_verify", "rf_ut"}
                    else "allowed",
                    step_id)

    def test_legacy_archive_steps_are_one_way_recovery_bridges(self):
        for step_id in ("archive_confirm", "archive"):
            self.assertNotIn(step_id, reachable())
            self.assertEqual("domain_archive", FLOW["steps"][step_id]["next"])

def _quality_evidence(step):
    return any(
        item.get("agent") in ("COMPILE", "CODECHECK", "UT")
        or item.get("type") == "review_codecheck"
        for item in step.get("evidence", ()))


def _source_guards(step):
    """本步对"源码变了"这件事有没有任何一种机器保护。"""
    guards = []
    if any(item.get("agent") == "COMPILE"
           for item in step.get("evidence", ())):
        guards.append("recompile")
    if any(item.get("type") == "review_snapshot"
           for item in step.get("evidence", ())):
        guards.append("review_snapshot")
    for key in ("late_source_change_next", "source_change_next",
                "source_change_recheck"):
        if step.get(key):
            guards.append(key)
    return guards


class FlowWiringContractTests(unittest.TestCase):
    """新增流程节点必须接全。

    现有红线管的是"删了没清干净";这两条管"加了没接全"——同样会出真故障，
    而且只在夜跑或异常恢复时才暴露。
    """

    def test_every_quality_step_is_registered_for_moonlight_defer(self):
        """有质量证据的步骤必须能被月光宝盒登记遗留，否则夜里撞上就没有出口。"""
        from mae_flow_core.moonlight import QUALITY_STEPS

        missing = sorted(
            step_id for step_id in reachable()
            if _quality_evidence(FLOW["steps"][step_id])
            and step_id not in QUALITY_STEPS)
        self.assertEqual([], missing)

    def test_no_step_lets_changed_source_reach_push_unverified(self):
        """改了源码之后，不存在一条能绕过全部机器检查直达 push 的路径。

        瘦身删掉"本步不许改源码"之后，这条是替代保障:每个可达步骤要么自己重新
        编译、要么拒绝脏源码、要么声明回流，否则改动会静默丢弃或未经编译上车。
        """
        steps = FLOW["steps"]

        def slides_to_push(start):
            seen, pending = set(), [start]
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                if current == "push":
                    return True
                pending.extend(
                    target for target in transition_targets(
                        steps.get(current, {}))
                    if target in steps
                    and not _source_guards(steps[target])
                    and target not in seen)
            return False

        unguarded = sorted(
            step_id for step_id in reachable()
            if step_id != "push"
            and not _source_guards(steps[step_id])
            and slides_to_push(step_id))
        self.assertEqual([], unguarded)


    def test_every_step_valued_key_is_a_declared_transition(self):
        """凡是取值为真实步骤名的键，都必须被 transition_targets 看见。

        漏登记不会在运行期报错(done 直接改 current)，但图校验、活性红线和环分析
        会全部对那条边失明——`late_source_change_next` 加进来时就漏了一轮。
        """
        steps = FLOW["steps"]
        # 这些键的目标由别的步骤经 dynamic_next / next_from_state 消费，
        # 不是本步自己的出边。
        indirect = {
            "quality_review_resume", "quality_review_rework",
            "test_change_review_resume", "test_change_review_rework",
        }
        violations = []
        for step_id, step in sorted(steps.items()):
            declared = set(transition_targets(step))
            for key, value in step.items():
                if key in indirect or not isinstance(value, str):
                    continue
                if value in steps and value not in declared:
                    violations.append(
                        "%s.%s → %s 未登记为转移边" % (step_id, key, value))
        self.assertEqual([], violations)


if __name__ == "__main__":
    unittest.main()
