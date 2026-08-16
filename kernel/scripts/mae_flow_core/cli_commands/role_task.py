"""Generate compact, whole-change role task cards."""

import hashlib
import os
import time

from mae_flow_core.foundation import source_paths
from mae_flow_core.application.quality.role_task_documents import (
    CODE_REVIEW_AXES,
    RoleTaskContext,
    build_role_task_document,
)
from mae_flow_core.application.quality.task_cards import (
    TaskCardStorePorts,
    store_task_card,
)
from mae_flow_core.orchestration.behavior_baseline import (
    load_relevant_domain_context,
)
from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.quality.role_tasks import role_allowed

from .shared import read_text, write_text
from .wiring import api


def _existing(paths):
    result = []
    for path in paths:
        value = str(path or "")
        if value and os.path.isfile(value):
            absolute = os.path.abspath(value)
            if absolute not in result:
                result.append(absolute)
    return tuple(result)


def _story_context(state, role, document="", axis=""):
    config = state.get("config") or {}
    ticket = str(config.get("单号", "") or "")
    package = ensure_work_package(os.getcwd(), ticket)
    if role == "code-review":
        # 两轴的权威输入刻意不同:需求符合性轴拿 Spec/Story/实施附录,
        # 工程质量轴一份都不给——同时拿着需求和规范的 Agent 会把注意力全给业务。
        if axis == "spec":
            return package, _existing(
                (package.spec, package.story, package.implementation))
        # standards 轴的权威输入=编码基准+卡内嵌增量本身。刻意不给 Spec/Story
        # 是设计,但不能渲染成"缺失"占位——那是故障态文案,曾让 reviewer
        # 正当地拒绝执行(NEEDS_INPUT),预检没做流程却照走(实战事故)。
        taste = _existing((os.path.join(
            ".mae-flow-work", "plugin-resources", "standards",
            "code-taste-v1.md"),))
        return package, taste + (
            "本卡「实际增量」小节内嵌的完整 diff——即待检视对象,无需另行获取",)

    survey = os.path.join(package.root, "survey.md")
    terms = []
    for path in (config.get("需求文档", ""), package.spec, package.grill):
        if path and os.path.isfile(path):
            terms.append(read_text(path, encoding="utf-8", errors="replace"))
    try:
        domain = load_relevant_domain_context(os.getcwd(), terms)
    except ValueError as exc:
        api.die("领域索引无效: %s。请先执行 domain-docs validate。" % exc, 2)
    domain_paths = [
        os.path.join(os.getcwd(), *item.path.split("/"))
        for item in domain.documents
    ]
    paths = [
        config.get("需求文档", ""), package.spec, package.grill,
        package.decisions, survey, os.path.join("docs", "specs", "index.md"),
        *domain_paths,
    ]
    if role == "story-generate":
        paths.extend((
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "STORY-TEMPLATE.md"),
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "IMPLEMENTATION-TEMPLATE.md"),
        ))
    elif role == "story-review":
        # 生成给了模板、检视不给,等于让它判"合不合规"却不告诉它规矩是什么。
        paths.extend((
            package.story, package.implementation,
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "STORY-TEMPLATE.md"),
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "IMPLEMENTATION-TEMPLATE.md"),
        ))
    if document:
        paths.append(document)
    return package, _existing(paths)


_MAX_UNTRACKED_FILES = 40


def _skip_in_card(path):
    """依赖目录与构建产物不是交付内容(内网实测:几千个 openspec 运行时文件
    被整段塞进任务卡,"### 未跟踪文件: node_modules/…" 无穷重复,Agent 当场卡死)。
    口径来自 foundation/source_paths,与面板、独立任务共用一份。
    另加流程自己的过程目录——它当然也不该被当成交付内容内嵌进卡片。"""
    return (source_paths.is_tool_managed_path(path)
            or source_paths.is_derived_path(path)
            or source_paths.is_artifact_path(path)
            or source_paths.is_flow_control_path(path))


def _untracked_patch():
    paths = api.argv_out([
        "git", "-c", "core.quotepath=false", "ls-files", "--others",
        "--exclude-standard",
    ]).splitlines()
    kept = [path for path in paths
            if path and os.path.isfile(path) and not _skip_in_card(path)]
    result = []
    for path in kept[:_MAX_UNTRACKED_FILES]:
        body = read_text(path, encoding="utf-8", errors="replace")
        result.extend(("### 未跟踪文件: " + path, body[:100000]))
    dropped = len(kept) - _MAX_UNTRACKED_FILES
    if dropped > 0:
        # 截断必须说出来:任务卡看起来完整、实则少了一半,比报错更难查。
        result.append(
            "### 还有 %d 个未跟踪文件未内嵌(超过 %d 个上限)。"
            "若它们属于本次交付,先 git add 让它们进入正式 diff;"
            "若不属于,加进 .gitignore。" % (dropped, _MAX_UNTRACKED_FILES))
    return "\n".join(result)


def _whole_change_diff(state):
    base = str(state.get("implementation_base_head", "") or "HEAD")
    patch = api.argv_out([
        "git", "-c", "core.quotepath=false", "diff", "--no-ext-diff",
        base,
    ])
    untracked = _untracked_patch()
    body = "\n".join(value for value in (patch, untracked) if value)
    if len(body) > 200000:
        body = body[:200000] + "\n（完整增量超过 200000 字符，已截断）"
    return body


