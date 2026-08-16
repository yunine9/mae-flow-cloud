#!/usr/bin/env python3
"""Public behavior contract for the lean workflow safety kernel."""

import json
import os
import shlex
import sys
import unittest
from dataclasses import replace


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.guard.manifest import DeliveryManifest  # noqa: E402
from mae_flow_core.guard.safety_kernel import (  # noqa: E402
    SafetyContext,
    SafetyDecision,
    decide_pretool,
)
from mae_flow_core.orchestration import (  # noqa: E402
    CapabilityAttempt,
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
)


FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "fixtures", "lean_git_cases.json"
)


def _command(argv):
    """Adapt fixture argv to the command-string parser boundary."""
    return " ".join(shlex.quote(str(token)) for token in argv)


def _paths(paths, repository_root):
    return DeliveryManifest.from_paths(
        paths, repository_root=repository_root).files


def _state(
        path=DeliveryPath.FULL,
        phase=Phase.CONSTRUCTION,
        decisions=(),
        delivery_files=(),
        initial_dirty=(),
        capabilities=()):
    return FlowState(
        ticket="REQ-7",
        path=path,
        phase=phase,
        commit_pace=CommitPace.STAGED,
        decisions=decisions,
        delivery_files=delivery_files,
        initial_dirty=initial_dirty,
        capabilities=capabilities,
    )


def _context(state, repository_root="/repo", **overrides):
    values = {
        "state": state,
        "repository_root": repository_root,
        "staged_files": (),
        "commit_files": (),
        "initial_dirty": (),
        "current_dirty_fingerprints": (),
    }
    values.update(overrides)
    return SafetyContext(**values)


