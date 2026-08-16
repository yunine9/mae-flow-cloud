"""Pure transition policy for Mae-Flow workflow definitions."""


_QUALITY_REVIEW_ROUTES = {
    "ponytail-source": ("verify_codecheck", "quality_recompile"),
    "codecheck-source": ("verify_codecheck", "quality_recompile"),
    "ut-source": ("verify_codecheck", "quality_recompile"),
    "ut-test": ("verify_spec", "verify_ut"),
}


def quality_review_context(
        origin, changed_files, entered_head, resume="", rework=""):
    """Create the semantic quality-review cursor without content digests."""
    if origin not in _QUALITY_REVIEW_ROUTES:
        raise ValueError("unknown quality review origin: %s" % origin)
    default_resume, default_rework = _QUALITY_REVIEW_ROUTES[origin]
    resume = str(resume or default_resume)
    rework = str(rework or default_rework)
    files = tuple(dict.fromkeys(
        str(path) for path in changed_files if str(path).strip()))
    if not files:
        raise ValueError("quality review requires changed files")
    return {
        "origin": origin,
        "resume": resume,
        "rework": rework,
        "changed_files": list(files),
        "entered_head": str(entered_head or ""),
    }


def _state_value(state, dotted_path):
    value = state
    for part in str(dotted_path or "").split("."):
        if not part or not isinstance(value, dict):
            return None
        value = value.get(part)
    return value if isinstance(value, str) and value else None


def transition_targets(step):
    targets = []

    def append(target, declared=False):
        if (declared or target is not None) and target not in targets:
            targets.append(target)

    nxt = step.get("next")
    if isinstance(nxt, dict):
        for target in nxt.values():
            append(target, declared=True)
    elif nxt:
        append(nxt)
    # 每一种"改了源码就换步"的声明都是真实转移边。漏登记的后果不是运行期出错
    # (done 直接改 current)，而是图校验、活性红线和环分析全都看不见那条边。
    for key in ("source_change_next", "source_change_recheck",
                "late_source_change_next"):
        if key in step:
            append(step.get(key), declared=True)
    dynamic = step.get("dynamic_next")
    if isinstance(dynamic, (list, tuple)):
        for target in dynamic:
            append(target, declared=True)
    elif "dynamic_next" in step:
        append(dynamic, declared=True)
    return tuple(targets)


def next_step(step, state, choice_override=""):
    if step.get("next_from_state"):
        return _state_value(state, step["next_from_state"])
    nxt = step.get("next")
    try:
        if step.get("next_by"):
            # 选择项缺失时走明写的默认分支。没有兜底的话,这一步就"缺少可解析
            # 的下一步"——done 拒绝推进,current 又不给恢复办法,流程当场活锁
            # (实测:月光宝盒跑到 build,code_reviewer 从未被写进配置,卡死 38 轮)。
            picked = state.get("choices", {}).get(step["next_by"])
            if picked is None and step.get("next_default"):
                picked = step["next_default"]
            return nxt[picked]
        if isinstance(nxt, dict):
            choice = (
                choice_override
                or state.get("choices", {}).get(step.get("choice_key"))
            )
            return nxt[choice]
    except Exception:
        return None
    return nxt


def resolved_next(flow, state, step_id):
    step = flow.get("steps", {}).get(step_id, {})
    return next_step(step, state)


def workflow_chain(flow, workflow):
    """某条交付方式的完整步骤链(展示用:可选环节一律取"做"的那支)。

    坑:分叉不只按 workflow 分。build 是按 code_reviewer 分叉的
    ({disabled,enabled}),原来一律拿 workflow 去查那张表,查不到就 None,
    链条在「编码实现」处直接断——四条道的验证与交付整段(build_review 到
    push/end)从来没被打印过,而 `steps` 命令存在的理由正是"选档前看得见
    全貌"。非 workflow 的分叉按 next_default 取,与"取完整形态"一致。
    """
    chain = []
    step_id = flow["start"]
    seen = set()
    while step_id and step_id not in seen:
        seen.add(step_id)
        chain.append(step_id)
        step = flow["steps"][step_id]
        nxt = step.get("next")
        if isinstance(nxt, dict):
            key = step.get("next_by")
            if key == "workflow":
                nxt = nxt.get(workflow)
            elif key:
                nxt = nxt.get(step.get("next_default"))
            else:
                nxt = nxt.get("yes") or next(iter(nxt.values()))
        step_id = nxt
    return chain


def workflow_cost(flow, workflow):
    """选交付方式时该看见的代价:多少步、要用户拍板几次、哪些环节与别条路不同。

    数字一律从 flow 现算,不许在任何地方手写一份——流程一改,手写的说明
    就开始骗人,而这段话恰恰是用户据以选档的唯一依据。

    `unique` 报的是"不是四条路都有的环节",不是"比 full 少了什么":后者
    会把 tweak 的 `小改—规范检查/单元测试/对照需求检查` 算成"省掉了验证
    1/4~4/4",等于告诉用户选轻的就免检——四条道的验证一步都不能免,轻的
    只是换成了更小的形态。这个误导比不显示还糟。
    """
    chains = {wf: workflow_chain(flow, wf)
              for wf in ("full", "hotfix", "tweak", "review")}
    chain = chains.get(workflow) or workflow_chain(flow, workflow)
    common = set(chains["full"])
    for other in chains.values():
        common &= set(other)
    steps = flow["steps"]
    acks = [sid for sid in chain if steps[sid].get("user_ack")]
    unique = [steps[sid].get("title", sid)
              for sid in chain if sid not in common]
    return {"steps": len(chain), "acks": len(acks), "unique": unique}