def _emit_code_review_cards(state, step, ticket):
    """一次生成两张 CODE 预检卡:需求符合性 + 工程质量。

    两张卡由两个独立子 Agent 各执行一张,上下文互不污染。一个 Agent 同时拿着
    Spec、Story 和代码规范时,注意力会全部流向业务正确性,低级工程问题就漏了;
    反过来只盯风格的也发现不了需求做错。汇总由主 Agent 完成,不额外问用户。

    预检仍然只跑一轮:两张卡各派一次,不因结论是 ISSUE 就自动重来。
    """
    diff = _whole_change_diff(state)
    head = api.sh("git rev-parse --verify HEAD")
    launches = []
    records = {}
    for axis in CODE_REVIEW_AXES:
        package, context_paths = _story_context(
            state, "code-review", axis=axis)
        card = build_role_task_document(
            role="code-review",
            project_root=os.path.abspath(os.getcwd()),
            ticket=ticket,
            stage=axis,
            context=RoleTaskContext(context_paths=context_paths, diff=diff),
        )
        artifact = store_task_card(
            card,
            os.path.join(".mae-flow-work", "role-tasks"),
            "%s-code-review-%s.md" % (step, axis),
            TaskCardStorePorts(
                absolute=os.path.abspath,
                make_directory=lambda path: os.makedirs(path, exist_ok=True),
                write_text=lambda path, body: write_text(
                    path, body, encoding="utf-8"),
            ),
        )
        record = {
            "step": step,
            "path": artifact.path,
            "sha256": artifact.digest,
            "stage": axis,
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        state.setdefault("role_tasks", {})["code-review-" + axis] = record
        records[axis] = record
        launches.append((axis, artifact.path))
    # REVIEWER 记录是步骤级的:它是"预检之后源码有没有再变"的比对基线,也是风险确认
    # 绑定的任务卡。两张卡同一个 HEAD,这里固定取 standards 那张(而不是循环里最后
    # 写入的那张——那会让指向哪张卡取决于迭代顺序),另一张一并记在 axis_cards 里。
    # 证据仍是一次 REVIEWER 返回:拆两轴不把可选顾问步变成两条硬证据。
    state.setdefault("agent_tasks", {})["REVIEWER"] = {
        **records["standards"],
        "head": head,
        "precommit_review": True,
        "axis_cards": {
            axis: record["path"] for axis, record in records.items()},
        "source_snapshot": (
            api._source_snapshot_since(head, state, api.FLOW)
            if head else {}),
    }
    api.save_state(state)
    print("[mae-flow] CODE 预检任务卡已生成(两个独立视角，各派一次):")
    for axis, path in launches:
        print("- %s: %s" % (axis, path))
    for axis, path in launches:
        print('启动 craft-reviewer-agent(%s 视角)时只传：读取并严格执行任务卡 "%s"；'
              '返回可使用自然语言。' % (axis, path))


def cmd_role_task(_flow, state, args):
    role = str(args.role or "")
    step = str(state.get("current", "") or "")
    if not role_allowed(role, step):
        api.die("当前步骤 %s 不允许生成 %s 角色任务卡。" % (step or "(空)", role), 2)
    stage = str(getattr(args, "stage", "") or "")
    document_path = str(getattr(args, "document", "") or "")
    if role == "grill-critic" and (not stage or not document_path):
        api.die("grill-critic 必须同时指定 --stage prep|final 和 --document。", 2)

    ticket = str((state.get("config") or {}).get("单号", "") or "")
    if role == "code-review":
        _emit_code_review_cards(state, step, ticket)
        return
    package, context_paths = _story_context(state, role, document_path)
    card = build_role_task_document(
        role=role,
        project_root=os.path.abspath(os.getcwd()),
        ticket=ticket,
        stage=stage,
        context=RoleTaskContext(
            context_paths=context_paths,
            diff=_whole_change_diff(state) if role == "code-review" else "",
            write_output=package.story if role == "story-generate" else "",
            companion_output=(
                package.implementation if role == "story-generate" else ""),
            feedback=str(getattr(args, "feedback", "") or ""),
        ),
    )
    artifact = store_task_card(
        card,
        os.path.join(".mae-flow-work", "role-tasks"),
        "%s-%s%s.md" % (step, role, ("-" + stage) if stage else ""),
        TaskCardStorePorts(
            absolute=os.path.abspath,
            make_directory=lambda path: os.makedirs(path, exist_ok=True),
            write_text=lambda path, body: write_text(path, body, encoding="utf-8"),
        ),
    )
    record = {
        "step": step,
        "path": artifact.path,
        "sha256": artifact.digest,
        "stage": stage,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    state.setdefault("role_tasks", {})[role] = record
    kind = {
        "code-review": "REVIEWER",
        "story-generate": "STORY",
        "story-review": "REVIEWER",
        "grill-critic": "GRILL_" + stage.upper(),
    }[role]
    head = api.sh("git rev-parse --verify HEAD")
    state.setdefault("agent_tasks", {})[kind] = {
        **record,
        "head": head,
        "precommit_review": role == "code-review",
        "source_snapshot": (
            api._source_snapshot_since(head, state, api.FLOW)
            if role == "code-review" and head else {}),
    }
    api.save_state(state)
    agent = {
        "code-review": "craft-reviewer-agent",
        "story-generate": "story-generator-agent",
        "story-review": "craft-reviewer-agent",
        "grill-critic": "grill-critic-agent",
    }[role]
    print("[mae-flow] %s 角色任务卡已生成: %s" % (role, artifact.path))
    print('启动 %s 时只传：读取并严格执行任务卡 "%s"；返回可使用自然语言。'
          % (agent, artifact.path))