class LeanSafetyKernelFixtureTests(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as fixture_file:
            self.fixture = json.load(fixture_file)

    def public_call(self, item):
        raw = item["context"]
        root = raw["working_directory"]
        manifest_input = raw["authorized_manifest"]
        candidate = _paths(manifest_input["files"], root)
        authorized = candidate if manifest_input["authorized"] else ()
        dirty = _paths(raw["preexisting_dirty_files"], root)
        phase = (
            Phase.CONSTRUCTION
            if raw["source_edit_confirmed"]
            else Phase.STORY
        )
        state = _state(
            phase=phase,
            delivery_files=authorized,
            initial_dirty=dirty,
        )
        context = _context(
            state,
            repository_root=root,
            staged_files=candidate,
            commit_files=candidate,
            initial_dirty=dirty,
            current_dirty_fingerprints=tuple(
                (path, "startup") for path in dirty),
        )

        argv = item["command"]["argv"]
        tool = "Bash"
        tool_input = {"command": _command(argv)}
        if argv[0] == "apply_patch":
            tool = "ApplyPatch"
            tool_input = {"targets": _paths([argv[1]], root)}
        elif item["operation_family"] == "protected_control":
            tool_input["targets"] = _paths([argv[-1]], root)
        elif item["operation_family"] == "filesystem":
            # A shell adapter owns argv parsing.  The pure kernel consumes the
            # already-parsed destructive targets that guard.bash recognizes.
            tool_input["recursive_delete_targets"] = (argv[-1],)
        return decide_pretool(context, tool, tool_input)

    def test_every_versioned_fixture_case_runs_through_the_public_api(self):
        self.assertEqual(1, self.fixture["schema_version"])
        decisions = {
            item["case"]: self.public_call(item)
            for item in self.fixture["cases"]
        }

        self.assertEqual(
            {
                item["case"]: item["expected"]["allowed"]
                for item in self.fixture["cases"]
            },
            {
                case: decision.allow
                for case, decision in decisions.items()
            },
        )
        self.assertTrue(all(
            isinstance(decision, SafetyDecision)
            for decision in decisions.values()
        ))
        for item in self.fixture["cases"]:
            if not item["expected"]["allowed"]:
                self.assertEqual(
                    item["operation_family"],
                    decisions[item["case"]].rule,
                    item["case"],
                )

    def test_windows_argv_is_adapted_without_losing_drive_or_backslashes(self):
        item = next(
            case for case in self.fixture["cases"]
            if case["case"] == "allowed_windows_exact_file_git_add"
        )

        decision = self.public_call(item)

        self.assertTrue(decision.allow)


class SourceEditAuthorizationTests(unittest.TestCase):
    def decision(self, state, target, **context_facts):
        return decide_pretool(
            _context(state, **context_facts),
            "Edit",
            {"targets": (target,)},
        )

    def test_full_source_edits_require_construction_or_quality_fix_approval(self):
        construction = self.decision(
            _state(phase=Phase.CONSTRUCTION), "src/main.py")
        story = self.decision(
            _state(phase=Phase.STORY), "src/main.py")
        quality = self.decision(
            _state(phase=Phase.QUALITY), "src/main.py")
        approved_quality = self.decision(
            _state(
                phase=Phase.QUALITY,
                decisions=((
                    "quality.source_fix_approved",
                    "The user approved the diagnosed source fix.",
                ),),
            ),
            "src/main.py",
        )

        self.assertTrue(construction.allow)
        self.assertEqual((False, "source_edit"), (story.allow, story.rule))
        self.assertEqual((False, "source_edit"), (quality.allow, quality.rule))
        self.assertTrue(approved_quality.allow)

    def test_focused_source_edits_require_scope_approval(self):
        unapproved = self.decision(
            _state(path=DeliveryPath.FOCUSED), "src/main.py")
        approved = self.decision(
            _state(
                path=DeliveryPath.FOCUSED,
                decisions=((
                    "focused.scope_approved",
                    "The user approved the focused change scope.",
                ),),
            ),
            "src/main.py",
        )

        self.assertEqual((False, "source_edit"), (
            unapproved.allow, unapproved.rule))
        self.assertTrue(approved.allow)

    def test_documentation_and_work_packages_are_allowed_outside_coding(self):
        startup = _state(phase=Phase.STARTUP)

        documentation = self.decision(startup, "docs/decision.md")
        work_package = self.decision(
            startup, ".mae-flow-work/REQ-7/plan.md")

        self.assertTrue(documentation.allow)
        self.assertTrue(work_package.allow)

    def test_unknown_repository_writes_are_scope_controlled(self):
        targets = (
            "web/index.html",
            "web/site.css",
            "LICENSE",
            "config/application.yaml",
            "tests/page.snapshot",
        )
        full_before = _state(phase=Phase.STORY)
        full_after = _state(phase=Phase.CONSTRUCTION)
        focused_before = _state(path=DeliveryPath.FOCUSED)
        focused_after = _state(
            path=DeliveryPath.FOCUSED,
            decisions=((
                "focused.scope_approved",
                "The user approved the focused change scope.",
            ),),
        )

        for target in targets:
            with self.subTest(target=target):
                full_blocked = self.decision(full_before, target)
                focused_blocked = self.decision(focused_before, target)
                self.assertEqual(
                    (False, "source_edit"),
                    (full_blocked.allow, full_blocked.rule),
                )
                self.assertTrue(self.decision(full_after, target).allow)
                self.assertEqual(
                    (False, "source_edit"),
                    (focused_blocked.allow, focused_blocked.rule),
                )
                self.assertTrue(self.decision(focused_after, target).allow)

    def test_adapter_can_explicitly_classify_a_non_source_target_as_safe(self):
        safe = self.decision(
            _state(phase=Phase.STARTUP),
            "generated/cache.bin",
            safe_write_targets=("generated/cache.bin",),
        )
        protected = self.decision(
            _state(phase=Phase.CONSTRUCTION),
            ".mae-flow.yml",
            safe_write_targets=(".mae-flow.yml",),
        )

        self.assertTrue(safe.allow)
        self.assertEqual(
            (False, "protected_control"),
            (protected.allow, protected.rule),
        )

    def test_safe_write_identity_follows_repository_path_style(self):
        startup = _state(phase=Phase.STARTUP)

        posix_case_mismatch = self.decision(
            startup,
            "Generated/Cache.bin",
            safe_write_targets=("generated/cache.bin",),
        )
        windows_drive_match = self.decision(
            startup,
            r"C:\WORK\REPO\Generated\Cache.bin",
            repository_root=r"c:\work\repo",
            safe_write_targets=("generated/cache.bin",),
        )
        windows_unc_match = self.decision(
            startup,
            r"\\SERVER\SHARE\REPO\Generated\Cache.bin",
            repository_root=r"\\server\share\repo",
            safe_write_targets=(r"generated\cache.bin",),
        )

        self.assertEqual(
            (False, "source_edit"),
            (posix_case_mismatch.allow, posix_case_mismatch.rule),
        )
        self.assertTrue(windows_drive_match.allow)
        self.assertTrue(windows_unc_match.allow)

    def test_protected_controls_precede_source_authorization(self):
        approved = _state(
            phase=Phase.CONSTRUCTION,
            delivery_files=(".mae-flow.yml",),
        )

        decision = self.decision(approved, ".mae-flow.yml")

        self.assertEqual(
            (False, "protected_control"),
            (decision.allow, decision.rule),
        )

    def test_protected_control_aliases_are_normalized_before_classification(self):
        aliases = (
            "work/../.mae-flow.yml",
            "../repo/.mae-flow.yml",
            "/repo/work/../.mae-flow.yml",
            r"work\..\.MAE-FLOW.YML",
            ".MAE-FLOW.YML",
        )
        state = _state(phase=Phase.CONSTRUCTION)

        for target in aliases:
            with self.subTest(target=target):
                decision = self.decision(
                    state,
                    target,
                    safe_write_targets=(target,),
                )
                self.assertEqual(
                    (False, "protected_control"),
                    (decision.allow, decision.rule),
                )

        windows = self.decision(
            state,
            r"C:\work\repo\work\..\.MaE-Flow.YmL",
            repository_root=r"c:\work\repo",
            safe_write_targets=(r"work\..\.MaE-Flow.YmL",),
        )
        self.assertEqual(
            (False, "protected_control"),
            (windows.allow, windows.rule),
        )

        rooted_current_drive = self.decision(
            state,
            r"\work\repo\.mae-flow.yml",
            repository_root=r"C:\work\repo",
            safe_write_targets=(r"\work\repo\.mae-flow.yml",),
        )
        safe_alias = self.decision(
            state,
            "../repo/.mae-flow.yml",
            safe_write_targets=("../repo/.mae-flow.yml",),
        )
        drive_relative = self.decision(
            state,
            r"C:.mae-flow.yml",
            repository_root=r"C:\work\repo",
            safe_write_targets=(r"C:.mae-flow.yml",),
        )

        self.assertEqual(
            (False, "protected_control"),
            (rooted_current_drive.allow, rooted_current_drive.rule),
        )
        self.assertEqual(
            (False, "protected_control"),
            (safe_alias.allow, safe_alias.rule),
        )
        self.assertEqual(
            (False, "source_edit"),
            (drive_relative.allow, drive_relative.rule),
        )


class GitManifestSafetyTests(unittest.TestCase):
    def manifest_state(self, **overrides):
        values = {
            "phase": Phase.DELIVERY,
            "delivery_files": ("src/a.cpp", "tests/a_test.cpp"),
        }
        values.update(overrides)
        return _state(**values)

    def bash(self, state, command, **facts):
        return decide_pretool(
            _context(state, **facts),
            "Bash",
            {"command": command},
        )

    def test_broad_staging_and_commit_options_block_before_manifest_checks(self):
        state = self.manifest_state()

        add = self.bash(state, "git add -A")
        commit = self.bash(state, "git commit -a -m update")

        self.assertEqual((False, "git_staging"), (add.allow, add.rule))
        self.assertEqual((False, "git_commit"), (
            commit.allow, commit.rule))

    def test_opaque_add_and_commit_pathspecs_block_before_manifest_checks(self):
        state = self.manifest_state()

        add = self.bash(
            state,
            "git add --pathspec-from-file=paths.txt",
            staged_files=("src/a.cpp", "tests/a_test.cpp"),
        )
        commit = self.bash(
            state,
            "git commit --pathspec-from-file paths.txt -m update",
            staged_files=("src/a.cpp", "tests/a_test.cpp"),
        )

        self.assertEqual((False, "git_staging"), (add.allow, add.rule))
        self.assertEqual((False, "git_commit"), (
            commit.allow, commit.rule))

    def test_git_pathspec_magic_cannot_be_authorized_as_an_exact_file(self):
        state = self.manifest_state(
            delivery_files=(":(exclude)README.md",))

        add = self.bash(state, "git add -- ':(exclude)README.md'")

        self.assertEqual((False, "git_staging"), (add.allow, add.rule))
        self.assertIn("exact", add.message.lower())

    def test_every_commit_invocation_is_checked_in_shell_order(self):
        state = self.manifest_state()
        commands = (
            "git commit -a -m first && git commit -m second",
            "git commit -m first && git commit -a -m second",
            (
                "git commit --include src/a.cpp -m first && "
                "git commit -m second"
            ),
            (
                "git commit -m first && "
                "git commit --include src/a.cpp -m second"
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                decision = self.bash(
                    state,
                    command,
                    staged_files=("src/a.cpp", "tests/a_test.cpp"),
                )
                self.assertEqual((False, "git_commit"), (
                    decision.allow, decision.rule))

    def test_heterogeneous_git_blocks_follow_shell_source_order(self):
        state = self.manifest_state()
        exact = ("src/a.cpp", "tests/a_test.cpp")
        cases = (
            (
                "git commit -a -m first && "
                "git add --pathspec-from-file=paths.txt",
                {"staged_files": exact},
                "git_commit",
            ),
            (
                "git add --pathspec-from-file=paths.txt && "
                "git commit -a -m second",
                {"staged_files": exact},
                "git_staging",
            ),
            (
                "git add src/a.cpp && "
                "git commit --pathspec-from-file=paths.txt -m second && "
                "git push origin main",
                {"staged_files": exact, "commit_files": exact},
                "git_commit",
            ),
            (
                "git push origin main && "
                "git add --pathspec-from-file=paths.txt",
                {"commit_files": ("src/a.cpp",)},
                "git_publish",
            ),
            (
                "git add -A && "
                "git commit --pathspec-from-file=paths.txt -m second && "
                "git push origin main",
                {"staged_files": exact, "commit_files": exact},
                "git_staging",
            ),
        )

        for command, facts, expected_rule in cases:
            with self.subTest(command=command):
                decision = self.bash(state, command, **facts)
                self.assertEqual(
                    (False, expected_rule),
                    (decision.allow, decision.rule),
                )

    def test_commit_requires_exact_actual_staged_manifest(self):
        state = self.manifest_state(capabilities=(CapabilityAttempt(
            "tests", "stale-source", "stale-env", "failed", "ignored"),))

        exact = self.bash(
            state,
            "git commit -m '[REQ-7][fix]修复查询映射'",
            staged_files=("tests/a_test.cpp", "src/a.cpp"),
        )
        missing = self.bash(
            state,
            "git commit -m update",
            staged_files=("src/a.cpp",),
        )
        extra = self.bash(
            state,
            "git commit -m update",
            staged_files=("src/a.cpp", "tests/a_test.cpp", "README.md"),
        )

        self.assertTrue(exact.allow)
        self.assertEqual((False, "git_commit"), (
            missing.allow, missing.rule))
        self.assertEqual((False, "git_commit"), (extra.allow, extra.rule))

    def test_commit_message_uses_ticket_and_actual_wrapper_arguments(self):
        state = self.manifest_state()
        exact = ("tests/a_test.cpp", "src/a.cpp")
        cases = (
            ("git commit -m update", False),
            ("git commit -m '[REQ-8][fix]错误单号'", False),
            ("git commit -m '[REQ-7][feat]实现查询条件'", True),
            ("git commit -m '[REQ-7][feat]保留尾部空格 '", True),
            ("git commit -m '[REQ-7][feat]摘要\n正文'", True),
            ("git commit -m '[REQ-7][feat] 描述前有空格'", False),
            (
                'cmd.exe /d /c git commit -m "[REQ-7][fix]修复结果映射"',
                True,
            ),
        )
        for command, expected_allow in cases:
            with self.subTest(command=command):
                decision = self.bash(
                    state, command, staged_files=exact)
                self.assertIs(expected_allow, decision.allow)
                if not expected_allow:
                    self.assertEqual("git_commit", decision.rule)
        missing_ticket = self.bash(
            replace(state, ticket=""),
            "git commit -m '[][fix]缺少单号'",
            staged_files=exact,
        )
        self.assertEqual((False, "git_commit"), (
            missing_ticket.allow, missing_ticket.rule))

        bracket_ticket = self.bash(
            replace(state, ticket="REQ[7]"),
            "git commit -m '[REQ[7]][feat]ambiguous ticket'",
            staged_files=exact,
        )
        self.assertEqual((False, "git_commit"), (
            bracket_ticket.allow, bracket_ticket.rule))

    def test_push_requires_exact_recorded_commit_manifest(self):
        state = self.manifest_state()

        exact = self.bash(
            state,
            "git push origin main",
            commit_files=("tests/a_test.cpp", "src/a.cpp"),
        )
        mismatch = self.bash(
            state,
            "git push origin main",
            commit_files=("src/a.cpp", "README.md"),
        )

        self.assertTrue(exact.allow)
        self.assertEqual((False, "git_publish"), (
            mismatch.allow, mismatch.rule))

    def test_allowed_earlier_git_action_does_not_skip_later_manifest_check(self):
        state = self.manifest_state()

        commit_after_add = self.bash(
            state,
            "git add src/a.cpp && "
            "git commit -m '[REQ-7][fix]提交部分文件'",
            staged_files=("src/a.cpp",),
        )
        push_after_commit = self.bash(
            state,
            "git commit -m '[REQ-7][fix]提交并推送' && git push origin main",
            staged_files=("src/a.cpp", "tests/a_test.cpp"),
            commit_files=("src/a.cpp",),
        )

        self.assertEqual((False, "git_commit"), (
            commit_after_add.allow, commit_after_add.rule))
        self.assertEqual((False, "git_publish"), (
            push_after_commit.allow, push_after_commit.rule))

    def test_startup_dirty_path_requires_explicit_manifest_adoption(self):
        unadopted = self.manifest_state(
            delivery_files=("src/existing.cpp",),
            initial_dirty=("src/existing.cpp",),
        )
        adopted = self.manifest_state(
            delivery_files=("src/existing.cpp",),
            initial_dirty=("src/existing.cpp",),
            decisions=(("delivery.adopted_dirty", "src/existing.cpp"),),
        )
        context_snapshot = self.manifest_state(
            delivery_files=("src/existing.cpp",),
            decisions=(("delivery.adopted_dirty", "src/existing.cpp"),),
        )

        blocked = self.bash(unadopted, "git add src/existing.cpp")
        allowed = self.bash(adopted, "git add src/existing.cpp")
        context_allowed = self.bash(
            context_snapshot,
            "git add src/existing.cpp",
            initial_dirty=(("src/existing.cpp", "startup-fingerprint"),),
        )

        self.assertEqual((False, "git_staging"), (
            blocked.allow, blocked.rule))
        self.assertTrue(allowed.allow)
        self.assertTrue(context_allowed.allow)

    def test_recursive_delete_blocks_outside_and_allows_task_owned_temp(self):
        state = self.manifest_state()
        facts = {"task_owned_temp_dir": "/repo/.tmp/task-7"}

        outside = self.bash(state, "rm -rf build", **facts)
        inside = self.bash(state, "rm -rf /repo/.tmp/task-7", **facts)
        displayed = self.bash(state, "echo rm -rf build", **facts)

        self.assertEqual((False, "filesystem"), (
            outside.allow, outside.rule))
        self.assertTrue(inside.allow)
        self.assertTrue(displayed.allow)

    def test_destructive_recognition_precedes_read_only_fail_open(self):
        state = self.manifest_state()

        destructive = self.bash(state, "git reset --hard HEAD")
        read_only = self.bash(state, "git status --definitely-not-an-option")

        self.assertEqual((False, "git_destructive"), (
            destructive.allow, destructive.rule))
        self.assertTrue(read_only.allow)

    def test_destructive_git_uses_actual_execution_positions(self):
        state = self.manifest_state()
        cases = (
            ("git reset --hard HEAD", False),
            ("git status && git reset --hard HEAD", False),
            ("sh -c 'git reset --hard HEAD'", False),
            ("sudo -u root git reset --hard HEAD", False),
            ("pwsh -NoProfile -Command git reset --hard HEAD", False),
            ("cmd.exe /d /c git reset --hard HEAD", False),
            ("echo git reset --hard HEAD", True),
            ("printf 'git reset --hard HEAD'", True),
            ("git status && echo git reset --hard HEAD", True),
            ("bash -n -c 'git reset --hard HEAD'", True),
            ("bash --help -c 'git reset --hard HEAD'", True),
        )
        for command, expected_allow in cases:
            with self.subTest(command=command):
                decision = self.bash(state, command)
                self.assertIs(expected_allow, decision.allow)
                if not expected_allow:
                    self.assertEqual("git_destructive", decision.rule)

    def test_actual_substitution_positions_drive_destructive_git_gate(self):
        state = self.manifest_state()
        cases = (
            ('echo "$(git reset --hard HEAD)"', False),
            ("echo `git clean -dfx`", False),
            ("echo '$(git reset --hard HEAD)'", True),
            ('echo "\\$(git reset --hard HEAD)"', True),
            ("bash -n -c 'echo \"$(git reset --hard HEAD)\"'", True),
        )
        for command, expected_allow in cases:
            with self.subTest(command=command):
                decision = self.bash(state, command)
                self.assertIs(expected_allow, decision.allow)
                if not expected_allow:
                    self.assertEqual("git_destructive", decision.rule)

    def test_high_confidence_wrappers_and_inline_aliases_are_opaque_delivery(self):
        state = self.manifest_state()
        cases = (
            (
                'python -c "import subprocess; '
                "subprocess.run(['git','add','src/a.cpp'])\"",
                "git_staging",
            ),
            (
                'python -c "import subprocess; '
                "subprocess.run(['git','commit','-m','wrapped'])\"",
                "git_commit",
            ),
            (
                'python -c "import os; '
                "os.system('git push origin HEAD')\"",
                "git_publish",
            ),
            (
                "git -c alias.ship='!git push origin HEAD' ship",
                "git_publish",
            ),
        )
        for command, expected_rule in cases:
            with self.subTest(command=command):
                decision = self.bash(
                    state,
                    command,
                    staged_files=("src/a.cpp", "tests/a_test.cpp"),
                    commit_files=("src/a.cpp", "tests/a_test.cpp"),
                )
                self.assertEqual(
                    (False, expected_rule),
                    (decision.allow, decision.rule),
                )

    def test_print_and_read_only_alias_text_remain_fail_open(self):
        state = self.manifest_state()
        commands = (
            'python -c "print(\'git push origin HEAD\')"',
            "git -c alias.lg='log --oneline' lg",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(self.bash(state, command).allow)


class PublicValueTests(unittest.TestCase):
    def test_guard_package_exports_the_immutable_public_values(self):
        from mae_flow_core import guard

        state = _state()
        context = guard.SafetyContext(state, "/repo")
        decision = guard.SafetyDecision(True)

        self.assertIsInstance(context, SafetyContext)
        self.assertIsInstance(decision, SafetyDecision)
        with self.assertRaises((AttributeError, TypeError)):
            decision.allow = False


if __name__ == "__main__":
    unittest.main()
