import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAE = os.path.join(ROOT, "scripts", "mae-flow.py")
DISPATCH = os.path.join(ROOT, "hooks", "dispatch.py")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from mae_flow_core import cli_runtime as mf
from mae_flow_core.cli_commands import git_ownership
from mae_flow_core.guard.ownership import OwnershipFacts, decide_ownership
with open(
        os.path.join(ROOT, "flow", "flow.json"),
        encoding="utf-8") as flow_stream:
    mf.FLOW = json.load(flow_stream)


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, text=True,
        capture_output=True).stdout.strip()


def write(root, relative, text):
    path = os.path.join(root, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
    return path


class CommitOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mae-flow-ownership-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "ownership@test.invalid")
        git(self.repo, "config", "user.name", "Ownership Test")
        write(self.repo, "README.md", "base\n")
        git(self.repo, "add", "README.md")
        git(self.repo, "commit", "-qm", "base")
        git(self.repo, "branch", "-M", "main")
        git(self.repo, "checkout", "-qb", "feature")
        self.old_cwd = os.getcwd()
        os.chdir(self.repo)

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def state(self, current="build"):
        return {
            "current": current,
            "config": {
                "单号": "REQ123", "单号类型": "fix",
                "CHANGE_NAME": "current-change",
                "基线分支": "main", "分支名": "feature",
            },
            "choices": {"workflow": "full"},
            "history": [], "started": "2026-07-28 10:00:00",
            "initial_dirty": [], "initial_dirty_fingerprints": {},
        }

    def red_repair_state(self, baseline_dirty=()):
        state = self.state(current="external_verify")
        head = git(self.repo, "rev-parse", "HEAD")
        state["quality"] = {"external_verification": {
            "verdict": "RED", "sha": head,
        }}
        state["external_repair_authorization"] = {
            "schema": "mae-flow-external-repair/1",
            "status": "ready",
            "failed_sha": head,
            "issued_at": "2026-08-20 12:00:00",
            "baseline_dirty": list(baseline_dirty),
        }
        # Deliberately stale human manifest: the RED repair may need a new test
        # file, but must not manufacture another human Diff review round.
        state["delivery_manifest"] = {
            "files": ["README.md"],
            "commit_message": "[REQ123][fix]original delivery",
            "target_branch": "main",
            "adopted_dirty": {},
            "confirmed": True,
        }
        return state

    def test_external_red_allows_exact_repair_commits_until_reverdict(self):
        repair = "src/pipeline_fix.py"
        write(self.repo, repair, "fixed = True\n")
        mf.save_state(self.red_repair_state())
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]pipeline repair"' % repair
        )

        allowed = self.gate_bash(command)

        self.assertEqual(0, allowed.returncode, allowed.stdout + allowed.stderr)
        git(self.repo, "add", "--", repair)
        git(self.repo, "commit", "-qm", "[REQ123][fix]pipeline repair")
        # 2026-08-28 勘误:第一笔提交后窗口不再自毁("一个 RED 只配一次
        # 提交"曾把漏提交文件的 Agent 摔进按旧清单判定的交付清单闸)。
        # 补提交照走修复闸;窗口由宿主登记新判决时关闭(见下)。
        later = "src/later.py"
        write(self.repo, later, "later = True\n")
        second = self.gate_bash(
            'git add -- "%s" && git commit -m "[REQ123][fix]later"' % later)
        self.assertEqual(0, second.returncode, second.stdout + second.stderr)
        # 宿主对新 SHA 登记非 RED 判决 → 授权清除,回落人工清单闸。
        closed = self.red_repair_state()
        closed.pop("external_repair_authorization")
        mf.save_state(closed)
        blocked = self.gate_bash(
            'git add -- "%s" && git commit -m "[REQ123][fix]later"' % later)
        self.assertNotEqual(0, blocked.returncode)
        self.assertIn("用户确认清单", blocked.stdout + blocked.stderr)

    def test_external_red_never_adopts_startup_or_pre_red_dirt(self):
        startup = "docs/user-before.txt"
        before_red = "src/pre_red.py"
        repair = "src/pipeline_fix.py"
        write(self.repo, startup, "mine\n")
        write(self.repo, before_red, "ambiguous\n")
        state = self.red_repair_state((before_red,))
        self.mark_initial(state, startup)
        write(self.repo, repair, "fixed = True\n")
        mf.save_state(state)
        command = (
            'git add -- "%s" "%s" "%s" && '
            'git commit -m "[REQ123][fix]pipeline repair"'
            % (repair, startup, before_red)
        )

        blocked = self.gate_bash(command)

        output = blocked.stdout + blocked.stderr
        self.assertNotEqual(0, blocked.returncode, output)
        self.assertIn(startup, output)
        self.assertIn(before_red, output)

    def test_external_red_still_rejects_broad_staging(self):
        write(self.repo, "src/pipeline_fix.py", "fixed = True\n")
        mf.save_state(self.red_repair_state())

        blocked = self.gate_bash(
            'git add -A && git commit -m "[REQ123][fix]pipeline repair"')

        self.assertNotEqual(0, blocked.returncode)
        self.assertIn("精确暂存", blocked.stdout + blocked.stderr)

    def mark_initial(self, state, path):
        state["initial_dirty"].append(path)
        state["initial_dirty_fingerprints"][path] = mf._path_fingerprint(path)

    def write_sidecar(self, compile_side_effects=None, paths=None):
        sidecar = {"paths": paths or {}}
        if compile_side_effects is not None:
            sidecar["compile_side_effects"] = compile_side_effects
        write(self.repo, ".mae-flow.json.agent-writes", json.dumps(sidecar))

    def gate_bash(self, command):
        return subprocess.run(
            [sys.executable, MAE, "gate", "bash", command],
            cwd=self.repo,
            text=True,
            capture_output=True,
            timeout=120,
        )

    def posttool_bash(self, command):
        payload = json.dumps({
            "cwd": self.repo,
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": {"exit_code": 0, "stdout": ""},
        }, ensure_ascii=False) + "\n"
        result = subprocess.run(
            [sys.executable, DISPATCH, "posttooluse"],
            cwd=self.repo,
            input=payload,
            text=True,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return result

    def save_pending_compile(self, state=None):
        state = state or self.state()
        state["agent_tasks"] = {"COMPILE": {
            "step": state["current"],
            "head": git(self.repo, "rev-parse", "HEAD"),
            "sha256": "current-compile-task",
        }}
        mf.save_state(state)
        return state

    def push_to_new_remote(self):
        remote = os.path.join(self.tmp, "remote.git")
        git(self.tmp, "init", "--bare", "-q", remote)
        git(self.repo, "remote", "add", "origin", remote)
        git(self.repo, "push", "-qu", "origin", "HEAD")

    def capture_user_message(self, state, text):
        write(self.repo, ".mae-flow.json.usermsg", json.dumps([{
            "id": "user-git-authorization",
            "step": state["current"],
            "at": "9999-12-31 23:59:59",
            "text": text,
        }], ensure_ascii=False))

    def authorize_blocked_command(self, command, rule, ack):
        blocked = self.gate_bash(command)
        output = blocked.stdout + blocked.stderr
        self.assertNotEqual(0, blocked.returncode, output)
        permit_id = mf._gate_block_id(rule, command)
        state = mf.load_state()
        # 按新契约:问用户的那句话里必须带上本次放行编号。编号是流程在拦截那一刻
        # 生成的,Agent 只能从拦截消息里抄——抄了就意味着它真把这次动作摆给用户
        # 看过,别处的同意也就挪不过来。
        self.capture_user_message(state, "%s（放行编号 %s）" % (ack, permit_id))
        with contextlib.redirect_stdout(io.StringIO()):
            mf.cmd_allow(
                mf.FLOW,
                state,
                types.SimpleNamespace(
                    block_id=permit_id,
                    message_id="user-git-authorization",
                ),
            )
        return output, permit_id

    def mark_compile_completed(self, state, invocation="toolu-compile"):
        """按生产形态坐实"编译已完成":真实返回 + 当前输入上的真实成功执行。

        这里刻意不再手写 `.mae-flow.json.tokens`——COMPILE Hook 令牌早已没有
        写入方，用它坐实完成度会让测试通过在生产上永不成立的路径。
        """
        from mae_flow_core.workflow.agent_observations import (
            record_agent_finished, record_agent_started,
        )
        from mae_flow_core.workflow.quality_executions import (
            quality_input_snapshot, record_quality_execution,
        )
        state_path = os.path.join(self.repo, ".mae-flow.json")
        step = state.get("current", "")
        at = "2026-07-28 11:00:00"
        record_agent_started(state_path, "COMPILE", step, invocation, at)
        record_agent_finished(state_path, invocation, "returned", at)
        record_quality_execution(
            state_path, "COMPILE", step, invocation,
            state.get("config", {}).get("编译方式", "") or "make all",
            True, quality_input_snapshot(state, "COMPILE", step), at)

    def assert_compile_commit_lifecycle(self, path, tracked):
        if tracked:
            write(self.repo, path, "compiled=false\n")
            git(self.repo, "add", path)
            git(self.repo, "commit", "-qm", "track configuration")
        task_head = git(self.repo, "rev-parse", "HEAD")
        write(self.repo, path, "compiled=true\n")
        state = self.state()
        state["agent_tasks"] = {"COMPILE": {
            "step": "build",
            "head": task_head,
            "sha256": "current-compile-task",
        }}
        mf.save_state(state)
        command = (
            'git add -- "%s" && git commit -m "[REQ123][fix]compile"'
            % path
        )
        original_head = git(self.repo, "rev-parse", "HEAD")

        pending = self.gate_bash(command)

        pending_output = pending.stdout + pending.stderr
        self.assertNotEqual(0, pending.returncode, pending_output)
        self.assertIn("先完成当前 COMPILE 任务", pending_output)
        self.assertEqual(original_head, git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only"))
        self.assertFalse(os.path.exists(
            os.path.join(self.repo, ".mae-flow.json.gate-strikes")))
        self.assertFalse(os.path.exists(
            os.path.join(self.repo, ".mae-flow.json.gate-permits")))

        self.mark_compile_completed(state)
        self.write_sidecar({
            path: {"task_sha256": "current-compile-task"},
        })

        attributed = self.gate_bash(command)

        attributed_output = attributed.stdout + attributed.stderr
        self.assertNotEqual(0, attributed.returncode, attributed_output)
        self.assertNotIn("先完成当前 COMPILE 任务", attributed_output)
        self.assertIn("由 COMPILE 命令产生或改写", attributed_output)
        self.assertEqual(original_head, git(self.repo, "rev-parse", "HEAD"))

        self.write_sidecar(paths={
            path: {"tool": "file-write"},
        })
        completed = self.gate_bash(command)
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
        )
        git(self.repo, "add", "--", path)
        git(self.repo, "commit", "-qm", "[REQ123][fix]compile")
        self.assertNotEqual(original_head, git(self.repo, "rev-parse", "HEAD"))

    def decide_pending_files(self, state):
        (inherited, foreign_openspec, compile_side_effects,
         strong_artifacts, unproven_paths, artifact_hints) = (
             mf._pending_commit_files("", state))
        decision = decide_ownership(OwnershipFacts(
            candidate_paths=tuple(mf._pending_commit_candidates()["paths"]),
            inherited=tuple(inherited),
            foreign_openspec=tuple(foreign_openspec),
            compile_side_effects=tuple(compile_side_effects),
            staged_compile_side_effects=tuple(compile_side_effects),
            command_compile_side_effects=(),
            strong_artifacts=tuple(strong_artifacts),
            unproven_paths=tuple(unproven_paths),
            artifact_hints=tuple(artifact_hints),
        ))
        return compile_side_effects, decision

    def test_unchanged_previous_story_is_blocked_before_commit(self):
        old_story = "openspec/changes/old/STORY-REQ122.md"
        write(self.repo, old_story, "# STORY-REQ122\n\n上一单。\n")
        state = self.state()
        self.mark_initial(state, old_story)
        git(self.repo, "add", old_story)

        inherited, foreign, compile_side_effects, strong, unproven, hints = (
            mf._pending_commit_files("", state))

        self.assertEqual([old_story], inherited)
        self.assertEqual([old_story], foreign)
        self.assertFalse(compile_side_effects)
        self.assertFalse(strong)
        self.assertIn(old_story, unproven)
        self.assertFalse(hints)

    def test_recorded_compile_side_effect_blocks_new_configuration_file(self):
        generated = "config/generated.properties"
        write(self.repo, generated, "compiled=true\n")
        self.write_sidecar({"./" + generated: {"task_sha256": "compile"}})
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([generated], compile_side_effects)
        self.assertEqual("bash-compile-side-effects", decision.block.rule)

    def test_recorded_compile_side_effect_blocks_tracked_configuration_file(self):
        generated = "config/runtime.properties"
        write(self.repo, generated, "compiled=false\n")
        git(self.repo, "add", generated)
        git(self.repo, "commit", "-qm", "track runtime config")
        write(self.repo, generated, "compiled=true\n")
        self.write_sidecar({generated: {"task_sha256": "compile"}})
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([generated], compile_side_effects)
        self.assertEqual("bash-compile-side-effects", decision.block.rule)

    def test_valid_compile_risk_receipt_closes_pending_commit_window(self):
        path = "src/repair.cpp"
        state = self.save_pending_compile()
        write(self.repo, path, "int repaired() { return 1; }\n")
        task = state["agent_tasks"]["COMPILE"]
        snapshot = mf._source_snapshot_since(task["head"], state, mf.FLOW)
        state["risk_acceptances"] = {"COMPILE": {
            "step": "build",
            "head": task["head"],
            "at": "9999-12-31 23:59:59",
            "task_sha256": task["sha256"],
            "source_snapshot": snapshot,
        }}
        mf.save_state(state)

        result = self.gate_bash(
            'git add -- "%s" && git commit -m "[REQ123][fix]compile"'
            % path)

        output = result.stdout + result.stderr
        self.assertEqual(0, result.returncode, output)
        self.assertNotIn("先完成当前 COMPILE 任务", output)

    def test_multiple_head_mutations_in_one_bash_are_rejected(self):
        path = "config/runtime.properties"
        write(self.repo, path, "baseline=true\n")
        git(self.repo, "add", "--", path)
        git(self.repo, "commit", "-qm", "track runtime config")
        write(self.repo, path, "compiled=true\n")
        self.write_sidecar({
            path: {"task_sha256": "compile-task"},
        })
        mf.save_state(self.state())
        commands = (
            (
                'git commit -m "[REQ123][fix]first" -- "%s" && '
                'git commit -m "[REQ123][fix]second"' % path
            ),
            (
                'git commit -m malformed && '
                'git commit -m "[REQ123][fix]second"'
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                result = self.gate_bash(command)
                output = result.stdout + result.stderr
                self.assertNotEqual(0, result.returncode, output)
                self.assertIn("每次一个", output)
                self.assertIn("commit/revert", output)
                self.assertFalse(os.path.exists(os.path.join(
                    self.repo, ".mae-flow.json.gate-strikes")))
                self.assertFalse(os.path.exists(os.path.join(
                    self.repo, ".mae-flow.json.gate-permits")))

    def test_mutating_git_aliases_cannot_hide_a_pending_commit(self):
        self.save_pending_compile()
        git(self.repo, "config", "alias.ci", "commit")
        commands = (
            'git ci -m "[REQ123][fix]aliased commit"',
            (
                'git -c alias.ci=commit ci '
                '-m "[REQ123][fix]inline aliased commit"'
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                result = self.gate_bash(command)
                output = result.stdout + result.stderr
                self.assertNotEqual(0, result.returncode, output)
                self.assertIn("alias", output.lower())
                self.assertIn("commit", output)
                self.assertFalse(os.path.exists(os.path.join(
                    self.repo, ".mae-flow.json.gate-strikes")))

        git(self.repo, "config", "alias.lg", "log --oneline")
        read_only = self.gate_bash("git lg")
        self.assertEqual(
            0,
            read_only.returncode,
            read_only.stdout + read_only.stderr,
        )

    def test_opaque_pathspec_file_is_rejected_for_git_writes(self):
        path = "config/runtime.properties"
        write(self.repo, path, "baseline=true\n")
        git(self.repo, "add", "--", path)
        git(self.repo, "commit", "-qm", "track runtime config")
        write(self.repo, path, "compiled=true\n")
        write(self.repo, "paths.txt", path + "\n")
        self.write_sidecar({
            path: {"task_sha256": "compile-task"},
        })
        mf.save_state(self.state())
        commands = (
            (
                'git commit --pathspec-from-file=paths.txt '
                '-m "[REQ123][fix]opaque commit"'
            ),
            (
                'git add --pathspec-from-file=paths.txt && '
                'git commit -m "[REQ123][fix]opaque add"'
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                result = self.gate_bash(command)
                output = result.stdout + result.stderr
                self.assertNotEqual(0, result.returncode, output)
                self.assertIn("pathspec-from-file", output)
                self.assertIn("显式", output)
                self.assertFalse(os.path.exists(os.path.join(
                    self.repo, ".mae-flow.json.gate-strikes")))

    def test_agent_python_subprocess_cannot_rewrap_git_mutations(self):
        mf.save_state(self.state())
        original_head = git(self.repo, "rev-parse", "HEAD")
        commands = (
            (
                'python -c "import subprocess; '
                "subprocess.run(['git','add','openspec/changes/current-change']); "
                "subprocess.run(['git','commit','-m','[REQ123][fix]wrapped'])\""
            ),
            (
                'python -c "import os; '
                "os.execvp('git',['git','commit','-m',"
                "'[REQ123][fix]wrapped'])\""
            ),
            (
                'python -c "import subprocess; g=\'git\'; '
                "subprocess.run([g,'commit','-m','[REQ123][fix]wrapped'])\""
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                result = self.gate_bash(command)
                output = result.stdout + result.stderr
                self.assertNotEqual(0, result.returncode, output)
                self.assertIn("解释器", output)
                self.assertIn("绕过", output)
                self.assertEqual(
                    original_head,
                    git(self.repo, "rev-parse", "HEAD"),
                )
                self.assertEqual("", git(
                    self.repo, "diff", "--cached", "--name-only"))

    def test_shell_wrappers_with_value_bearing_git_globals_are_blocked(self):
        self.save_pending_compile()
        original_head = git(self.repo, "rev-parse", "HEAD")
        commands = (
            (
                "sh -c 'git -c user.name=Fixture commit "
                '-m "[REQ123][fix]wrapped" --allow-empty\''
            ),
            (
                'powershell -Command "git -c user.name=Fixture commit '
                "-m '[REQ123][fix]wrapped' --allow-empty\""
            ),
            (
                'cmd /c "git -c user.name=Fixture commit '
                '-m [REQ123][fix]wrapped --allow-empty"'
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                result = self.gate_bash(command)
                output = result.stdout + result.stderr
                self.assertNotEqual(0, result.returncode, output)
                self.assertIn("解释器", output)
                self.assertIn("commit", output)
                self.assertEqual(
                    original_head,
                    git(self.repo, "rev-parse", "HEAD"),
                )

    def test_case_insensitive_identity_matches_compile_ledger_spelling(self):
        generated = "config/runtime.properties"
        write(self.repo, generated, "compiled=false\n")
        git(self.repo, "add", generated)
        git(self.repo, "commit", "-qm", "track runtime config")
        write(self.repo, generated, "compiled=true\n")
        self.write_sidecar({
            "CONFIG\\RUNTIME.PROPERTIES": {"task_sha256": "compile"},
        })
        git(self.repo, "add", generated)
        windows_os = mock.Mock(wraps=os)
        windows_os.name = "nt"

        with mock.patch.object(git_ownership, "os", windows_os):
            compile_side_effects, decision = self.decide_pending_files(
                self.state())

        self.assertEqual([generated], compile_side_effects)
        self.assertEqual("bash-compile-side-effects", decision.block.rule)

    def test_old_sidecar_without_compile_effects_stays_compatible(self):
        generated = "config/generated.properties"
        write(self.repo, generated, "legacy=true\n")
        self.write_sidecar(paths={generated: {"tool": "file-write"}})
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_malformed_legacy_sidecar_fails_open(self):
        generated = "config/generated.properties"
        write(self.repo, generated, "legacy=true\n")
        write(self.repo, ".mae-flow.json.agent-writes", "{not json\n")
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_snapshot_separates_staged_and_compound_add_candidates(self):
        staged = "config/staged.properties"
        command_only = "internal/generated/build.properties"
        write(self.repo, staged, "staged=true\n")
        write(self.repo, command_only, "compiled=true\n")
        self.write_sidecar({
            staged: {"task_sha256": "compile"},
            command_only: {"task_sha256": "compile"},
        })
        git(self.repo, "add", staged)
        command = "git add %s && git commit -m '[REQ123][fix]compile'" % command_only
        snapshot = mf._pending_commit_candidates(command)
        (inherited, foreign_openspec, compile_side_effects,
         strong_artifacts, unproven_paths, artifact_hints) = (
             mf._pending_commit_files(command, self.state(), snapshot))

        self.assertFalse(inherited)
        self.assertFalse(foreign_openspec)
        self.assertEqual([staged, command_only], compile_side_effects)
        self.assertEqual({staged}, snapshot["staged_paths"])
        self.assertEqual({command_only}, snapshot["working_paths"])
        self.assertFalse(strong_artifacts)
        self.assertIn(staged, unproven_paths)
        self.assertIn(command_only, unproven_paths)
        self.assertFalse(artifact_hints)

    def test_unwritten_output_artifact_is_blocked_with_a_permit_route(self):
        """别的编译任务的台账不该给它归属，但它仍是 Agent 没写过的产物。"""
        artifact = "dist/app.js"
        write(self.repo, artifact, "console.log('release');\n")
        self.write_sidecar({"internal/generated/build.properties": {
            "task_sha256": "different-compile",
        }})
        git(self.repo, "add", artifact)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual(
            [], compile_side_effects, "不能张冠李戴地归属到别的编译任务")
        self.assertEqual(
            "bash-build-output-artifacts", decision.block.rule)
        self.assertEqual(
            "block", decision.block.kind, "裁决类:用户可一次性放行")

    def test_tracked_deletion_without_compile_ledger_remains_committable(self):
        path = "config/runtime.properties"
        write(self.repo, path, "compiled=false\n")
        git(self.repo, "add", path)
        git(self.repo, "commit", "-qm", "track runtime")
        os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", path)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_preexisting_task_deletion_without_ledger_remains_committable(self):
        path = "config/preexisting.properties"
        write(self.repo, path, "compiled=false\n")
        git(self.repo, "add", path)
        git(self.repo, "commit", "-qm", "track preexisting runtime")
        os.remove(os.path.join(self.repo, path))
        self.write_sidecar(compile_side_effects={})
        git(self.repo, "add", "-u", "--", path)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_recorded_compile_effect_deletions_are_not_delivery_outputs(self):
        staged = "config/staged.properties"
        commit_all = "config/commit-all.properties"
        pathspec = "config/pathspec.properties"
        for path in (staged, commit_all, pathspec):
            write(self.repo, path, "compiled=true\n")
        git(self.repo, "add", "config")
        git(self.repo, "commit", "-qm", "track compile outputs")
        self.write_sidecar({
            path: {"task_sha256": "older-compile"}
            for path in (staged, commit_all, pathspec)
        })
        for path in (staged, commit_all, pathspec):
            os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", staged)

        commands = (
            "",
            'git commit -am "[REQ123][fix]remove output"',
            'git commit -m "[REQ123][fix]remove output" -- ' + pathspec,
        )
        for command in commands:
            with self.subTest(command=command or "staged"):
                snapshot = mf._pending_commit_candidates(command)
                values = mf._pending_commit_files(
                    command, self.state(), snapshot)
                self.assertEqual([], values[2])

    def test_compound_add_recreated_staged_deletion_is_a_compile_output(self):
        path = "config/runtime.properties"
        write(self.repo, path, "baseline=true\n")
        git(self.repo, "add", "--", path)
        git(self.repo, "commit", "-qm", "track runtime config")
        self.write_sidecar({
            path: {"task_sha256": "compile-task"},
        })
        os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", path)
        write(self.repo, path, "recreated=true\n")
        mf.save_state(self.state())
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]recreated output"' % path
        )

        snapshot = mf._pending_commit_candidates(command)
        result = self.gate_bash(command)

        self.assertIn(path, snapshot["present_paths"])
        self.assertNotIn(path, snapshot["deleted_paths"])
        self.assertNotIn(path, snapshot["new_paths"])
        output = result.stdout + result.stderr
        self.assertNotEqual(0, result.returncode, output)
        self.assertIn(path, output)
        self.assertIn("COMPILE", output)

    def test_compound_add_recreated_staged_deletion_is_foreign_openspec(self):
        path = "openspec/changes/foreign-change/change.md"
        write(self.repo, path, "# baseline foreign\n")
        git(self.repo, "add", "--", path)
        git(self.repo, "commit", "-qm", "track foreign change")
        os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", path)
        write(self.repo, path, "# recreated foreign\n")
        mf.save_state(self.state())
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]recreated foreign"' % path
        )

        snapshot = mf._pending_commit_candidates(command)
        result = self.gate_bash(command)

        self.assertIn(path, snapshot["present_paths"])
        self.assertNotIn(path, snapshot["deleted_paths"])
        output = result.stdout + result.stderr
        self.assertNotEqual(0, result.returncode, output)
        self.assertIn(path, output)

    def test_foreign_openspec_deletion_is_not_a_delivery_output(self):
        foreign = "openspec/changes/retired-change/change.md"
        write(self.repo, foreign, "# retired\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "track retired change")
        os.remove(os.path.join(self.repo, foreign))
        git(self.repo, "add", "-u", "--", foreign)

        values = mf._pending_commit_files("", self.state())

        self.assertEqual([], values[1])

    def test_force_added_ignored_config_stays_blocked_without_provenance(self):
        write(self.repo, ".gitignore", "*.compile-local\n")
        git(self.repo, "add", ".gitignore")
        git(self.repo, "commit", "-qm", "ignore compile-local files")
        path = "config/runtime.compile-local"
        write(self.repo, path, "generated=true\n")
        state = self.save_pending_compile()
        command = (
            'git add -f -- "%s" && '
            'git commit -m "[REQ123][fix]compile output"' % path
        )

        pending = self.gate_bash(command)
        self.assertIn(
            "高置信临时编译产物或显式 force-add",
            pending.stdout + pending.stderr,
        )
        self.mark_compile_completed(state)

        completed = self.gate_bash(command)

        output = completed.stdout + completed.stderr
        self.assertNotEqual(0, completed.returncode, output)
        self.assertIn(path, output)
        self.assertIn("force", output.lower())
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only"))

    def test_compile_hard_block_precedes_foreign_authorization(self):
        path = "openspec/changes/foreign-generated/change.md"
        write(self.repo, path, "# compile-generated foreign\n")
        self.write_sidecar({
            path: {"task_sha256": "compile-task"},
        })
        mf.save_state(self.state())
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]combined ownership"' % path
        )

        result = self.gate_bash(command)

        output = result.stdout + result.stderr
        self.assertNotEqual(0, result.returncode, output)
        self.assertIn("COMPILE", output)
        self.assertIn("foreign-generated", output)
        self.assertIn("同时检测到其他独立问题", output)
        self.assertNotIn(" allow ", output)
        self.assertFalse(os.path.exists(os.path.join(
            self.repo, ".mae-flow.json.gate-strikes")))
        self.assertFalse(os.path.exists(os.path.join(
            self.repo, ".mae-flow.json.gate-permits")))

    def test_openspec_trust_is_limited_to_current_delivery(self):
        current = "openspec/changes/current-change/change.md"
        foreign = "openspec/changes/another-change/change.md"
        disguised_story = "openspec/changes/current-change/notes.md"
        write(self.repo, current, "# 变更\n")
        write(self.repo, foreign, "# 其他单\n")
        write(self.repo, disguised_story, "# STORY-REQ123\n")

        state = self.state()
        self.assertTrue(mf._trusted_harness_commit_path(current, state))
        self.assertFalse(mf._trusted_harness_commit_path(foreign, state))
        self.assertFalse(mf._trusted_harness_commit_path(disguised_story, state))

        state["spec"] = {
            "archived_to": "2026-07-28-current-change",
            "archive_paths": [
                "openspec/changes/archive/2026-07-28-current-change",
                "openspec/specs/runtime/spec.md",
            ],
        }
        self.assertTrue(mf._trusted_harness_commit_path(
            "openspec/changes/archive/2026-07-28-current-change/change.md",
            state))
        self.assertTrue(mf._trusted_harness_commit_path(
            "openspec/specs/runtime/spec.md", state))
        self.assertFalse(mf._trusted_harness_commit_path(
            "openspec/specs/other/spec.md", state))

    def test_push_backstop_detects_manually_committed_carryover(self):
        old_story = "openspec/changes/old/STORY-REQ122.md"
        write(self.repo, old_story, "# STORY-REQ122\n\n上一单。\n")
        state = self.state(current="push")
        self.mark_initial(state, old_story)
        write(self.repo, "src/current.cpp", "int current = 1;\n")
        git(self.repo, "add", old_story, "src/current.cpp")
        git(self.repo, "commit", "-qm", "[REQ123][fix]current")
        remote = os.path.join(self.tmp, "remote.git")
        git(self.tmp, "init", "--bare", "-q", remote)
        git(self.repo, "remote", "add", "origin", remote)
        git(self.repo, "push", "-qu", "origin", "HEAD")

        ok, why = mf.ev_pushed({}, state)

        self.assertFalse(ok)
        self.assertIn(old_story, why)
        self.assertIn("上一单", why)

    def test_push_backstop_detects_story_disguised_in_current_openspec(self):
        disguised = "openspec/changes/current-change/notes.md"
        state = self.state(current="push")
        write(self.repo, disguised, "# STORY-REQ123\n\n不应入库。\n")
        git(self.repo, "add", disguised)
        git(self.repo, "commit", "-qm", "[REQ123][fix]current")
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, state)

        self.assertFalse(ok)
        self.assertIn(disguised, why)
        self.assertIn("不属于当前", why)

    def test_push_allows_eight_deleted_historical_openspec_paths(self):
        prefix = "openspec/changes/resend-condition-change"
        historical = [
            prefix + "/" + name
            for name in (
                "change.md",
                "design.md",
                "proposal.md",
                "tasks.md",
                "specs/nsa/spec.md",
                "specs/storage/spec.md",
                "specs/neighbor/spec.md",
                "notes/decision.md",
            )
        ]
        for path in historical:
            write(self.repo, path, "# historical\n")
        git(self.repo, "add", prefix)
        git(self.repo, "commit", "-qm", "historical fixture")
        git(self.repo, "branch", "-f", "main", "HEAD")
        for path in historical:
            os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", prefix)
        git(self.repo, "commit", "-qm", "[REQ123][fix]historical cleanup")
        self.push_to_new_remote()
        state = self.state(current="push")
        state["config"]["CHANGE_NAME"] = "nsa-storage-neighbor-fix"

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)

    def test_push_still_blocks_added_foreign_openspec(self):
        foreign = "openspec/changes/resend-condition-change/change.md"
        write(self.repo, foreign, "# foreign added\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "[REQ123][fix]foreign add")
        self.push_to_new_remote()
        state = self.state(current="push")
        state["config"]["CHANGE_NAME"] = "nsa-storage-neighbor-fix"

        ok, why = mf.ev_pushed({}, state)

        self.assertFalse(ok)
        self.assertIn(foreign, why)

    def test_push_still_blocks_modified_foreign_openspec(self):
        foreign = "openspec/changes/resend-condition-change/change.md"
        write(self.repo, foreign, "# baseline foreign\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "foreign fixture")
        git(self.repo, "branch", "-f", "main", "HEAD")
        write(self.repo, foreign, "# modified foreign\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "[REQ123][fix]foreign modify")
        self.push_to_new_remote()
        state = self.state(current="push")
        state["config"]["CHANGE_NAME"] = "nsa-storage-neighbor-fix"

        ok, why = mf.ev_pushed({}, state)

        self.assertFalse(ok)
        self.assertIn(foreign, why)

    def test_exact_user_authorization_survives_gate_into_pushed_evidence(self):
        foreign = "openspec/changes/user-selected-change/change.md"
        write(self.repo, foreign, "# user-selected foreign change\n")
        state = self.state(current="build")
        mf.save_state(state)
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized change"'
            % foreign
        )
        ack = "我明确授权 Agent 提交 " + foreign

        first_output, _permit_id = self.authorize_blocked_command(
            command,
            "bash-foreign-openspec",
            ack,
        )
        self.assertIn(" allow ", first_output)
        allowed = self.gate_bash(command)
        self.assertEqual(
            0, allowed.returncode, allowed.stdout + allowed.stderr)
        git(self.repo, "add", "--", foreign)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user-authorized change",
        )
        self.posttool_bash(command)
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, mf.load_state())

        self.assertTrue(ok, why)

    def test_exact_carryover_authorization_survives_into_pushed_evidence(self):
        carryover = "docs/user-selected-carryover.md"
        write(self.repo, carryover, "# user-selected carryover\n")
        state = self.state(current="build")
        self.mark_initial(state, carryover)
        mf.save_state(state)
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized carryover"'
            % carryover
        )
        ack = "我明确授权 Agent 提交 " + carryover

        self.authorize_blocked_command(
            command,
            "bash-cross-delivery-carryover",
            ack,
        )
        allowed = self.gate_bash(command)
        self.assertEqual(
            0, allowed.returncode, allowed.stdout + allowed.stderr)
        git(self.repo, "add", "--", carryover)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user-authorized carryover",
        )
        self.posttool_bash(command)
        finalized = [
            record for record in (
                mf.load_state().get("git_authorizations", ()) or ())
            if record.get("rule") == "bash-cross-delivery-carryover"
        ]
        self.assertEqual(1, len(finalized))
        self.assertTrue(finalized[0].get("finalized"))
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, mf.load_state())

        self.assertTrue(ok, why)

    def test_exact_carryover_authorization_does_not_cover_an_extra_path(self):
        carryover = "docs/user-selected-carryover.md"
        extra = "docs/unapproved-carryover.md"
        write(self.repo, carryover, "# user-selected carryover\n")
        write(self.repo, extra, "# unapproved carryover\n")
        state = self.state(current="build")
        self.mark_initial(state, carryover)
        self.mark_initial(state, extra)
        mf.save_state(state)
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized carryover"'
            % carryover
        )
        ack = "我明确授权 Agent 提交 " + carryover
        self.authorize_blocked_command(
            command,
            "bash-cross-delivery-carryover",
            ack,
        )
        self.assertEqual(0, self.gate_bash(command).returncode)
        git(self.repo, "add", "--", carryover)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user-authorized carryover",
        )
        self.posttool_bash(command)
        receipt = mf.load_state()["git_authorizations"][0]
        self.assertEqual([carryover], receipt.get("paths"))
        git(self.repo, "add", "--", extra)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]unapproved carryover",
        )
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, mf.load_state())

        self.assertFalse(ok)
        self.assertIn(extra, why)

    def test_exact_carryover_authorization_expires_after_later_path_commit(self):
        carryover = "docs/user-selected-carryover.md"
        write(self.repo, carryover, "# authorized version\n")
        state = self.state(current="build")
        self.mark_initial(state, carryover)
        mf.save_state(state)
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized carryover"'
            % carryover
        )
        ack = "我明确授权 Agent 提交 " + carryover
        self.authorize_blocked_command(
            command,
            "bash-cross-delivery-carryover",
            ack,
        )
        self.assertEqual(0, self.gate_bash(command).returncode)
        git(self.repo, "add", "--", carryover)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user-authorized carryover",
        )
        self.posttool_bash(command)
        receipt = mf.load_state()["git_authorizations"][0]
        self.assertTrue(receipt.get("finalized"))
        write(self.repo, carryover, "# later unapproved version\n")
        git(self.repo, "add", "--", carryover)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]later carryover change",
        )
        write(self.repo, carryover, "# authorized version\n")
        git(self.repo, "add", "--", carryover)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]restore original carryover",
        )
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, mf.load_state())

        self.assertFalse(ok)
        self.assertIn(carryover, why)

    def test_exact_user_authorization_accepts_a_path_with_spaces(self):
        foreign = "openspec/changes/user selected/change.md"
        write(self.repo, foreign, "# user-selected foreign change\n")
        state = self.state(current="build")
        mf.save_state(state)
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized spaced path"'
            % foreign
        )
        ack = "我明确授权 Agent 提交 " + foreign

        self.authorize_blocked_command(
            command,
            "bash-foreign-openspec",
            ack,
        )
        allowed = self.gate_bash(command)

        self.assertEqual(
            0,
            allowed.returncode,
            allowed.stdout + allowed.stderr,
        )

    def test_exact_authorization_does_not_trust_a_later_same_path_commit(self):
        foreign = "openspec/changes/user-selected-change/change.md"
        write(self.repo, foreign, "# authorized version\n")
        state = self.state(current="build")
        mf.save_state(state)
        command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized change"'
            % foreign
        )
        ack = "我明确授权 Agent 提交 " + foreign
        self.authorize_blocked_command(
            command,
            "bash-foreign-openspec",
            ack,
        )
        self.assertEqual(0, self.gate_bash(command).returncode)
        git(self.repo, "add", "--", foreign)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user-authorized change",
        )
        self.posttool_bash(command)
        write(self.repo, foreign, "# later unapproved version\n")
        git(self.repo, "add", "--", foreign)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]later external change",
        )
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, mf.load_state())

        self.assertFalse(ok)
        self.assertIn(foreign, why)

    def test_exact_user_authorized_revert_finalizes_into_push_evidence(self):
        foreign = "openspec/changes/reverted-foreign/change.md"
        git(self.repo, "checkout", "-qb", "revert-source", "main")
        write(self.repo, foreign, "# source history\n")
        git(self.repo, "add", "--", foreign)
        git(self.repo, "commit", "-qm", "source parent")
        os.remove(os.path.join(self.repo, foreign))
        git(self.repo, "add", "-u", "--", foreign)
        git(self.repo, "commit", "-qm", "source deletion")
        target = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "feature")
        state = self.state(current="build")
        mf.save_state(state)
        command = "git revert " + target
        ack = "我明确授权 Agent 执行 git revert " + target

        self.authorize_blocked_command(
            command,
            "bash-git-revert-user-authorization",
            ack,
        )
        allowed = self.gate_bash(command)
        self.assertEqual(
            0, allowed.returncode, allowed.stdout + allowed.stderr)
        git(self.repo, "revert", target)
        self.posttool_bash(command)
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, mf.load_state())

        self.assertTrue(ok, why)

    def test_exact_user_authorization_does_not_expand_to_an_extra_path(self):
        first = "openspec/changes/user-selected-change/change.md"
        extra = "openspec/changes/unapproved-change/change.md"
        write(self.repo, first, "# approved\n")
        write(self.repo, extra, "# extra\n")
        state = self.state(current="build")
        mf.save_state(state)
        exact_command = (
            'git add -- "%s" && '
            'git commit -m "[REQ123][fix]user-authorized change"'
            % first
        )
        ack = "我明确授权 Agent 提交 " + first
        self.authorize_blocked_command(
            exact_command,
            "bash-foreign-openspec",
            ack,
        )
        expanded_command = (
            'git add -- "%s" "%s" && '
            'git commit -m "[REQ123][fix]expanded change"'
            % (first, extra)
        )

        expanded = self.gate_bash(expanded_command)

        output = expanded.stdout + expanded.stderr
        self.assertNotEqual(0, expanded.returncode, output)
        self.assertIn(extra, output)

    def test_source_write_before_workflow_chosen_is_blocked(self):
        """步骤级源码闸已退役(2026-08-28 用户拍板"编码阶段自由"),
        仅存的机械阻断是头部纪律:交付方式未选定时 Bash 写码打回;
        选定之后同一命令放行(交付链内编辑自由)。"""
        source = "src/main.py"
        write(self.repo, source, "value = 1\n")
        head_state = self.state(current="config_confirm")
        head_state["choices"] = {}
        mf.save_state(head_state)
        command = "sed -i 's/value/other/' " + source

        blocked = self.gate_bash(command)

        self.assertNotEqual(0, blocked.returncode)
        self.assertIn("交付方式尚未选定", blocked.stdout + blocked.stderr)

        mf.save_state(self.state(current="config_confirm"))
        allowed = self.gate_bash(command)
        self.assertEqual(
            0, allowed.returncode, allowed.stdout + allowed.stderr)

    def test_user_external_current_delivery_needs_no_agent_provenance(self):
        current = "openspec/changes/current-change/change.md"
        write(self.repo, current, "# user committed current delivery\n")
        git(self.repo, "add", "--", current)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user external current delivery",
        )
        self.push_to_new_remote()
        state = self.state(current="push")
        self.assertFalse(os.path.exists(
            os.path.join(self.repo, ".mae-flow.json.agent-writes")))

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)

    def test_archive_clean_checks_only_exact_current_outputs(self):
        stale = "openspec/changes/old/change.md"
        archive = (
            "openspec/changes/archive/2026-07-28-current-change/change.md")
        merged = "openspec/specs/runtime/spec.md"
        write(self.repo, stale, "# old\n")
        state = self.state(current="archive")
        self.mark_initial(state, stale)
        write(self.repo, archive, "# current\n")
        write(self.repo, merged, "# spec\n")
        state["spec"] = {
            "phase": "archived",
            "archived_to": "2026-07-28-current-change",
            "archive_paths": [
                "openspec/changes/archive/2026-07-28-current-change",
                merged,
            ],
        }
        ok, why = mf.ev_archive_paths_clean({}, state)
        self.assertFalse(ok)
        self.assertIn("本次定稿产物", why)
        self.assertNotIn(stale, why)

        git(self.repo, "add",
            "openspec/changes/archive/2026-07-28-current-change", merged)
        git(self.repo, "commit", "-qm", "[REQ123][fix]archive")
        ok, why = mf.ev_archive_paths_clean({}, state)
        self.assertTrue(ok, why)
        self.assertTrue(os.path.isfile(stale))

    def test_story_localize_unstages_and_corrects_wrong_directory(self):
        wrong = "openspec/changes/old/story-notes.md"
        write(self.repo, wrong, "# STORY-REQ123\n\n本地交测。\n")
        git(self.repo, "add", wrong)

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            destination = mf._localize_story("REQ123")

        self.assertFalse(os.path.exists(wrong))
        self.assertTrue(os.path.isfile(destination))
        self.assertTrue(destination.startswith(".mae-flow-work/story/"))
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only", "--", wrong))
        self.assertNotIn(".mae-flow-work", git(
            self.repo, "status", "--short", "--untracked-files=all"))
        exclude = git(self.repo, "rev-parse", "--git-path", "info/exclude")
        with open(os.path.join(self.repo, exclude), encoding="utf-8") as stream:
            self.assertIn("/.mae-flow-work/", stream.read())
        self.assertIn("错误目录", output.getvalue())

    def test_full_flow_can_canonicalize_one_wrong_story_before_evidence(self):
        wrong = "openspec/changes/current-change/notes.md"
        canonical = "docs/story/STORY-REQ123.md"
        write(self.repo, wrong, "# STORY-REQ123\n\n本单内容。\n")
        git(self.repo, "add", wrong)

        with contextlib.redirect_stdout(io.StringIO()):
            result = mf._canonicalize_story_output("REQ123")

        self.assertEqual(canonical, result)
        self.assertFalse(os.path.exists(wrong))
        self.assertTrue(os.path.isfile(canonical))
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only", "--", wrong))

    def test_full_flow_does_not_adopt_unchanged_previous_story(self):
        wrong = "openspec/changes/old/notes.md"
        write(self.repo, wrong, "# STORY-REQ123\n\n上一单内容。\n")
        state = self.state(current="story")
        self.mark_initial(state, wrong)

        result = mf._canonicalize_story_output("REQ123", state)

        self.assertEqual("", result)
        self.assertTrue(os.path.isfile(wrong))
        self.assertFalse(os.path.exists("docs/story/STORY-REQ123.md"))


if __name__ == "__main__":
    unittest.main()
