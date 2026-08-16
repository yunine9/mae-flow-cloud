"""质量改动路由:一次 done 里该重新编译、该回流、还是该交给用户检视。

抽成独立模块只为让 done_status 保持在体量红线内;判定口径没有变化。
"""

from mae_flow_core.quality.attempts import attempt_count, begin_attempt

from .shared import time, workflow_transitions
from .wiring import api


# 检视之后的改动最多自动回流两次。无人值守时质量检视会被自动通过，回流又会重新
# 提交并前进，HEAD 每轮都变——没有上界的话，一个反复"再修一点"的夜跑能整夜打转。
LATE_REFLOW_LIMIT = 2


def _done_save_die(st, message):
    api.save_state(st)
    api.die(message, 2)

def _done_transition_to_recheck(flow, st, sid, target, changed, note, message,
                                clear_unlock=False):
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    st["history"].append({"step": sid, "result": "source-recheck:" + target,
                          "note": note + "、".join(changed[:10]), "at": now})
    st["current"] = target
    st.setdefault("step_heads", {})[target] = api.sh("git rev-parse --verify HEAD")
    if clear_unlock:
        st.pop("unlock", None)
    for kind in ("COMPILE", "CODECHECK", "UT"):
        (st.get("agent_tasks", {}) or {}).pop(kind, None)
    (st.get("quality", {}) or {}).pop("codecheck_scan", None)
    (st.get("quality", {}) or {}).pop("codecheck_verify", None)
    api.save_state(st)
    print(message)
    api.print_current(flow, st)
    return True


def _changed_file_paths(changed):
    suffix = "(未提交)"
    return list(dict.fromkeys(
        item[:-len(suffix)] if item.endswith(suffix) else item
        for item in (changed or ())
        if item
    ))


def _set_quality_review_context(st, step, changed, default_origin):
    origin = str(step.get("quality_review_origin") or default_origin)
    st["quality_review"] = workflow_transitions.quality_review_context(
        origin,
        _changed_file_paths(changed),
        api.sh("git rev-parse --verify HEAD"),
        resume=str(step.get("quality_review_resume") or ""),
        rework=str(step.get("quality_review_rework") or ""),
    )

def _done_source_change(flow, st, sid, step):
    source_next = step.get("source_change_next")
    if not source_next:
        return False
    _, migrate_err = api._ensure_step_entry_head(flow, st, sid)
    if migrate_err:
        _done_save_die(
            st, "无法恢复步骤入口 HEAD:" + migrate_err + "。拒绝猜测源码是否变化。")
    changed, why = api._source_changed_since(
        (st.get("step_heads", {}) or {}).get(sid, ""), st)
    if why:
        _done_save_die(st, "无法核对本步源码变化:" + why)
    if not changed:
        return False
    if step.get("source_change_defer_review"):
        # 质量链内的改动全部保持未提交，因此可以一路做完再统一检视一次。
        # 逐步各拉一轮人工检视，最坏要把用户叫四次，而且会让 CodeCheck 反复重跑。
        return _done_transition_to_recheck(
            flow, st, sid, source_next, changed, "本步产生待编译源码:",
            f"[mae-flow] {sid} 修改了源码，保持未提交并进入 {source_next} "
            "重新编译；本轮质量链的全部改动会在 UT 之后一次性交给用户检视。\n")
    _set_quality_review_context(st, step, changed, "codecheck-source")
    return _done_transition_to_recheck(
        flow, st, sid, source_next, changed, "本步产生待检视源码:",
        f"[mae-flow] {sid} 修改了源码，保持未提交并进入 {source_next} 验证；"
        "验证完成后统一交给用户检视。\n")

