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
        for step in ("grill", "story", "open", "external_verify"):
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

    def test_build_step_tests_are_free(self):
        """2026-08-25 编排瘦身:UT 随实现自由编写,新建/修改测试都干净放行,
        不再有 tests_only 拦截或抢跑提醒。"""
        for path in ("tests/test_new.py", "tests/test_old.py", "src/x.py"):
            with self.subTest(path=path):
                self.assertEqual(("allow", "", ""), tuple(decide_edit(
                    self.context(path=path, match_path=path,
                                 is_source=True))))

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
            "source_unlocked": False,
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
                   "allow_specs_write", "strong_write", "weak_write",
                   "tests_only_patterns", "bad_test_sources"}
        self.assertEqual(
            set(), retired & set(BashWriteContext.__dataclass_fields__))
        # 源码 offenders 在授权写码的步骤不拦
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


if __name__ == "__main__":
    unittest.main()
