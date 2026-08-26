#!/usr/bin/env python3
"""捕获即盖章(2026-08-26 单次确认修复):答案落账的瞬间,若当前步
该有审批卡而 state 尚未绑定、产物已就绪,钩子按此刻内容现算指纹给
这条消息盖章——模型"定稿即问"的自然次序由此一次通过,不再必现
背靠背双确认(run8b/run9 实测)。产物未就绪时保持无印章,done 仍按
老路径要求展示确认;钩子对状态文件一个字节不落盘。"""

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import save_versioned_json  # noqa: E402
from mae_flow_core.adapters.hook_runtime import HookRuntimeAdapter  # noqa: E402
from mae_flow_core.cli_commands.approval_subject import build_subject  # noqa: E402
from mae_flow_core.state_store import safe_read_json  # noqa: E402


@contextlib.contextmanager
def in_directory(path):
    original = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(original)


def runtime_for(root, logs=None):
    return HookRuntimeAdapter(
        state=os.path.join(root, ".mae-flow.json"),
        exit_state=os.path.join(root, ".mae-flow.json.exited"),
        action_state=os.path.join(root, ".mae-flow-work", "action.json"),
        rejection_state=os.path.join(root, ".mae-flow.json.agent-rejections"),
        evidence_state=os.path.join(root, ".mae-flow.json.agent-evidence"),
        agent_writes_state=os.path.join(root, ".mae-flow.json.agent-writes"),
        moonlight_intent=os.path.join(root, ".mae-flow.json.moonlight-intent"),
        exit_intent=os.path.join(root, ".mae-flow.json.exit-intent"),
        maeflow=os.path.join(ROOT, "scripts", "mae-flow.py"),
        log=logs.append if logs is not None else lambda _message: None,
    )


def message_rows(path):
    raw, err = safe_read_json(path)
    assert not err, err
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("data", "messages"):
            if isinstance(raw.get(key), list):
                return raw[key]
    raise AssertionError("无法识别的消息账本形态: %r" % type(raw))


class HookUsermsgApprovalBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        subprocess.run(["git", "init", "-q", self.root], check=True)
        subprocess.run(["git", "-C", self.root, "config", "user.email",
                        "test@example.com"], check=True)
        subprocess.run(["git", "-C", self.root, "config", "user.name",
                        "Test"], check=True)
        self.state = {"current": "open", "config": {"单号": "REQ-1"}}
        save_versioned_json(
            os.path.join(self.root, ".mae-flow.json"), self.state, "flow",
            project_root=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def _spec_step(self):
        # 与 flow/flow.json 的 open 步保持同形;这里只为独立算期望指纹。
        return {"approval_subject": {
            "kind": "artifacts", "artifacts": ["spec"]}}

    def test_answer_is_stamped_with_current_content_when_card_missing(self):
        folder = os.path.join(self.root, ".mae-flow-work", "REQ-1")
        os.makedirs(folder)
        with open(os.path.join(folder, "spec.md"), "w",
                  encoding="utf-8") as out:
            out.write("v1\n")
        runtime = runtime_for(self.root)
        with in_directory(self.root):
            runtime._capture_usermsg("Spec 无需再调整，确认生成 Story")
            expected = build_subject(
                self.root, dict(self.state), "open", self._spec_step())
        rows = message_rows(os.path.join(self.root, ".mae-flow.json.usermsg"))
        self.assertTrue(rows, "答案必须落账")
        row = rows[-1]
        self.assertEqual(expected["sha256"], row.get("approval_subject_sha256"),
                         "印章必须等于捕获瞬间的内容指纹,ack 过滤才认它")
        self.assertEqual(expected["id"], row.get("approval_subject_id"))
        state_raw, err = safe_read_json(
            os.path.join(self.root, ".mae-flow.json"))
        self.assertFalse(err)
        text = json.dumps(state_raw, ensure_ascii=False)
        self.assertNotIn("approval_subject", text,
                         "钩子只在内存绑卡,状态文件的写入权只归 CLI")

    def test_missing_artifacts_leave_answer_unstamped(self):
        logs = []
        runtime = runtime_for(self.root, logs)
        with in_directory(self.root):
            runtime._capture_usermsg("Spec 无需再调整，确认生成 Story")
        rows = message_rows(os.path.join(self.root, ".mae-flow.json.usermsg"))
        self.assertTrue(rows)
        self.assertNotIn("approval_subject_sha256", rows[-1],
                         "产物未就绪不许伪造印章;done 会按老路径要求展示确认")


if __name__ == "__main__":
    unittest.main()