def _done_source_recheck(flow, st, sid, step):
    recheck = step.get("source_change_recheck")
    if not recheck:
        return False
    _, migrate_err = api._ensure_step_entry_head(flow, st, sid)
    if migrate_err:
        _done_save_die(st, "无法恢复 UT 步骤入口 HEAD:" + migrate_err
                       + "。为避免漏掉编译/CodeCheck，拒绝向后推进；请交维护人核对历史。")
    changed, why = api._business_source_changed_since_step(st, sid)
    if why:
        _done_save_die(st, "无法核对 UT 步骤内是否修改过被测源码:" + why
                       + "。为避免漏掉编译/CodeCheck，拒绝向后推进；请交维护人恢复步骤入口基点。")
    if not changed:
        return False
    ul = st.get("unlock") or {}
    if ul.get("scope") != "source" or ul.get("step") != sid:
        _done_save_die(st, "UT 步骤内检测到未经 unlock source 用户裁决的被测源码变更: "
                       + "、".join(changed[:5]) + ("…" if len(changed) > 5 else "")
                       + "。这是越权修改，不能靠补跑验证洗白；先呈报变更和 UT 自查结论，由用户裁决后再处理。")
    _set_quality_review_context(st, step, changed, "ut-source")
    return _done_transition_to_recheck(
        flow, st, sid, recheck, changed, "UT 裁决后产生待检视源码:",
        f"[mae-flow] UT 阶段经用户裁决修改了被测源码，自动回流到 {recheck}。"
        "先编译、再统一检视提交，之后从 CodeCheck 恢复；不会重跑 Ponytail。\n",
        clear_unlock=True)


def _done_late_source_change(flow, st, sid, step):
    """检视之后出现的源码改动必须回流，不能被静默丢弃。

    统一检视之后的三步(规格符合性、领域归档、交付检视)本来就不该产生代码改动，
    但也没有任何证据在查。这类改动既进不了交付提交(清单必须精确等于用户确认过
    的文件)，也没人告诉任何人它被丢了——比拦住更糟。这里让它强制回流:重新编译、
    重新检视，并从 CodeCheck 重跑，因为这部分代码从未经过质量链。
    """
    target = step.get("late_source_change_next")
    if not target:
        return False
    changed = api._blocking_dirty_source_paths(st, flow)
    if not changed:
        return False
    attempt = begin_attempt(
        st, "late-source-reflow",
        "reflow-%d" % (attempt_count(st, "late-source-reflow") + 1),
        limit=LATE_REFLOW_LIMIT)
    if attempt.exhausted:
        _done_save_die(
            st,
            "检视之后已经自动回流 %d 次，这一次不再自动回流:"
            "反复在收尾阶段改代码说明前面的环节没有真正收敛。当前未提交改动: %s。"
            "两条出路——确认这次改动不该要，用 git checkout -- <文件> 撤销后重新 done;"
            "确实必须改，把改动和原因交给用户裁决(无人值守时用 current 输出的 "
            "moonlight defer 登记遗留，或 moonlight blocked 留痕后停止)。"
            % (LATE_REFLOW_LIMIT, "、".join(changed[:5])
               + ("…" if len(changed) > 5 else "")))
    _set_quality_review_context(st, step, changed, "ut-source")
    return _done_transition_to_recheck(
        flow, st, sid, target, changed, "统一检视之后新增的待检视改动:",
        f"[mae-flow] {sid} 之后出现了未提交的代码改动，它进不了本次交付提交，"
        f"也不能悄悄丢掉。已回流到 {target}：重新编译、重新检视，"
        "并从 CodeCheck 重跑质量链。\n")


def _done_test_change_review(flow, st, sid, step):
    """质量链末尾的唯一一次人工检视。

    Ponytail 的删码、CodeCheck 的修复和 UT 的测试改动全都保持未提交，所以到这里
    工作区里就是本轮质量链的完整增量——一次看完整 diff 既省人工轮次，也比分三次
    看增量更容易判断。UT 步自己经 unlock 改的被测源码不走这条:那部分代码没过
    CodeCheck，由 _done_source_recheck 单独回流并重跑 CodeCheck。
    """
    origin = step.get("test_change_review_origin")
    if not origin:
        return False
    changed = api._blocking_dirty_source_paths(st, flow)
    if not changed:
        return False
    _set_quality_review_context(st, {
        "quality_review_origin": origin,
        "quality_review_resume": step.get("test_change_review_resume", ""),
        "quality_review_rework": step.get("test_change_review_rework", ""),
    }, changed, "ut-test")
    return _done_transition_to_recheck(
        flow, st, sid, "quality_review", changed,
        "本轮质量链产生待检视改动:",
        "[mae-flow] 质量链已完成并留下未提交改动，进入本轮唯一一次统一用户检视；"
        "禁止在检视前提交。\n")


def _done_route_quality_changes(flow, st, sid, step):
    if _done_source_change(flow, st, sid, step):
        return True
    if _done_source_recheck(flow, st, sid, step):
        return True
    if _done_late_source_change(flow, st, sid, step):
        return True
    return _done_test_change_review(flow, st, sid, step)
