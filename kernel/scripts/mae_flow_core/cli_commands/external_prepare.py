"""Prepare host-owned actions and external quality obligations before done."""

from mae_flow_core import host_env
from mae_flow_core.quality.external_verification import register_pending
from mae_flow_core.quality.ut_artifacts import (
    merge_receipts,
    receipt_has_artifact,
)
from mae_flow_core.quality.ut_batches import advance_ut_session
from mae_flow_core.workflow.quality_executions import (
    quality_input_snapshot,
    ut_artifact_receipts,
)

from .shared import STATE_PATH, time
from .wiring import api


def _prepare_host_push(state, step_id, head, now):
    if step_id != "push" or host_env.git_push_runs_locally(state):
        return
    branch = api.sh("git branch --show-current")
    state.setdefault("host_actions", {})["git_push"] = {
        "status": "pending",
        "head": head,
        "branch": branch,
        "at": now,
    }


def _current_ut_artifacts(state, step_id):
    task = (state.get("agent_tasks") or {}).get("UT") or {}
    if not task or task.get("step") != step_id:
        return ()
    snapshot = quality_input_snapshot(state, "UT", step_id)
    return ut_artifact_receipts(STATE_PATH, step_id, snapshot)


def _merge_session_artifacts(session, current):
    rows = [dict(item) for item in session.get("artifact_receipts") or ()
            if isinstance(item, dict)]
    known = {str(item.get("invocation_id", "")) for item in rows}
    for item in current:
        invocation = str(item.get("invocation_id", ""))
        if invocation and invocation not in known:
            rows.append(dict(item))
            known.add(invocation)
    session["artifact_receipts"] = rows
    session["ut_artifact"] = merge_receipts(rows)
    return receipt_has_artifact(session["ut_artifact"])


def _prepare_external_ut(state, step_id, head, now):
    files, error = api._biz_changed_files(state)
    if error:
        return
    session = dict(state.get("ut_session") or {})
    has_receipt = _merge_session_artifacts(
        session, _current_ut_artifacts(state, step_id))
    if files:
        prior_returned, _why = api.ev_agent_ran({"agent": "UT"}, state)
        task = (state.get("agent_tasks") or {}).get("UT") or {}
        baseline_receipts = task.get("agent_write_receipts") or {}
        current_receipts = api._agent_written_receipts()
        written_tests = {
            path for path, receipt in current_receipts.items()
            if receipt != baseline_receipts.get(path)
            and api._is_test_file(path, state)
        }
        written_tests.update(session.get("accumulated_test_files") or ())
        artifact = session.get("ut_artifact") or {}
        written_tests.update(artifact.get("added_test_paths") or ())
        written_tests.update(artifact.get("modified_test_paths") or ())
        if session.get("phase") == "final":
            session.update({"phase": "external", "complete": True})
        elif session.get("batches"):
            advanced = advance_ut_session(
                session, session.get("batches") or (), prior_returned)
            session.update(advanced.record)
            if session.get("phase") == "final":
                session.update({"phase": "external", "complete": True})
        session["written_test_files"] = sorted(written_tests)
        artifact_present = has_receipt or bool(written_tests)
        if session.get("phase") == "external" and not artifact_present:
            session.update({"complete": False, "output_missing": True})
        elif artifact_present:
            session.pop("output_missing", None)
        state["ut_session"] = session
    if not files or (
            session.get("phase") == "external"
            and session.get("complete")):
        register_pending(
            state, "UT", step=step_id, head=head, at=now,
            reason="UT 编写/既有测试审计已完成；运行与统计等待权威流水线")


def _done_prepare_external_verification(step, state, step_id):
    """Register pending facts only; never manufacture PASS."""
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    head = api.sh("git rev-parse --verify HEAD")
    _prepare_host_push(state, step_id, head, now)
    evidence = list(step.get("evidence") or ())
    compile_required = any(
        spec.get("agent") == "COMPILE"
        and spec.get("type") in (
            "agent_ran", "agent_or_no_source", "review_agent_or_no_code")
        for spec in evidence)
    if compile_required and not host_env.build_runs_locally(state):
        register_pending(
            state, "COMPILE", step=step_id, head=head, at=now,
            reason="本机无构建链；等待权威流水线编译")
    codecheck_required = any(
        spec.get("type") == "review_codecheck" for spec in evidence)
    if codecheck_required and not host_env.codecheck_runs_locally(state):
        register_pending(
            state, "CODECHECK", step=step_id, head=head, at=now,
            reason="本机不运行 CodeCheck；等待权威流水线静态检查")
    ut_required = any(
        spec.get("type") == "ut_session_complete" for spec in evidence)
    if ut_required and not host_env.unit_tests_run_locally(state):
        _prepare_external_ut(state, step_id, head, now)
