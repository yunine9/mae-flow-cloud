"""Local-only Spec command and validation."""

from .shared import atomic_write_text, os, read_text
from .wiring import api
from mae_flow_core.orchestration.work_package import ensure_work_package


_HEADINGS = (
    "## 范围",
    "## 可观察行为",
    "## 验收条件",
    "## 不在范围",
    "## Grill 决策",
)
_TEMPLATE = """# 需求规格

## 范围

## 可观察行为

## 验收条件

## 不在范围

## Grill 决策
"""


def local_spec_errors(content):
    if not isinstance(content, str):
        return _HEADINGS
    errors = []
    for index, heading in enumerate(_HEADINGS):
        start = content.find(heading)
        if start < 0:
            errors.append(heading)
            continue
        body_start = start + len(heading)
        later = [
            content.find(other, body_start)
            for other in _HEADINGS[index + 1:]
        ]
        ends = [position for position in later if position >= 0]
        body = content[body_start:min(ends) if ends else len(content)]
        if not body.strip():
            errors.append(heading)
    return tuple(errors)


def initialize_local_spec(project_root, ticket):
    package = ensure_work_package(project_root, ticket)
    if not os.path.exists(package.spec):
        atomic_write_text(package.spec, _TEMPLATE)
    return package.spec


def _ticket(state):
    return str(((state or {}).get("config") or {}).get("单号", "")).strip()


def cmd_local_spec(state, args):
    ticket = _ticket(state)
    if not ticket:
        api.die("当前流程没有有效单号，不能定位本地 Spec。", 2)
    path = initialize_local_spec(os.getcwd(), ticket)
    if args.local_spec_action == "init":
        print("[mae-flow] 本地 Spec: " + path)
        return path
    content = read_text(path, encoding="utf-8")
    if args.local_spec_action == "show":
        print("[mae-flow] 本地 Spec: " + path)
        print(content, end="" if content.endswith("\n") else "\n")
        return path
    errors = local_spec_errors(content)
    if errors:
        api.die("本地 Spec 缺少有效章节内容: " + "、".join(errors), 2)
    print("[mae-flow] 本地 Spec 校验通过: " + path)
    return path
