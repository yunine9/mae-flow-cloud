import os
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_commands.approval_subject import (  # noqa: E402
    build_subject, subject_matches)


class ApprovalSubjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        subprocess.run(["git", "init", "-q", self.root], check=True)
        subprocess.run(["git", "-C", self.root, "config", "user.email",
                        "test@example.com"], check=True)
        subprocess.run(["git", "-C", self.root, "config", "user.name",
                        "Test"], check=True)
        with open(os.path.join(self.root, "a.txt"), "w", encoding="utf-8") as out:
            out.write("base\n")
        subprocess.run(["git", "-C", self.root, "add", "a.txt"], check=True)
        subprocess.run(["git", "-C", self.root, "commit", "-qm", "base"],
                       check=True)
        self.head = subprocess.check_output(
            ["git", "-C", self.root, "rev-parse", "HEAD"], text=True).strip()

    def tearDown(self):
        self.temp.cleanup()

    def test_worktree_subject_binds_tracked_and_untracked_content(self):
        state = {"implementation_base_head": self.head}
        step = {"approval_subject": {"kind": "worktree"}}
        first = build_subject(self.root, state, "build_review", step)
        with open(os.path.join(self.root, "a.txt"), "w", encoding="utf-8") as out:
            out.write("changed\n")
        second = build_subject(self.root, state, "build_review", step)
        self.assertNotEqual(first["sha256"], second["sha256"])
        with open(os.path.join(self.root, "new.txt"), "w", encoding="utf-8") as out:
            out.write("new\n")
        third = build_subject(self.root, state, "build_review", step)
        self.assertNotEqual(second["sha256"], third["sha256"])

    def test_artifact_subject_invalidates_when_document_changes(self):
        folder = os.path.join(self.root, ".mae-flow-work", "REQ-1")
        os.makedirs(folder)
        path = os.path.join(folder, "spec.md")
        with open(path, "w", encoding="utf-8") as out:
            out.write("v1\n")
        state = {"config": {"单号": "REQ-1"}}
        step = {"approval_subject": {
            "kind": "artifacts", "artifacts": ["spec"]}}
        state["approval_subject"] = build_subject(
            self.root, state, "open", step)
        first_id = state["approval_subject"]["id"]
        self.assertEqual((True, ""), subject_matches(
            self.root, state, "open", step))
        with open(path, "w", encoding="utf-8") as out:
            out.write("v2\n")
        ok, reason = subject_matches(self.root, state, "open", step)
        self.assertFalse(ok)
        self.assertIn("旧决定已自动失效", reason)
        self.assertEqual(first_id, state["approval_subject"]["supersedes"])

    def test_artifact_mtime_noise_does_not_invalidate_review(self):
        folder = os.path.join(self.root, ".mae-flow-work", "REQ-1")
        os.makedirs(folder)
        path = os.path.join(folder, "spec.md")
        with open(path, "w", encoding="utf-8") as out:
            out.write("stable content\n")
        state = {"config": {"单号": "REQ-1"}}
        step = {"approval_subject": {
            "kind": "artifacts", "artifacts": ["spec"]}}
        first = build_subject(self.root, state, "open", step)
        stat = os.stat(path)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
        second = build_subject(self.root, state, "open", step)
        self.assertEqual(first["sha256"], second["sha256"])

    def test_flow_runtime_noise_does_not_invalidate_worktree_review(self):
        state = {"implementation_base_head": self.head}
        step = {"approval_subject": {"kind": "worktree"}}
        first = build_subject(self.root, state, "build_review", step)
        os.makedirs(os.path.join(self.root, ".mae-flow-work", "REQ-1"))
        for relative, content in (
                (".mae-flow.json", '{"updated_at":"first"}\n'),
                (".mae-flow.json.usermsg", '{"at":"first"}\n'),
                (".mae-flow-order.json", "{}\n"),
                (".mae-flow-work/REQ-1/panel.html", "runtime\n")):
            with open(os.path.join(self.root, relative), "w",
                      encoding="utf-8") as out:
                out.write(content)
        second = build_subject(self.root, state, "build_review", step)
        self.assertEqual(first["sha256"], second["sha256"])
        with open(os.path.join(self.root, ".mae-flow.json"), "w",
                  encoding="utf-8") as out:
            out.write('{"updated_at":"second"}\n')
        third = build_subject(self.root, state, "build_review", step)
        self.assertEqual(first["sha256"], third["sha256"])

    def test_first_bind_passes_without_forcing_a_second_confirmation(self):
        """2026-08-26 单次确认修复:缺卡时补绑当前内容后放行,不再打回
        重问——共识由 ack 验真按"印章 sha == 此刻内容 sha"裁决;
        run8b/run9 双跑里 spec/story 必现的背靠背双确认由此消除。"""
        folder = os.path.join(self.root, ".mae-flow-work", "REQ-1")
        os.makedirs(folder)
        with open(os.path.join(folder, "spec.md"), "w",
                  encoding="utf-8") as out:
            out.write("v1\n")
        state = {"config": {"单号": "REQ-1"}}
        step = {"approval_subject": {
            "kind": "artifacts", "artifacts": ["spec"]}}
        ok, reason = subject_matches(self.root, state, "open", step)
        self.assertEqual((True, ""), (ok, reason))
        bound = state.get("approval_subject") or {}
        self.assertEqual("open", bound.get("step"))
        self.assertEqual(
            build_subject(self.root, state, "open", step)["sha256"],
            bound.get("sha256"),
            "补绑的卡必须与此刻内容同指纹,ack 印章过滤才有对账对象")
        # 放行只发生一次绑定;内容随后变化仍走"作废重展示"老路径。
        with open(os.path.join(folder, "spec.md"), "w",
                  encoding="utf-8") as out:
            out.write("v2\n")
        ok, reason = subject_matches(self.root, state, "open", step)
        self.assertFalse(ok)
        self.assertIn("旧决定已自动失效", reason)

    def test_manifest_scope_ignores_noise_outside_delivery_set(self):
        """2026-08-29 用户拍板:有交付清单时人批的是清单那组文件,
        清单外的残留产物、新 commit(head 演进)都不作废批复——
        "确认绑文件集合"与"产物留工作区别删"两条口径在此对齐。"""
        state = {"implementation_base_head": self.head,
                 "delivery_manifest": {"files": ["a.txt"],
                                       "confirmed": True}}
        step = {"approval_subject": {"kind": "worktree"}}
        first = build_subject(self.root, state, "delivery_review", step)
        self.assertEqual("delivery_manifest", first.get("scope"))
        # 清单外的残留构建产物出现/变化:批复保持有效。
        with open(os.path.join(self.root, "build.o"), "w",
                  encoding="utf-8") as out:
            out.write("artifact v1\n")
        second = build_subject(self.root, state, "delivery_review", step)
        self.assertEqual(first["sha256"], second["sha256"])
        # 清单外文件提交产生新 HEAD:不绑每个中间 SHA,批复保持有效。
        with open(os.path.join(self.root, "other.txt"), "w",
                  encoding="utf-8") as out:
            out.write("unrelated\n")
        subprocess.run(["git", "-C", self.root, "add", "other.txt"],
                       check=True)
        subprocess.run(["git", "-C", self.root, "commit", "-qm", "noise"],
                       check=True)
        third = build_subject(self.root, state, "delivery_review", step)
        self.assertEqual(first["sha256"], third["sha256"])
        # 清单内文件内容变化:旧决定不背书新代码,必须作废。
        with open(os.path.join(self.root, "a.txt"), "w",
                  encoding="utf-8") as out:
            out.write("changed\n")
        fourth = build_subject(self.root, state, "delivery_review", step)
        self.assertNotEqual(first["sha256"], fourth["sha256"])

    def test_manifest_scope_binds_the_file_set_itself(self):
        state = {"implementation_base_head": self.head,
                 "delivery_manifest": {"files": ["a.txt"],
                                       "confirmed": True}}
        step = {"approval_subject": {"kind": "worktree"}}
        first = build_subject(self.root, state, "delivery_review", step)
        # 清单增删文件=换了审批对象,必须是新卡。
        state["delivery_manifest"]["files"] = ["a.txt", "b.txt"]
        second = build_subject(self.root, state, "delivery_review", step)
        self.assertNotEqual(first["sha256"], second["sha256"])

    def test_stale_subject_is_rotated_without_agent_rework(self):
        state = {"implementation_base_head": self.head}
        step = {"approval_subject": {"kind": "worktree"}}
        state["approval_subject"] = build_subject(
            self.root, state, "build_review", step)
        old_id = state["approval_subject"]["id"]
        with open(os.path.join(self.root, "a.txt"), "w",
                  encoding="utf-8") as out:
            out.write("changed\n")
        ok, reason = subject_matches(
            self.root, state, "build_review", step)
        self.assertFalse(ok)
        self.assertIn("新审批卡已自动生成", reason)
        self.assertNotEqual(old_id, state["approval_subject"]["id"])
        self.assertEqual(old_id, state["approval_subject"]["supersedes"])


if __name__ == "__main__":
    unittest.main()
