#!/usr/bin/env python3
"""Quality tasks receive exact local artifacts, candidates, and executions."""

import os
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.application.quality.task_cards import (  # noqa: E402
    requirement_sources,
    task_file_groups,
)
from mae_flow_core.application.quality.task_card_documents import (  # noqa: E402
    build_full_task_document,
)
from mae_flow_core.orchestration.work_package import ensure_work_package  # noqa: E402
from mae_flow_core.workflow.quality_executions import (  # noqa: E402
    quality_input_snapshot,
    record_quality_execution,
    successful_quality_execution,
)
from mae_flow_core.cli_commands.agent_task import (  # noqa: E402
    _compile_worktree_snapshot,
    _resolve_requirement_sources_from_runtime,
)
from mae_flow_core.cli_commands import agent_task  # noqa: E402


class QualityTaskInputTests(unittest.TestCase):
    def test_compile_task_snapshot_returns_a_tuple_for_real_compile_tasks(self):
        snapshot = {"src/a.cpp": "digest"}
        with mock.patch.object(agent_task, "api", types.SimpleNamespace(
                _worktree_snapshot_since=lambda _head: snapshot)):
            self.assertEqual(
                (snapshot, True),
                _compile_worktree_snapshot("COMPILE", "a" * 40))

    def test_local_spec_grill_story_precede_legacy_sources(self):
        with tempfile.TemporaryDirectory() as root:
            package = ensure_work_package(root, "REQ-123")
            for path in (
                    package.spec, package.grill, package.story,
                    package.implementation):
                with open(path, "w", encoding="utf-8") as stream:
                    stream.write("confirmed\n")
            sources = requirement_sources(
                {"需求文档": "docs/request.md"},
                exists=lambda path: os.path.exists(path)
                or path == "docs/request.md",
                absolute=lambda path: (
                    path if os.path.isabs(path) else os.path.join(root, path)),
                glob_paths=lambda _pattern: (),
                local_sources=(
                    package.spec, package.grill, package.story,
                    package.implementation),
            )
            self.assertEqual(
                (package.spec, package.grill, package.story,
                 package.implementation), sources[:4])

    def test_rendered_card_names_every_artifact_and_candidate(self):
        sources = (
            "/repo/.mae-flow-work/REQ-123/spec.md",
            "/repo/.mae-flow-work/REQ-123/grill.md",
            "/repo/.mae-flow-work/REQ-123/story.md",
        )
        document = build_full_task_document({
            "kind": "COMPILE", "sid": "build", "project_root": "/repo",
            "head": "deadbeef", "config": {
                "单号": "REQ-123", "单号类型": "feature",
                "基线分支": "main", "编译方式": "mcde build -i",
                "UT生成方式": "AutoUT", "UT运行命令": "mcde test",
            },
            "diff": "main..HEAD", "scope": "完整实现",
            "precommit_review": False, "inherited_dirty": (),
            "sources": sources,
            "groups": task_file_groups(
                ("src/radio/prach.cpp",), lambda _path: False,
                lambda _path: False),
            "change_count": 1, "task_file_count": 1,
            "execution_plan": type("Plan", (), {
                "roots": (("src/radio", "检测到 CMakeLists.txt"),),
                "unresolved": (),
            })(),
            "lightcheck": None, "notes": (), "scan": {},
            "ut_targets": {},
        }).body()
        for value in sources + ("src/radio/prach.cpp", "src/radio"):
            self.assertIn(value, document)
        self.assertNotIn("结合 Spec 和 Story", document)

    def test_quality_tasks_load_only_relevant_indexed_domain_truth(self):
        with tempfile.TemporaryDirectory() as root:
            package = ensure_work_package(root, "REQ-123")
            for path, content in (
                    (package.spec, "NRPRACH 支持 SUL"),
                    (package.grill, "SUL 决策"),
                    (package.story, "无线接入设计"),
                    (package.implementation, "无线接入实现")):
                with open(path, "w", encoding="utf-8") as stream:
                    stream.write(content)
            specs = os.path.join(root, "docs", "specs")
            os.makedirs(specs)
            with open(os.path.join(specs, "index.md"), "w", encoding="utf-8") as stream:
                stream.write("""
| 领域 | 关键词 | 文档 |
| --- | --- | --- |
| radio | SUL, NRPRACH | docs/specs/radio.md |
| billing | invoice | docs/specs/billing.md |
""")
            for name in ("radio", "billing"):
                with open(os.path.join(specs, name + ".md"), "w", encoding="utf-8") as stream:
                    stream.write(name + " truth")
            before = os.getcwd()
            try:
                os.chdir(root)
                sources = _resolve_requirement_sources_from_runtime({
                    "config": {"单号": "REQ-123"},
                })
            finally:
                os.chdir(before)
            canonical = tuple(os.path.realpath(path) for path in sources)
            self.assertIn(os.path.realpath(os.path.join(specs, "index.md")), canonical)
            self.assertIn(os.path.realpath(os.path.join(specs, "radio.md")), canonical)
            self.assertNotIn(
                os.path.realpath(os.path.join(specs, "billing.md")), canonical)

    def test_agent_instructions_forbid_polling_and_background_builds(self):
        with open(os.path.join(ROOT, "agents", "compile-agent.md"),
                  encoding="utf-8") as stream:
            text = stream.read()
        for required in ("一次同步编译", "PID 查询", "日志轮询", "`sleep`"):
            self.assertIn(required, text)

    def test_success_is_reused_only_for_unchanged_normalized_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            state_path = os.path.join(root, ".mae-flow.json")
            state = {
                "config": {"编译方式": "make module"},
                "agent_tasks": {"COMPILE": {
                    "head": "abc", "task_files": ["src/a.cpp"],
                    "execution_roots": ["src"],
                }},
            }
            snapshot = quality_input_snapshot(state, "COMPILE", "build")
            record_quality_execution(
                state_path, "COMPILE", "build", "run-1", "make module",
                True, snapshot, "2026-08-04 10:00:00")
            self.assertIsNotNone(successful_quality_execution(
                state_path, "COMPILE", "build", snapshot))
            changed = dict(snapshot)
            changed["head"] = "def"
            self.assertIsNone(successful_quality_execution(
                state_path, "COMPILE", "build", changed))

    def test_evidence_free_second_event_cannot_erase_a_proven_success(self):
        """SubagentStop 与 PostToolUse 报同一次调用时，弱证据不得覆盖强证据。"""
        with tempfile.TemporaryDirectory() as root:
            state_path = os.path.join(root, ".mae-flow.json")
            snapshot = {"kind": "COMPILE", "step": "build"}
            record_quality_execution(
                state_path, "COMPILE", "build", "toolu-1", "make all",
                True, snapshot, "2026-08-07 10:00:00")
            # 第二个事件解析不到子 Agent transcript：command 为空、succeeded 为假。
            record_quality_execution(
                state_path, "COMPILE", "build", "toolu-1", "",
                False, snapshot, "2026-08-07 10:00:01")
            proven = successful_quality_execution(
                state_path, "COMPILE", "build", snapshot)
            self.assertIsNotNone(proven)
            self.assertEqual("make all", proven["command"])

    def test_observed_failure_still_replaces_an_earlier_success(self):
        with tempfile.TemporaryDirectory() as root:
            state_path = os.path.join(root, ".mae-flow.json")
            snapshot = {"kind": "COMPILE", "step": "build"}
            record_quality_execution(
                state_path, "COMPILE", "build", "toolu-1", "make all",
                True, snapshot, "2026-08-07 10:00:00")
            record_quality_execution(
                state_path, "COMPILE", "build", "toolu-1", "make all",
                False, snapshot, "2026-08-07 10:00:01")
            self.assertIsNone(successful_quality_execution(
                state_path, "COMPILE", "build", snapshot))

    def test_timeout_is_recorded_as_failure(self):
        with tempfile.TemporaryDirectory() as root:
            state_path = os.path.join(root, ".mae-flow.json")
            snapshot = {"kind": "UT", "step": "verify_ut"}
            record_quality_execution(
                state_path, "UT", "verify_ut", "run-timeout", "test",
                False, snapshot, "2026-08-04 10:00:00", lifecycle="timeout")
            self.assertIsNone(successful_quality_execution(
                state_path, "UT", "verify_ut", snapshot))


if __name__ == "__main__":
    unittest.main()
