"""Typed pipeline evidence and the external-verification state transition.

Cloud does not compile or run tests locally. The host therefore reports facts
for three independent dimensions (COMPILE / UT / CODECHECK); the kernel binds
them to the current HEAD, persists the adjudication and alone decides whether
the workflow may finish or must enter a controlled repair round.
"""

import json

from .shared import os, time
from .wiring import api
from mae_flow_core.quality.external_verification import (
    PipelineDecision,
    adjudicate_pipeline,
    apply_pipeline_decision,
    record_git_push_receipt,
    required_dimensions,
)
from mae_flow_core.quality.external_repair import issue_repair_authorization
from mae_flow_core.workflow.execution_contract import continuous_review_enabled


_VALID_STATUS = ("success", "failed")


def adjudicate(facts, head):
    """Compatibility aggregate adjudicator for historical diagnostics only."""
    sha = str(facts.get("sha") or "")
    status = str(facts.get("status") or "")
    if not sha or status not in _VALID_STATUS:
        return "INVALID", "事实缺 sha,或 status 不是 success/failed"
    if sha != head:
        return (
            "STALE",
            "流水线绑的是 %s,当前 HEAD 是 %s——旧结果不背书新代码"
            % (sha[:12], head[:12]),
        )
    if status == "success":
        return "PASS", "流水线成功且绑定当前 HEAD"
    return "RED", "流水线失败(已绑定当前 HEAD),待修复或人工"


def _read_facts(path):
    try:
        with open(path, "r", encoding="utf-8") as stream:
            facts = json.load(stream)
    except Exception as exc:
        api.die("pipeline record 读不了事实文件 %s: %s" % (path, exc), 2)
    if not isinstance(facts, dict):
        api.die("pipeline record 的事实文件必须是 JSON 对象。", 2)
    return facts


def _legacy_record(st, facts, head, at):
    verdict, reason = adjudicate(facts, head)
    if verdict == "INVALID":
        api.die("pipeline record 拒绝登记:" + reason, 2)
    return {
        "step": st.get("current", ""),
        "at": at,
        "head": head,
        "sha": str(facts.get("sha")),
        "status": str(facts.get("status")),
        "verdict": verdict,
        "reason": reason,
        "source": str(facts.get("source") or ""),
        "url": str(facts.get("url") or ""),
        "legacy_aggregate": True,
    }


def _route_external_verification(flow, st, record):
    if st.get("current") != "external_verify":
        return
    verdict = record.get("verdict")
    if verdict == "PASS":
        if continuous_review_enabled(st):
            queued = api.complete_verified_feedback(
                st, str(record.get("sha") or record.get("head") or ""))
            target = "feedback_triage" if queued else "delivery_watch"
            api.advance(
                flow, st, "external_verify", {"next": target},
                "pipeline:pass", str(record.get("reason") or ""))
            return
        api.advance(
            flow, st, "external_verify", {"next": "end"},
            "pipeline:pass", str(record.get("reason") or ""))
    # Legacy RED stays at external_verify. Continuous-review Cloud turns the
    # platform failure into a typed feedback batch before starting its sole
    # repair writer, so the kernel never rolls over or re-enters init here.


def cmd_pipeline(flow, st, args):
    quality = st.setdefault("quality", {})
    if args.action == "show":
        record = quality.get("external_verification") or quality.get("pipeline")
        print(json.dumps(record, ensure_ascii=False) if record else "null")
        return

    facts = _read_facts(os.path.abspath(args.file))
    head = api.sh("git rev-parse --verify HEAD")
    at = time.strftime("%Y-%m-%d %H:%M:%S")
    required = required_dimensions(st)
    if required:
        decision = adjudicate_pipeline(facts, head, required)
        if decision.verdict == "INVALID":
            api.die("pipeline record 拒绝登记:" + decision.reason, 2)
        pushed, push_reason = record_git_push_receipt(
            st, facts, head=head, at=at)
        if decision.verdict == "PASS" and not pushed:
            decision = PipelineDecision(
                "INCOMPLETE", push_reason, decision.checks)
        external = apply_pipeline_decision(
            st, facts, decision, head=head, at=at)
        issue_repair_authorization(
            st, decision, head=head, at=at, dirty_paths=api._dirty_paths())
        record = {
            "step": st.get("current", ""),
            "at": at,
            "head": head,
            "sha": str(facts.get("sha") or ""),
            "status": str(facts.get("status") or ""),
            "verdict": decision.verdict,
            "reason": decision.reason,
            "source": str(facts.get("source") or ""),
            "url": str(facts.get("url") or ""),
            "required": list(required),
            "checks": decision.checks,
        }
        # Compatibility mirror for projections written before the typed model.
        quality["pipeline"] = record
        quality["external_verification"] = external
    else:
        record = _legacy_record(st, facts, head, at)
        quality["pipeline"] = record

    api.save_state(st)
    _route_external_verification(flow, st, record)
    print("[mae-flow] 流水线裁决 %s: %s" % (
        record["verdict"], record["reason"]))
    # Machine-readable final line. Cloud consumes this record and may not
    # independently reinterpret an aggregate platform status.
    print(json.dumps(record, ensure_ascii=False))
