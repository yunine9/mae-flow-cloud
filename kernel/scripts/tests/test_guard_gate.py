#!/usr/bin/env python3
"""Pure Gate decision tests."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.guard.gate import (  # noqa: E402
    BashWriteContext,
    EditGateContext,
    decide_bash_write,
    decide_edit,
)


class EditGateTests(unittest.TestCase):
    def context(self, **overrides):
        values = {
            "path": "README.md",
            "match_path": "README.md",
            "step": "build",
            "inside_plugin": False,
            "is_source": False,
            "tests_only_patterns": (),
            "source_unlocked": False,
        }
        values.update(overrides)
        return EditGateContext(**values)

    def test_internal_state_and_secret_are_absolute_blocks(self):
        for path, fragment in (
            (".mae-flow.json", "流程状态"),
            (".env.production", ".env 类密钥文件"),
            ("/plugin/scripts/mae-flow.py", "禁止修改插件自身"),
        ):
            with self.subTest(path=path):
                result = decide_edit(self.context(
                    path=path, match_path=path,
                    inside_plugin=path.startswith("/plugin/")))
                self.assertEqual("absolute", result.kind)
                self.assertIn(fragment, result.message)

    def test_ut_step_still_blocks_editing_product_code(self):
        """瘦身保留项:改产品代码让测试变绿是破坏信任，不是可逆的流程瑕疵。"""
        tests_only = decide_edit(self.context(
            path="src/main.py", match_path="src/main.py",
            is_source=True, tests_only_patterns=(r"(^|/)tests/",)))
        self.assertEqual(("block", "edit-tests-only"),
                         (tests_only.kind, tests_only.rule))
        self.assertIn("unlock source", tests_only.message)

    def test_process_nudges_no_longer_block_editing(self):
        """本步不许改源码/写规格/写需求文档已退役:可逆动作交给 done 的证据检查。"""
        for label, context in (
                ("specs", self.context(
                    path="openspec/specs/api/spec.md",
                    match_path="openspec/specs/api/spec.md")),
                ("source", self.context(
                    path="src/main.py", match_path="src/main.py",
                    is_source=True)),
                ("docs-req", self.context(
                    path="docs/req/REQ1.md", match_path="docs/req/REQ1.md",
                    step="config_confirm")),
        ):
            with self.subTest(rule=label):
                self.assertEqual("allow", decide_edit(context).kind)

    def test_allowed_edit_has_no_rule_or_message(self):
        self.assertEqual(
            ("allow", "", ""),
            tuple(decide_edit(self.context())),
        )


class BashWriteGateTests(unittest.TestCase):
    def context(self, **overrides):
        values = {
            "command": "echo ok",
            "tokens": (),
            "writeish": False,
            "hits_internal_state": False,
            "step": "build",
            "offenders": (),
            "tests_only_patterns": (),
            "source_unlocked": False,
            "bad_test_sources": (),
        }
        values.update(overrides)
        return BashWriteContext(**values)

    def test_retired_engine_and_internal_state_are_absolute(self):
        retired = decide_bash_write(self.context(
            command="COMET_FORCE_PHASE=verify tool"))
        self.assertEqual("absolute", retired.kind)
        self.assertIn("已退役", retired.message)
        internal = decide_bash_write(self.context(
            writeish=True, hits_internal_state=True))
        self.assertEqual("absolute", internal.kind)
        self.assertIn("流程状态", internal.message)

    def test_process_nudges_no_longer_block_bash_writes(self):
        """经 Bash 写需求/规格/源码的流程督促已退役——且门禁已看不见这些信号。

        这些督促曾经靠 hits_requirement / hits_specs_truth / source_tokens /
        allow_source_edit 判定。退役后字段还挂在 context 上空转了一段时间,
        现已删除:退役从"传进去也不拦"升级为"根本无法表达"。
        """
        retired = {"hits_requirement", "hits_specs_truth", "source_tokens",
                   "allow_source_edit", "allow_specs_write",
                   "strong_write", "weak_write"}
        self.assertEqual(
            set(), retired & set(BashWriteContext.__dataclass_fields__))
        # 仍可表达的那一例:只有源码 offenders、没有 tests_only 时不拦
        self.assertEqual("allow", decide_bash_write(self.context(
            offenders=("src/main.py",))).kind)

    def test_ut_step_still_blocks_bash_writes_to_product_code(self):
        result = decide_bash_write(self.context(
            offenders=("src/main.py",),
            tests_only_patterns=(r"(^|/)tests/",),
            bad_test_sources=("src/main.py",),
        ))
        self.assertEqual(("block", "bash-tests-only"),
                         (result.kind, result.rule))


if __name__ == "__main__":
    unittest.main()
