"""SubagentStop records lifecycle metadata without interpreting return prose."""

from dataclasses import dataclass
import json
from typing import Callable

from mae_flow_core.application.hooks.models import HookResponse


@dataclass(frozen=True)
class AgentCompletionPorts:
    state_path: str
    latest_started: Callable
    record_finished: Callable
    record_execution: Callable
    scope_violation: Callable
    log: Callable


def _lifecycle(payload):
    raw = str(
        payload.get("lifecycle")
        or payload.get("status")
        or payload.get("stop_reason")
        or "returned"
    ).lower()
    if "timeout" in raw or "timed_out" in raw:
        return "timeout"
    if "interrupt" in raw or "cancel" in raw or "abort" in raw:
        return "interrupted"
    return "returned"


def _invocation_id(payload):
    for key in ("invocation_id", "agent_id", "tool_use_id", "task_id"):
        value = payload.get(key)
        if value:
            return str(value)
    return ""


def _detail(payload):
    value = payload.get(
        "assistant_text",
        payload.get("last_assistant_message", payload.get("detail", "")),
    )
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False) if value else ""
    except Exception:
        return str(value or "")


def handle_agent_completion(payload, ports):
    """Record lifecycle metadata and enforce only observable write scope."""
    supplied_id = _invocation_id(payload)
    invocation_id = ports.latest_started(
        invocation_id=supplied_id, payload=payload)
    if not invocation_id:
        ports.log("subagentstop: 未找到对应 started 观察，按 fail-open 跳过")
        return HookResponse()
    if supplied_id and supplied_id != invocation_id:
        ports.log("subagentstop id reconcile: %s -> %s" % (
            supplied_id, invocation_id))
    lifecycle = _lifecycle(payload)
    try:
        ports.record_finished(
            ports.state_path, invocation_id, lifecycle, _detail(payload))
        ports.record_execution(payload, invocation_id, lifecycle)
        ports.log("subagentstop lifecycle: %s/%s" % (
            invocation_id, lifecycle))
    except Exception as exc:
        ports.log("subagentstop observation EXC(fail-open): %s" % exc)
    try:
        reason = ports.scope_violation(payload, invocation_id)
        if reason:
            return HookResponse(exit_code=2, stderr=reason + "\n")
    except Exception as exc:
        ports.log("subagentstop scope EXC(fail-open): %s" % exc)
    return HookResponse()
