#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端宿主放开子 Agent 台账门禁——放开的范围与不放开的边界,两头都要钉死。

背景(实战 verify_ut,2026-08-15):pi 宿主取不到内核格式的子会话执行台账,
agent 真跑了、UT 真绿了(surefire 报告在工作区躺着),证据口就是看不见;
同一批签发 3 次不前进,doctor 明令走 accept-risk。令牌仪式在云端退化成
纯摩擦。用户拍板:云端不搞令牌,机器把关移到交付点(流水线结果绑 SHA)。

要钉的边界同样重要:
- ASKUSER 是人工闸,云端决定卡走得通,绝不随台账一起放开;
- 本地宿主(不设 MAE_FLOW_HOST)行为必须一字不变。
"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import host_env


class _CloudEnv(object):
    """用例级别切宿主形态;用完必还原,别把云端状态漏给别的测试。"""

    def __init__(self, value):
        self.value = value

    def __enter__(self):
        self.saved = os.environ.get(host_env.ENV)
        if self.value is None:
            os.environ.pop(host_env.ENV, None)
        else:
            os.environ[host_env.ENV] = self.value

    def __exit__(self, *_exc):
        if self.saved is None:
            os.environ.pop(host_env.ENV, None)
        else:
            os.environ[host_env.ENV] = self.saved


class _AgentPorts(object):
    """一个"什么台账都取不到"的宿主:观察记录、质量执行、风险确认全空。

    本地模式下它必然被拦——这正是要对照的基线。
    """

    moonlight = staticmethod(lambda state: False)
    step_entered = staticmethod(lambda state: "2026-08-15 00:00:00")
    risk_acceptance = staticmethod(lambda kind, state: (False, ""))
    script_path = staticmethod(lambda: "mae-flow.py")
    risk_labels = {}
    finished_observation = staticmethod(lambda *a, **k: None)
    quality_execution = staticmethod(lambda *a, **k: None)
    askuser_tokens = staticmethod(lambda: {})
    changed_source_files = staticmethod(
        lambda state: (["service/src/A.java"], ""))
    shell_output = staticmethod(lambda *a, **k: "")
    argv_output = staticmethod(lambda *a, **k: "")
    blocking_dirty_source_paths = staticmethod(lambda *a, **k: [])
    open_observation = None
    finished_observations = None
    step_scoped_source_files = None


def _agent_rules():
    from mae_flow_core.workflow.agent_evidence import AgentEvidenceRules
    return AgentEvidenceRules(_AgentPorts())


class _QualityPorts(object):
    def business_changed_files(self, _state):
        return ["service/src/A.java"], ""

    def risk_acceptance(self, _kind, _state):
        return False, ""

    def agent_ran(self, spec, state):
        return _agent_rules().agent_ran(spec, state)


def _quality_rules():
    from mae_flow_core.quality.evidence import QualityEvidenceRules
    return QualityEvidenceRules(_QualityPorts())


_STATE = {"current": "verify_ut",
          "ut_session": {"step": "verify_ut", "phase": "generate"}}


class CloudReleasesWorkerLedger(unittest.TestCase):
    def test_worker_kinds_pass_without_any_ledger(self):
        """UT/COMPILE/REVIEWER/STORY/GRILL:云端一律不再向台账要证据。"""
        with _CloudEnv(host_env.CLOUD):
            for kind in ("UT", "COMPILE", "REVIEWER", "STORY",
                         "GRILL_PREP", "GRILL_FINAL", "CODECHECK"):
                result = _agent_rules().agent_ran({"agent": kind}, _STATE)
                self.assertTrue(result.passed, "%s: %s" % (kind, result.reason))
                self.assertIn("流水线", result.reason,
                              "放行理由必须说明把关去了哪,不能无声")

    def test_askuser_still_gates_in_cloud(self):
        """人工闸不随台账放开:云端决定卡走得通,放开它等于把人踢出局。"""
        with _CloudEnv(host_env.CLOUD):
            result = _agent_rules().agent_ran({"agent": "ASKUSER"}, _STATE)
            self.assertFalse(result.passed)
            self.assertIn("AskUserQuestion", result.reason)

    def test_ut_batches_released_in_cloud(self):
        """批次记账是同一份取不到的证据的衍生,必须一起放,否则死循环重演。"""
        with _CloudEnv(host_env.CLOUD):
            result = _quality_rules().ut_session_complete({}, _STATE)
            self.assertTrue(result.passed, result.reason)

    def test_agent_or_no_source_released_in_cloud(self):
        """有源码改动时 agent_or_no_source 落到 agent_ran,同样放行。"""
        with _CloudEnv(host_env.CLOUD):
            result = _agent_rules().agent_or_no_source(
                {"agent": "COMPILE"}, _STATE)
            self.assertTrue(result.passed, result.reason)


class CloudDelegatesCodecheckToPipeline(unittest.TestCase):
    def test_review_codecheck_passes_in_cloud_without_scan(self):
        """云端不做本地 CodeCheck:工具是内网 npm 件,装不上时只剩安装
        空撞和 TOOL_ERROR 噪声(task-1 实锤);交由流水线,lightcheck 照常。"""
        from mae_flow_core.quality.evidence import QualityEvidenceRules

        class _Ports(object):
            def business_changed_files(self, _state):
                return ["service/src/A.java"], ""

        with _CloudEnv(host_env.CLOUD):
            result = QualityEvidenceRules(_Ports()).review_codecheck(
                {}, {"current": "verify_codecheck"})
            self.assertTrue(result.passed, result.reason)
            self.assertIn("流水线", result.reason)

    def test_review_codecheck_still_gates_locally(self):
        from mae_flow_core.quality.evidence import QualityEvidenceRules

        class _Ports(object):
            def business_changed_files(self, _state):
                return ["service/src/A.java"], ""

            def risk_acceptance(self, _kind, _state):
                return False, ""

        with _CloudEnv(None):
            result = QualityEvidenceRules(_Ports()).review_codecheck(
                {}, {"current": "verify_codecheck"})
            self.assertFalse(result.passed)
            self.assertIn("机器首检", result.reason)


class TestsNeverPopDesktop(unittest.TestCase):
    def test_desktop_popup_refuses_to_fire_under_test_runner(self):
        """测试进程绝不弹真通知——跑全量把用户桌面弹一串,就是测试泄漏。

        闸在 _popup(真副作用),不在 desktop_enabled(判定逻辑):
        "全新仓默认弹"的契约另有用例在钉,两者不打架。
        """
        from mae_flow_core.panel import notify
        self.assertFalse(notify._popup("标题", "正文"))


class LocalHostUnchanged(unittest.TestCase):
    def test_worker_kinds_still_gate_locally(self):
        """不设 MAE_FLOW_HOST:一字不变,取不到台账照样拦。"""
        with _CloudEnv(None):
            result = _agent_rules().agent_ran({"agent": "UT"}, _STATE)
            self.assertFalse(result.passed)

    def test_ut_batches_still_gate_locally(self):
        with _CloudEnv(None):
            result = _quality_rules().ut_session_complete({}, _STATE)
            self.assertFalse(result.passed)
            self.assertIn("尚未全部完成", result.reason)


if __name__ == "__main__":
    unittest.main()
