"""Read-only CLI projection for the current phase execution plan."""

from .shared import json, sys
from mae_flow_core.workflow.execution_plan import (
    build_execution_plan,
    load_execution_profile,
)


def cmd_execution_plan(flow, state, args):
    profile, warning = load_execution_profile()
    plan = build_execution_plan(flow, state, profile=profile)
    if warning:
        print(warning, file=sys.stderr)
    if getattr(args, "json", False):
        print(json.dumps(plan, ensure_ascii=False, sort_keys=True))
        return
    strategy = plan["strategy"]
    step = plan["step"]
    print("═══ 本阶段执行方案: %s ═══" % strategy["title"])
    print("当前阶段: %s / %s" % (step["phase"], step["title"]))
    print(strategy["summary"])
    print("选择原因: " + strategy["selection_reason"])
    print("默认会做:")
    for activity in plan["activities"]:
        print("- %s: %s" % (activity["title"], activity["description"]))
    print("知识装载: " + plan["knowledge"]["explanation"])
    for layer in plan["customization"].get("layers") or ():
        print("%s: %s" % (layer["title"], layer["instructions"]))
    print("不可调整: " + "、".join(plan["customization"]["locked"]))
