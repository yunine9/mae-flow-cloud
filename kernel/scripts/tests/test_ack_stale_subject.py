#!/usr/bin/env python3
"""印章过期的答案要报"内容变了",不许误诊成"没回答过"。

2026-08-26 定位 story 二次确认问题时补:用户确认之后审批产物又被
修改时,印章过滤会清空账本,旧报错说"尚未捕获到选择"——把"内容变了
该重看"和"根本没问过"混为一谈,模型和人都无从排障。"""

import contextlib
import json
import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_commands.ack import _implicit_ack_verified  # noqa: E402
from mae_flow_core.cli_commands import state_config  # noqa: E402
from mae_flow_core.cli_commands.wiring import api  # noqa: E402

# ack 经 api 迟绑定取 _step_entered_at 等;单测不走 CLI 引导,补注册。
api.register(state_config)


@contextlib.contextmanager
def in_directory(path):
    original = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(original)


CONFIRM = "Story 与实施附录无需再调整，确认进入编码"


def ledger_row(sha, when="2026-08-26 10:00:00"):
    return {
        "id": "m1", "at": when, "step": "story",
        "text": json.dumps({"answers": {"Story 是否确认": CONFIRM}},
                           ensure_ascii=False),
        "approval_subject_sha256": sha,
        "approval_subject_id": sha[:16],
    }


class StaleSubjectAckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.step = {"user_ack": True, "confirmation_answers": [CONFIRM]}
        self.state = {
            "current": "story",
            "config": {"单号": "REQ-1"},
            "approval_subject": {
                "step": "story", "sha256": "n" * 64, "id": "n" * 16,
                "paths": [".mae-flow-work/REQ-1/story.md",
                          ".mae-flow-work/REQ-1/implementation.md"],
            },
        }

    def tearDown(self):
        self.temp.cleanup()

    def _write_ledger(self, rows):
        with open(os.path.join(self.temp.name, ".mae-flow.json.usermsg"),
                  "w", encoding="utf-8") as out:
            json.dump(rows, out, ensure_ascii=False)

    def test_stale_stamp_reports_content_change_not_missing_answer(self):
        self._write_ledger([ledger_row("o" * 64)])
        with in_directory(self.temp.name):
            ok, why = _implicit_ack_verified(self.step, self.state)
        self.assertFalse(ok)
        self.assertIn("确认之后审批内容", why)
        self.assertIn("story.md", why)
        self.assertNotIn("尚未捕获到本步骤", why,
                         "内容变了不是没回答,不许误诊")

    def test_matching_stamp_still_passes(self):
        self._write_ledger([ledger_row("n" * 64)])
        with in_directory(self.temp.name):
            ok, why = _implicit_ack_verified(self.step, self.state)
        self.assertEqual((True, ""), (ok, why))


if __name__ == "__main__":
    unittest.main()
