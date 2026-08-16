#!/usr/bin/env python3
"""Semantic quality review and resume policy regressions."""

import os
import json
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow import transitions  # noqa: E402


class QualityReviewCycleTests(unittest.TestCase):
    def test_every_compile_to_review_bridge_declares_recovery_context(self):
        root = os.path.abspath(os.path.join(SCRIPTS, ".."))
        with open(os.path.join(root, "flow", "flow.json"),
                  encoding="utf-8") as stream:
            flow = json.load(stream)
        for step_id, step in flow["steps"].items():
            if step.get("next") != "quality_review":
                continue
            with self.subTest(step=step_id):
                self.assertTrue(step.get("quality_review_origin"))
                self.assertTrue(step.get("quality_review_resume"))
                self.assertTrue(step.get("quality_review_rework"))

    def test_quality_context_records_semantic_resume_without_document_digest(self):
        factory = getattr(transitions, "quality_review_context", None)
        self.assertTrue(callable(factory))
        context = factory(
            "ut-source", ["src/a.cpp", "tests/a_test.cpp"], "a" * 40)
        self.assertEqual("verify_codecheck", context["resume"])
        self.assertEqual("quality_recompile", context["rework"])
        self.assertEqual(
            ["src/a.cpp", "tests/a_test.cpp"], context["changed_files"])
        self.assertNotIn("digest", context)

    def test_test_only_context_returns_to_ut_for_rework_and_verify_for_commit(self):
        factory = getattr(transitions, "quality_review_context", None)
        self.assertTrue(callable(factory))
        context = factory("ut-test", ["tests/a_test.cpp"], "b" * 40)
        self.assertEqual("verify_spec", context["resume"])
        self.assertEqual("verify_ut", context["rework"])

    def test_focused_paths_may_supply_their_real_resume_nodes(self):
        context = transitions.quality_review_context(
            "codecheck-source", ["src/a.cpp"], "b" * 40,
            resume="tw_codecheck",
        )
        self.assertEqual("tw_codecheck", context["resume"])
        self.assertEqual("quality_recompile", context["rework"])

    def test_dynamic_next_reads_only_declared_quality_context_field(self):
        state = {
            "quality_review": {
                "resume": "verify_codecheck",
                "rework": "quality_recompile",
            }
        }
        self.assertEqual(
            "verify_codecheck",
            transitions.next_step(
                {"next_from_state": "quality_review.resume"}, state),
        )
        self.assertEqual(
            "quality_recompile",
            transitions.next_step(
                {"next_from_state": "quality_review.rework"}, state),
        )

    def test_unknown_origin_is_rejected_instead_of_guessing(self):
        factory = getattr(transitions, "quality_review_context", None)
        self.assertTrue(callable(factory))
        with self.assertRaisesRegex(ValueError, "unknown quality review origin"):
            factory("mystery", ["src/a.cpp"], "c" * 40)

    def test_deferred_steps_do_not_open_their_own_review_round(self):
        """精简与规范修复只重新编译;检视留到质量链末尾一次做完。

        逐步各拉一轮人工检视，最坏要把用户叫四次，还会让 CodeCheck 反复重跑。
        """
        root = os.path.abspath(os.path.join(SCRIPTS, ".."))
        with open(os.path.join(root, "flow", "flow.json"),
                  encoding="utf-8") as stream:
            flow = json.load(stream)
        steps = flow["steps"]
        for step_id, compile_step, resume in (
                ("verify_ponytail", "verify_post_ponytail_compile",
                 "verify_codecheck"),
                ("verify_codecheck", "verify_codecheck_compile",
                 "verify_ut")):
            with self.subTest(step=step_id):
                step = steps[step_id]
                self.assertTrue(step["source_change_defer_review"])
                self.assertEqual(compile_step, step["source_change_next"])
                # 延后检视的步骤不得再声明自己的检视游标，否则会写出一个
                # 没人消费的游标，后续恢复逻辑会照它跳转。
                for key in ("quality_review_origin", "quality_review_resume",
                            "quality_review_rework"):
                    self.assertNotIn(key, step)
                self.assertEqual(resume, steps[compile_step]["next"])
                self.assertNotEqual(
                    "quality_review", steps[compile_step]["next"])

    def test_engine_skips_the_cursor_for_deferred_source_changes(self):
        """真调 done 的路由:延后检视的步骤不得写出检视游标。"""
        from unittest import mock
        from mae_flow_core.cli_commands import quality_routing as routing

        def route(step):
            state = {"current": "x", "step_heads": {"x": "a" * 40}}
            calls = []
            with mock.patch.object(
                    routing, "_set_quality_review_context",
                    side_effect=lambda *a, **k: calls.append(a)):
                with mock.patch.object(
                        routing, "_done_transition_to_recheck",
                        return_value=True):
                    # api 的属性在 _values 里late-bind,只能替换该字典。
                    with mock.patch.dict(routing.api._values, {
                            "_ensure_step_entry_head":
                                lambda *a, **k: ("a" * 40, ""),
                            "_source_changed_since":
                                lambda *a, **k: (["src/a.cpp"], ""),
                    }):
                        handled = routing._done_source_change(
                            {}, state, "x", step)
            return handled, calls

        deferred, deferred_calls = route({
            "source_change_next": "verify_codecheck_compile",
            "source_change_defer_review": True,
        })
        self.assertTrue(deferred)
        self.assertEqual([], deferred_calls, "延后检视不应写游标")

        immediate, immediate_calls = route({
            "source_change_next": "quality_recompile",
        })
        self.assertTrue(immediate)
        self.assertEqual(1, len(immediate_calls), "未声明延后的仍立即建立游标")

    def test_ut_unlock_source_still_reruns_codecheck(self):
        """UT 经用户裁决改的被测源码没过 CodeCheck，必须单独回流重跑。"""
        root = os.path.abspath(os.path.join(SCRIPTS, ".."))
        with open(os.path.join(root, "flow", "flow.json"),
                  encoding="utf-8") as stream:
            steps = json.load(stream)["steps"]
        ut = steps["verify_ut"]
        self.assertEqual("quality_recompile", ut["source_change_recheck"])
        self.assertEqual("verify_codecheck", ut["quality_review_resume"])
        self.assertEqual("quality_review", steps["quality_recompile"]["next"])
        # 而测试改动只做一次统一检视，通过后直接继续。
        self.assertEqual("verify_spec", ut["test_change_review_resume"])

    def test_post_review_steps_cannot_silently_drop_late_code_changes(self):
        """检视之后的三步都必须声明回流，否则那里的改动会被静默丢弃。

        它们既进不了交付提交(清单必须精确等于用户确认的文件)，也没有任何证据在查
        —— Agent 以为修好了，实际上那修改永远不会进提交，谁都不知道。
        """
        root = os.path.abspath(os.path.join(SCRIPTS, ".."))
        with open(os.path.join(root, "flow", "flow.json"),
                  encoding="utf-8") as stream:
            steps = json.load(stream)["steps"]
        for step_id in ("verify_spec", "domain_archive", "delivery_review"):
            with self.subTest(step=step_id):
                step = steps[step_id]
                self.assertEqual(
                    "quality_recompile", step["late_source_change_next"])
                # 回流后必须重跑 CodeCheck:这部分代码从没经过质量链。
                self.assertEqual(
                    "verify_codecheck", step["quality_review_resume"])
                self.assertEqual(
                    "quality_recompile", step["quality_review_rework"])

    def test_engine_reflows_late_code_changes(self):
        from unittest import mock
        from mae_flow_core.cli_commands import quality_routing as routing

        calls = []
        state = {"current": "verify_spec", "history": []}
        with mock.patch.object(
                routing, "_done_transition_to_recheck",
                side_effect=lambda *a, **k: calls.append(a[3]) or True):
            with mock.patch.dict(routing.api._values, {
                    "_blocking_dirty_source_paths":
                        lambda *a, **k: ["src/m.c"],
                    "sh": lambda *a, **k: "a" * 40,
            }):
                handled = routing._done_late_source_change(
                    {}, state, "verify_spec", {
                        "late_source_change_next": "quality_recompile",
                        "quality_review_origin": "ut-source",
                        "quality_review_resume": "verify_codecheck",
                        "quality_review_rework": "quality_recompile",
                    })
        self.assertTrue(handled)
        self.assertEqual(["quality_recompile"], calls)
        self.assertEqual(
            "verify_codecheck", state["quality_review"]["resume"])

    def test_clean_worktree_after_review_just_moves_on(self):
        from unittest import mock
        from mae_flow_core.cli_commands import quality_routing as routing

        with mock.patch.dict(routing.api._values, {
                "_blocking_dirty_source_paths": lambda *a, **k: []}):
            self.assertFalse(routing._done_late_source_change(
                {}, {"current": "verify_spec"}, "verify_spec",
                {"late_source_change_next": "quality_recompile"}))

    def test_late_reflow_is_bounded_so_a_night_run_cannot_spin(self):
        """回流必须有上界。

        无人值守时质量检视自动通过，回流又会重新提交并前进，HEAD 每轮都变，
        没有任何既有计数器会耗尽——一个反复"再修一点"的夜跑能整夜打转。
        """
        from unittest import mock
        from mae_flow_core.cli_commands import quality_routing as routing

        state = {"current": "verify_spec", "history": []}
        step = {
            "late_source_change_next": "quality_recompile",
            "quality_review_origin": "ut-source",
            "quality_review_resume": "verify_codecheck",
            "quality_review_rework": "quality_recompile",
        }
        reflows, died = [], []

        def run():
            with mock.patch.object(
                    routing, "_done_transition_to_recheck",
                    side_effect=lambda *a, **k: reflows.append(a[3]) or True):
                def die(_st, message):
                    died.append(message)
                    raise SystemExit(2)   # 生产里 _done_save_die 一定抛

                with mock.patch.object(
                        routing, "_done_save_die", side_effect=die):
                    with mock.patch.dict(routing.api._values, {
                            "_blocking_dirty_source_paths":
                                lambda *a, **k: ["src/m.c"],
                            "sh": lambda *a, **k: "a" * 40,
                    }):
                        try:
                            routing._done_late_source_change(
                                {}, state, "verify_spec", step)
                        except SystemExit:
                            pass

        for _ in range(routing.LATE_REFLOW_LIMIT + 1):
            run()

        self.assertEqual(
            routing.LATE_REFLOW_LIMIT, len(reflows), "回流次数必须封顶")
        self.assertEqual(1, len(died), "超限后必须停下来，不能继续打转")
        # 停下来也必须给出真实出路，否则就是把活锁换成死锁。
        self.assertIn("git checkout --", died[0])
        self.assertIn("moonlight defer", died[0])


if __name__ == "__main__":
    unittest.main()
