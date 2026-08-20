"""Pure task-card document and state-record contracts."""

from dataclasses import dataclass, field
import hashlib


EXPECTED_STEPS = {
    "COMPILE": {
        "build",
        "build_rework",
        "verify_recompile",
        "verify_post_ponytail_compile",
        "verify_codecheck_compile",
        "quality_recompile",
    },
    "CODECHECK": {
        "verify_codecheck",
        "tw_codecheck",
        "rf_codecheck",
        "rf_verify",
    },
    "UT": {
        "verify_ut",
        "rf_ut",
        "tw_ut",
        "rf_verify",
    },
}


def task_allowed(kind, step):
    return step in EXPECTED_STEPS.get(
        str(kind).upper(),
        set(),
    )


@dataclass
class TaskCardDocument:
    lines: list = field(default_factory=list)

    def __iter__(self):
        return iter(self.lines)

    def __iadd__(self, lines):
        self.extend(lines)
        return self

    def append(self, line):
        self.lines.append(line)

    def extend(self, lines):
        self.lines.extend(lines)

    def body(self):
        return "\n".join(self.lines).rstrip() + "\n"

    def digest(self):
        return hashlib.sha256(
            self.body().encode("utf-8")
        ).hexdigest()

    def sealed_body(self):
        return self.body()


def task_record(
    *,
    step,
    path,
    head,
    scope,
    precommit_review,
    initial_compile_net,
    source_snapshot,
    worktree_snapshot,
    worktree_snapshot_valid,
    allowed_files,
    task_files,
    execution_roots,
    lightcheck,
    ut_targets,
    unchanged_initial_dirty,
    at,
    ut_phase="",
    agent_write_receipts=None,
    ut_artifact_contract=None,
):
    record = {
        "step": step,
        "path": path,
        "head": head,
        "scope": scope,
        "precommit_review": precommit_review,
        "initial_compile_net": initial_compile_net,
        "source_snapshot": dict(source_snapshot),
        "worktree_snapshot": dict(worktree_snapshot),
        "worktree_snapshot_valid": bool(worktree_snapshot_valid),
        "allowed_files": list(allowed_files),
        "task_files": list(task_files),
        "execution_roots": list(execution_roots),
        "lightcheck": dict(lightcheck),
        "ut_targets": {
            key: [dict(item) for item in value]
            for key, value in ut_targets.items()
        },
        "unchanged_initial_dirty": list(
            unchanged_initial_dirty),
        "at": at,
        "ut_phase": str(ut_phase or ""),
        "agent_write_receipts": dict(agent_write_receipts or {}),
        "ut_artifact_contract": dict(ut_artifact_contract or {}),
    }
    return record
