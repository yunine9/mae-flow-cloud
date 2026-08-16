#!/usr/bin/env python3
"""Unit tests for CodeCheck Evidence policies."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.evidence import (  # noqa: E402
    QualityEvidencePorts,
    QualityEvidenceRules,
)


def make_ports(**overrides):
    events = []
    values = {
        "business_changed_files": lambda _state: (["src/main.py"], ""),
        "risk_acceptance": lambda _kind, _state: (False, ""),
        "source_changed_since": lambda _head, _state: ([], ""),
        "agent_ran": lambda _spec, _state: (True, ""),
        "append_event": lambda _state, event, payload: events.append(
            (event, payload)),
        "git_head": lambda: "a" * 40,
        "exists": lambda _path: False,
        "is_file": lambda _path: False,
        "argv_output": lambda _arguments: "",
        "run_codecheck": lambda _files, _state, _source: (
            {"total": 0, "pairs": [], "log_path": ""}, ""),
        "scope_filter": lambda result, _state, _files: (result, []),
        "read_bytes": lambda _path: b"",
        "read_text_replace": lambda _path: "",
        "now": lambda: "2026-07-30 10:00:00",
        "exemption_text_has_pair": lambda _text, _rule, _path: False,
        "approved_exemptions": lambda _state: set(),
        "was_exempt_before_review": (
            lambda _state, _exemption, _rule, _path: False),
        "approval_key": lambda rule, path: (rule, path),
    }
    values.update(overrides)
    return QualityEvidencePorts(**values), events


class QualityEvidenceRuleTests(unittest.TestCase):
    def test_review_requires_scan_but_skips_empty_business_scope(self):
        ports, _events = make_ports()
        rules = QualityEvidenceRules(ports)
        state = {"current": "tw_codecheck", "quality": {}}
        self.assertIn(
            "尚未执行本步的机器首检",
            rules.review_codecheck({}, state).reason,
        )
        empty, _events = make_ports(
            business_changed_files=lambda _state: ([], ""))
        self.assertTrue(
            QualityEvidenceRules(empty).review_codecheck(
                {}, state).passed)

    def test_review_tool_error_is_valid_only_for_unchanged_source(self):
        state = {
            "current": "tw_codecheck",
            "quality": {"codecheck_scan": {
                "step": "tw_codecheck",
                "status": "TOOL_ERROR",
                "head": "a" * 40,
            }},
        }
        ports, _events = make_ports()
        self.assertTrue(
            QualityEvidenceRules(ports).review_codecheck(
                {}, state).passed)
        changed, _events = make_ports(
            source_changed_since=lambda _head, _state: (
                ["src/main.py"], ""))
        self.assertIn(
            "CodeCheck 工具诊断后源码发生变化",
            QualityEvidenceRules(changed).review_codecheck(
                {}, state).reason,
        )

    def test_clean_reuses_zero_scan_and_records_event(self):
        state = {
            "current": "tw_codecheck",
            "quality": {"codecheck_scan": {
                "step": "tw_codecheck",
                "count": 0,
                "files": ["src/main.py"],
                "head": "a" * 40,
            }},
        }
        ports, events = make_ports()
        self.assertTrue(
            QualityEvidenceRules(ports).codecheck_clean(
                {}, state).passed)
        self.assertEqual("verify.cache_reused", events[0][0])

    def test_clean_requires_exemption_for_real_remaining_warning(self):
        ports, _events = make_ports(
            run_codecheck=lambda _files, _state, _source: ({
                "total": 1,
                "pairs": [("RULE-1", "src/main.py", 7)],
                "log_path": "log.jsonl",
            }, ""),
        )
        state = {"current": "tw_codecheck", "quality": {},
                 "config": {"单号": "REQ-7"}}
        result = QualityEvidenceRules(ports).codecheck_clean(
            {}, state)
        self.assertFalse(result.passed)
        self.assertIn(
            "harness 现场复核实测遗留 1 条告警,且无豁免清单",
            result.reason,
        )


if __name__ == "__main__":
    unittest.main()
