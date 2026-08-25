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
            (".mae-flow-work/plugin-resources/assets/GRILL-PREP-TEMPLATE.md",
             "只读资源"),
            (".mae-flow-work/repository-skills/java/SKILL.md", "只读资源"),
            (".mae-flow-work/host-skills/abc/SKILL.md", "只读资源"),
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

    def test_legal_source_step_and_process_documents_remain_writable(self):
        """合法编码步可写源码；文档与过程产物不受源码阶段闸影响。"""
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

    def test_flow_head_blocks_source_until_workflow_chosen(self):
        """交付方式未选定=流程头部,源码一行不许动(2026-08-19 跨仓实锤:
        需求正文带实施方案,模型跳过配置直接开写,写完才回头问配置)。
        文档不受限;用户裁决解锁尊重;选定后即回到退役口径(不拦)。"""
        head = decide_edit(self.context(
            path="src/main.py", match_path="src/main.py",
            step="config_confirm", is_source=True, workflow_chosen=False))
        self.assertEqual(("block", "edit-before-workflow"),
                         (head.kind, head.rule))
        self.assertIn("交付方式尚未选定", head.message)
        self.assertIn("current", head.message)
        # 需求/方案文档在头部照写不误——分析结论就该落在这儿。
        self.assertEqual("allow", decide_edit(self.context(
            path="docs/req/REQ1.md", match_path="docs/req/REQ1.md",
            step="config_confirm", workflow_chosen=False)).kind)
        # 用户裁决解锁压过头部禁令(人高于流程)。
        self.assertEqual("allow", decide_edit(self.context(
            path="src/main.py", match_path="src/main.py", is_source=True,
            workflow_chosen=False, source_unlocked=True)).kind)
        # 选定之后回到退役口径:中段改源码不再逐步拦。
        self.assertEqual("allow", decide_edit(self.context(
            path="src/main.py", match_path="src/main.py",
            is_source=True, workflow_chosen=True)).kind)

    def test_grill_and_review_steps_cannot_edit_source(self):
        """flow.json 未显式授权写源码的阶段必须机械阻断，而非靠提示词。"""
        for step in ("grill", "story", "build_review", "delivery_review"):
            with self.subTest(step=step):
                denied = decide_edit(self.context(
                    path="src/main.py", match_path="src/main.py",
                    step=step, is_source=True, workflow_chosen=True,
                    allow_source_edit=False))
                self.assertEqual(
                    ("absolute", "edit-outside-source-step"),
                    (denied.kind, denied.rule))
                self.assertIn("current", denied.message)
        self.assertEqual("allow", decide_edit(self.context(
            path=".mae-flow-work/REQ/grill.md",
            match_path=".mae-flow-work/REQ/grill.md", step="grill",
            is_source=False, allow_source_edit=False)).kind)
        self.assertEqual("allow", decide_edit(self.context(
            path="src/main.py", match_path="src/main.py", step="build",
            is_source=True, allow_source_edit=True)).kind)

    def test_new_test_file_in_compile_step_advises_not_blocks(self):
        """编码步手写 UT 是抢跑白费(2026-08-20 云端实锤):只提醒不拦。
        修改已有测试合法(重构会弄坏旧测试),非测试新文件不提醒。"""
        preempt = decide_edit(self.context(
            path="tests/test_new.py", match_path="tests/test_new.py",
            is_source=True, compile_step=True, new_file=True,
            is_test_path=True))
        self.assertEqual(("advisory", "edit-ut-preempt"),
                         (preempt.kind, preempt.rule))
        self.assertIn("不计任何证据", preempt.message)
        # 三个事实缺任何一个都不提醒:改已有测试/新建普通源码/非编码步。
        for label, overrides in (
                ("existing-test", dict(new_file=False, is_test_path=True,
                                       compile_step=True)),
                ("new-source", dict(new_file=True, is_test_path=False,
                                    compile_step=True)),
                ("not-compile-step", dict(new_file=True, is_test_path=True,
                                          compile_step=False)),
        ):
            with self.subTest(case=label):
                self.assertEqual("allow", decide_edit(self.context(
                    path="src/x.py", match_path="src/x.py",
                    is_source=True, **overrides)).kind)

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
        self.assertIn("禁止经 Bash 改写", internal.message)

    def test_non_source_bash_writes_remain_available(self):
        """经 Bash 写需求/规格过程件不受源码阶段闸影响。

        旧字段 hits_requirement / hits_specs_truth / source_tokens 等已经退役；
        allow_source_edit 则是 flow.json 的当前步骤授权，必须由活跃 Gate 消费。
        """
        retired = {"hits_requirement", "hits_specs_truth", "source_tokens",
                   "allow_specs_write",
                   "strong_write", "weak_write"}
        self.assertEqual(
            set(), retired & set(BashWriteContext.__dataclass_fields__))
        # 仍可表达的那一例:只有源码 offenders、没有 tests_only 时不拦
        self.assertEqual("allow", decide_bash_write(self.context(
            offenders=("src/main.py",))).kind)

    def test_grill_cannot_write_source_through_bash(self):
        denied = decide_bash_write(self.context(
            command="sed -i s/red/blue/ src/main.py", writeish=True,
            step="grill", offenders=("src/main.py",),
            allow_source_edit=False, workflow_chosen=True))
        self.assertEqual(
            ("absolute", "bash-outside-source-step"),
            (denied.kind, denied.rule))
        self.assertEqual("allow", decide_bash_write(self.context(
            command="sed -n 1,80p src/main.py", step="grill",
            allow_source_edit=False)).kind)

    def test_pipeline_record_is_not_a_self_service_green_light(self):
        """流水线事实只收宿主递的:会话自己登记=自己给自己发绿灯。

        2026-08-20 复核实测:手写一份两字段 JSON 递给 pipeline record,
        内核就记 PASS、三项全 passed、连"宿主已推送"的收据也照收,
        义务核销当场放行——什么都没编译、没测、没扫、没推。宿主是
        直接子进程调用,不走这条门禁,所以挡住会话这条路不误伤交付。"""
        for command in (
            'python ".mae-flow-work/bin/mae-flow.py" pipeline record '
            '--file f.json',
            "python3 /plugin/scripts/mae-flow.py  pipeline  record --file x",
        ):
            with self.subTest(command=command):
                blocked = decide_bash_write(self.context(command=command))
                self.assertEqual(
                    ("absolute", "bash-pipeline-record-self-report"),
                    (blocked.kind, blocked.rule))
                # 绝对类不追加放行令,出路必须写在文案里。
                self.assertIn("结束当前回合", blocked.message)
        # 只读的 show 不受影响:看已登记的结论是正当需求。
        self.assertEqual("allow", decide_bash_write(self.context(
            command='python "mae-flow.py" pipeline show')).kind)

    def test_user_intervention_cannot_be_forged_by_main_agent(self):
        blocked = decide_bash_write(self.context(
            command='python ".mae-flow-work/bin/mae-flow.py" '
                    'intervention reconcile --file handoff.json'))
        self.assertEqual(
            ("absolute", "bash-user-intervention-self-report"),
            (blocked.kind, blocked.rule))
        self.assertIn("Cloud", blocked.message)

    def test_flow_head_blocks_bash_source_writes(self):
        """Bash 写源码与 Edit 同一条头部纪律(sed -i/重定向绕不过去)。"""
        head = decide_bash_write(self.context(
            command="sed -i s/a/b/ src/main.py", writeish=True,
            step="requirement_record",
            offenders=("src/main.py",), workflow_chosen=False))
        self.assertEqual(("block", "bash-before-workflow"),
                         (head.kind, head.rule))
        self.assertIn("src/main.py", head.message)
        # 没碰源码的命令(纯读/写文档)头部照常放行。
        self.assertEqual("allow", decide_bash_write(self.context(
            command="cat src/main.py", workflow_chosen=False)).kind)

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
