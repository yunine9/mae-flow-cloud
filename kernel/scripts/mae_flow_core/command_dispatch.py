"""Side-effect-free routing contracts for Mae-Flow CLI commands."""

from dataclasses import dataclass
from types import MappingProxyType


@dataclass(frozen=True)
class CommandRoute:
    handler: str
    arguments: tuple


ACTION_ROUTES = MappingProxyType({
    "start": CommandRoute(
        "cmd_action_start", ("flow", "state", "args")),
    "confirm-scope": CommandRoute(
        "cmd_action_confirm_scope", ("flow", "args")),
    "status": CommandRoute("cmd_action_status", ()),
    "critic": CommandRoute("cmd_action_critic", ("args",)),
    "finish": CommandRoute("cmd_action_finish", ("args",)),
    "cancel": CommandRoute("cmd_action_cancel", ()),
})


FLOW_ROUTES = MappingProxyType({
    "exit": CommandRoute("cmd_exit", ("flow", "state", "args")),
    "messages": CommandRoute("cmd_messages", ("state", "args")),
    "config-review": CommandRoute(
        "cmd_config_review", ("flow", "state", "args")),
    "requirement-record": CommandRoute(
        "cmd_requirement_record", ("state", "args")),
    "moonlight": CommandRoute(
        "cmd_moonlight", ("flow", "state", "args")),
    "current": CommandRoute("print_current", ("flow", "state")),
    "agent-task": CommandRoute(
        "cmd_agent_task", ("flow", "state", "args")),
    "role-task": CommandRoute(
        "cmd_role_task", ("flow", "state", "args")),
    "codecheck-scan": CommandRoute(
        "cmd_codecheck_scan", ("flow", "state", "args")),
    "codecheck-scope": CommandRoute(
        "cmd_codecheck_scope", ("flow", "state", "args")),
    "codecheck-record": CommandRoute(
        "cmd_codecheck_record", ("flow", "state", "args")),
    "pipeline": CommandRoute(
        "cmd_pipeline", ("flow", "state", "args")),
    "approve-exemption": CommandRoute(
        "cmd_approve_exemption", ("flow", "state", "args")),
    "accept-risk": CommandRoute(
        "cmd_accept_risk", ("flow", "state", "args")),
    "allow": CommandRoute("cmd_allow", ("flow", "state", "args")),
    "spec": CommandRoute("cmd_spec", ("flow", "state", "args")),
    "done": CommandRoute("cmd_done", ("flow", "state", "args")),
    "skip": CommandRoute("cmd_skip", ("flow", "state", "args")),
    "status": CommandRoute("cmd_status", ("flow", "state", "args")),
    "goto": CommandRoute("cmd_goto", ("flow", "state", "args")),
    "unlock": CommandRoute("cmd_unlock", ("flow", "state", "args")),
    "reloaded": CommandRoute(
        "cmd_reloaded", ("flow", "state", "args")),
    "doctor": CommandRoute("cmd_doctor", ("flow", "state", "args")),
    "report": CommandRoute("cmd_report", ("flow", "state", "args")),
})


def action_route(action):
    return ACTION_ROUTES.get(action)


def flow_route(command):
    return FLOW_ROUTES.get(command)


def invoke(route, handlers, **context):
    handler = handlers.get(route.handler)
    if not callable(handler):
        raise RuntimeError(
            "unknown Mae-Flow command handler: %s" % route.handler)
    return handler(*(context[name] for name in route.arguments))
