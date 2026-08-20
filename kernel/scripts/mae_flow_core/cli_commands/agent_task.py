"""CLI responsibilities extracted from the historical entrypoint."""

from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.quality.ut_batches import (
    advance_ut_session,
    accumulated_ut_paths,
    plan_ut_batches,
)
from mae_flow_core.orchestration.behavior_baseline import (
    load_relevant_domain_context,
)
from mae_flow_core.quality.ut_artifacts import task_contract as ut_artifact_contract

from .shared import (
    BUILD_DESCRIPTOR_EXTS, SOURCE_FILENAMES, STATE_PATH, append_codecheck_event,
    codecheck_log_path, globmod, os, quality_task_card_documents,
    quality_task_card_use_cases, quality_task_cards, read_text, time, write_text,
    sys,
)
from .wiring import api
from mae_flow_core import host_env

def _task_scope(st, diff_override=""):
    if diff_override:
        diff, err = diff_override, ""
    else:
        diff, err = api._scope_diff(st)
        if err:
            return "", [], err
    out = api.argv_out([
        "git", "-c", "core.quotepath=false", "diff", "--name-status", diff])
    return diff, [x for x in out.splitlines() if x.strip()], ""

def _classify_task_files_from_runtime(files, st):
    """把子任务范围拆成业务源码、测试、构建三组；文档根本不应传进来。"""
    return quality_task_card_use_cases.task_file_groups(
        files,
        is_build=api._is_build_path,
        is_test=lambda path: api._is_test_file(path, st),
    ).as_legacy()

def _resolve_task_roots_from_runtime(files):
    """生成去重的模块执行目录和依据，供任务卡阻止根目录意外全量构建。"""
    plan = quality_task_card_use_cases.execution_roots(
        files,
        quality_task_card_use_cases.ExecutionRootPorts(
            repository=os.path.abspath(os.getcwd()),
            absolute=os.path.abspath,
            is_directory=os.path.isdir,
            list_directory=os.listdir,
            is_file=os.path.isfile,
            is_build_path=api._is_build_path,
            relative=os.path.relpath,
            dirname=os.path.dirname,
            join=os.path.join,
            separator=os.sep,
            source_filenames=tuple(
                str(name).lower()
                for name in SOURCE_FILENAMES),
            descriptor_suffixes=tuple(BUILD_DESCRIPTOR_EXTS),
        ),
    )
    return list(plan.roots), list(plan.unresolved)

def _resolve_requirement_sources_from_runtime(st):
    config = st.get("config", {})
    ticket = str(config.get("单号", "") or "")
    local_sources = ()
    if ticket:
        package = ensure_work_package(os.getcwd(), ticket)
        local_sources = (
            package.spec, package.grill, package.story,
            package.implementation, package.decisions)
        terms = []
        for path in (config.get("需求文档", ""), *local_sources):
            if path and os.path.isfile(path):
                terms.append(read_text(path, encoding="utf-8", errors="replace"))
        try:
            domain = load_relevant_domain_context(os.getcwd(), terms)
        except ValueError as exc:
            api.die(
                "领域索引无效: %s。修复后先执行 domain-docs validate，"
                "通过后原样重试 agent-task。"
                % exc,
                2,
            )
        local_sources += tuple(
            os.path.join(os.getcwd(), *document.path.split("/"))
            for document in domain.documents)
        index = os.path.join(os.getcwd(), "docs", "specs", "index.md")
        if os.path.isfile(index):
            local_sources += (index,)
    return list(quality_task_card_use_cases.requirement_sources(
        config,
        exists=os.path.exists,
        absolute=os.path.abspath,
        glob_paths=globmod.glob,
        local_sources=local_sources,
    ))


def _incremental_ut_sources(st, final=False):
    if final:
        return []
    ticket = str((st.get("config") or {}).get("单号", "") or "")
    if not ticket:
        return []
    package = ensure_work_package(os.getcwd(), ticket)
    return [path for path in (package.spec, package.story)
            if os.path.isfile(path)]


def _compile_worktree_snapshot(kind, head):
    if kind != "COMPILE":
        return {}, False
    try:
        return api._worktree_snapshot_since(head), True
    except Exception as exc:
        print(
            "[mae-flow] COMPILE provenance baseline unavailable; "
            "issuing task with invalid baseline: %s" % exc,
            file=sys.stderr,
        )
        return {}, False


def _prepare_ut_session(
        st, sid, args, groups, task_head, accumulated, prior_returned):
    targets, error = api._changed_hunk_targets(st, groups["business"])
    if error:
        api.die("无法计算 UT 函数级范围：" + error
                + "；请先执行 doctor 检查 Git 范围，再重试 agent-task ut。", 2)
    target_ids = []
    for path in groups["business"]:
        rows = targets.get(path.replace("\\", "/"), [])
        if not rows:
            target_ids.append(path + " | 本次删除/迁移行为")
        target_ids.extend(
            "%s:%s-%s | %s" % (
                path, row.get("start", "?"), row.get("end", "?"),
                row.get("context") or "按变更行定位函数")
            for row in rows)
    batches = plan_ut_batches(target_ids).batches
    previous = st.get("ut_session") or {}
    session = previous if previous.get("head") == task_head else {}
    advanced = advance_ut_session(session, batches, prior_returned)
    if advanced.complete:
        api.die("本轮自适应批次和最终全量 UT 已完成；不要重复派发，直接 done。", 2)
    if not args.scope:
        args.scope = (
            "单批完成并全量收口"
            if len(batches) <= 1 else
            "按任务卡自适应批次执行；上下文接近上限时自然语言收尾，"
            "由主会话用下一批范围启动新实例")
    # 记同一批签发了几次:没前进就一直加。它是判断"卡在取不到的证据上"的
    # 唯一客观依据——不然只能靠人数轮次。
    same_batch = (
        previous.get("head") == task_head
        and previous.get("active_batch") == advanced.record.get("active_batch")
        and previous.get("phase") == advanced.record.get("phase"))
    st["ut_session"] = dict(advanced.record, **{
        "step": sid,
        "head": task_head,
        "issued": (int(previous.get("issued", 0) or 0) + 1
                   if same_batch else 1),
        "accumulated_test_files": list(dict.fromkeys(
            list(previous.get("accumulated_test_files", ()))
            + list(accumulated))),
        "last_scope": args.scope,
    })
    return targets, advanced.task_batches, advanced.record["phase"]


def _prepare_ut_dirty(st, sid, dirty_source):
    session = st.get("ut_session") or {}
    previous = (st.get("agent_tasks", {}) or {}).get("UT", {})
    same_step = session.get("step") == sid and previous.get("step") == sid
    prior_returned = False
    if same_step:
        prior_returned, _why = api.ev_agent_ran({"agent": "UT"}, st)
    current_receipts = api._agent_written_receipts()
    baseline_receipts = previous.get("agent_write_receipts") or {}
    owned = {
        path for path, receipt in current_receipts.items()
        if receipt != baseline_receipts.get(path)
    }
    review = st.get("quality_review") or {}
    review_authorized = (
        review.get("origin") == "ut-test" and review.get("rework") == sid)
    if review_authorized:
        owned.update(review.get("changed_files") or ())
    accumulated, blocked = accumulated_ut_paths(
        dirty_source, same_step=same_step, prior_returned=prior_returned,
        owned_paths=owned, review_authorized=review_authorized,
        is_test=lambda path: api._is_test_file(path, st),
        is_build=api._is_build_path)
    return accumulated, blocked, prior_returned


def _store_agent_task(flow, st, args, context):
    kind = context["kind"]
    sid = context["sid"]
    from mae_flow_core.workflow.quality_executions import (
        invalidate_quality_executions,
    )
    invalidate_quality_executions(STATE_PATH, kind, sid)
    document = context["document"]
    api._drop_agent_token(kind, strict=True)
    artifact = quality_task_card_use_cases.store_task_card(
        document,
        os.path.join(".mae-flow-work", "agent-tasks"),
        f"{sid}-{kind.lower()}.md",
        quality_task_card_use_cases.TaskCardStorePorts(
            absolute=os.path.abspath,
            make_directory=lambda path: os.makedirs(
                path, exist_ok=True),
            write_text=lambda path, body: write_text(
                path, body, encoding="utf-8"),
        ),
    )
    digest = artifact.digest
    path = artifact.path
    lightcheck_result = context["lightcheck_result"]
    worktree_snapshot, worktree_snapshot_valid = (
        _compile_worktree_snapshot(kind, context["task_head"]))
    st.setdefault("agent_tasks", {})[kind] = quality_task_cards.task_record(
        step=sid, path=path, head=context["task_head"],
        scope=args.scope or "",
        precommit_review=context["precommit_review"],
        initial_compile_net=(
            api._working_source_net(context["task_head"], st, flow)
            if context["precommit_review"] else 0),
        source_snapshot=(
            api._source_snapshot_since(context["task_head"], st, flow)
            if context["precommit_review"] else {}),
        worktree_snapshot=worktree_snapshot,
        worktree_snapshot_valid=worktree_snapshot_valid,
        allowed_files=(
            context["scan"].get("files", [])
            if kind == "CODECHECK" else []),
        task_files=context["task_files"],
        execution_roots=[
            root for root, _reason in _resolve_task_roots_from_runtime(
                context["execution_files"])[0]],
        lightcheck=({
            "status": lightcheck_result.get("status"),
            "findings": len(lightcheck_result.get("findings") or []),
            "report_path": lightcheck_result.get("report_path", ""),
        } if lightcheck_result is not None else {}),
        ut_targets=context["ut_targets"] if kind == "UT" else {},
        unchanged_initial_dirty=context["inherited_dirty"],
        ut_phase=context.get("ut_phase", ""),
        agent_write_receipts=api._agent_written_receipts(),
        ut_artifact_contract=context.get("ut_artifact_contract", {}),
        at=time.strftime("%Y-%m-%d %H:%M:%S"))
    if kind == "CODECHECK":
        append_codecheck_event(
            os.getcwd(), st, "agent.task_created", {
                "task_path": os.path.abspath(path),
                "head": context["task_head"],
                "allowed_files": context["scan"].get("files", []),
                "scan_count": context["scan"].get("count"),
                "scope": args.scope or "",
            })
    api.save_state(st)
    print(f"[mae-flow] {kind} 任务卡已生成: {path}")
    if kind == "COMPILE" and lightcheck_result is not None:
        api._print_lightcheck_result(lightcheck_result, quiet=True)
    if kind == "CODECHECK":
        print("[mae-flow] CodeCheck 详细日志: %s"
              % api.norm(codecheck_log_path(os.getcwd(), st)))
    print(
        "启动对应专项 Agent 时只传这一句:\n"
        f"读取并严格执行任务卡 \"{path}\"；完成后用自然语言报告实际执行、结果和阻塞。")

def cmd_agent_task(flow, st, args):
    """由代码生成完整子 Agent 任务卡，主模型不再临时拼参数。"""
    kind = args.kind.upper()
    sid = st["current"]
    if kind == "COMPILE" and not host_env.build_runs_locally(st):
        api.die(
            "本单没有本地编译环境，不生成 COMPILE 任务卡，也不要启动 "
            "compile-agent。直接执行 done；内核会登记待权威流水线核销的 "
            "COMPILE 义务，尚未核销前不会宣称编译通过。", 2)
    task_diff_override = ""
    current_step = (flow.get("steps", {}) or {}).get(sid, {})
    precommit_review = kind == "COMPILE" and (
        sid in {"build", "build_rework"}
        or current_step.get("allow_dirty_compile") is True
    )
    (st.get("risk_acceptances", {}) or {}).pop(kind, None)  # 新任务卡=新证据轮次，旧风险确认作废
    if not quality_task_cards.task_allowed(kind, sid):
        api.die(f"当前步骤 {sid} 不允许生成 {kind} 任务卡；先执行 current,禁止提前派发。", 2)
    dirty_source = api._blocking_dirty_source_paths(st, flow)
    ut_accumulated = ()
    ut_prior_returned = False
    if kind == "UT":
        ut_accumulated, dirty_source, ut_prior_returned = (
            _prepare_ut_dirty(st, sid, dirty_source))
    inherited_dirty = api._unchanged_initial_dirty_source_paths(st, flow)
    if dirty_source and not precommit_review:
        api.die("生成任务卡前仍有未提交源码/测试/构建文件: " + "、".join(dirty_source[:8])
            + "。任务卡只信 Git 可追踪范围；先按单号格式精确提交，或回退不属于本单的改动。", 2)
    if precommit_review:
        scope_head = (
            str(st.get("implementation_base_head", "") or "HEAD")
            if sid in {"build", "build_rework"}
            else str((st.get("step_heads", {}) or {}).get(sid, "") or "HEAD")
        )
        implementation_snapshot = api._worktree_snapshot_since(scope_head)
        source_files = [
            path for path in implementation_snapshot
            if api._is_source_path(path, st, flow)
        ]
        if not source_files:
            api.die("本轮只有配置、资源、文档或夹具等非代码交付差异，"
                    "无需生成空编译任务卡；直接 done。", 2)
        diff = "HEAD"
        changes = api.argv_out([
            "git", "-c", "core.quotepath=false", "status", "--short",
            "--untracked-files=all", "--", *source_files,
        ]).splitlines()
    else:
        diff, changes, err = _task_scope(st, task_diff_override)
        if err:
            api.die(err, 2)
        source_files, source_err = (
            api._source_files_for_diff(diff, st) if diff
            else (None, "无法计算任务卡 Git 范围"))
        if source_err:
            api.die(source_err, 2)
    if kind in ("COMPILE", "UT") and not source_files:
        api.die("本轮只有文档/台账等非代码变更，无需生成 %s 任务卡；直接 done。"
            "Harness 在证据层会自动放行，不要启动专项 Agent。" % kind, 2)
    lightcheck_result = None
    if kind == "COMPILE":
        try:
            lightcheck_result = (
                api._working_lightcheck_scope(st, source_files)
                if precommit_review else
                api._run_lightcheck_diff(
                    diff, source_files,
                    "编译前兜底：" + sid))
        except Exception as exc:
            lightcheck_result = api._lightcheck_tool_error(
                "编译前轻量检查异常；已记录诊断，不阻断流程: " + str(exc))
            lightcheck_result["report_path"] = api._save_lightcheck_result(
                lightcheck_result, "编译前：异常安全降级")
    ut_targets = {}
    if kind == "CODECHECK":
        scan = (st.get("quality", {}) or {}).get("codecheck_scan", {})
        if scan.get("step") != sid:
            api.die("先执行 codecheck-scan 冻结首检结果，再生成 CODECHECK 任务卡。", 2)
        if scan.get("scope_pending"):
            api.die("CodeCheck 仍有机器准备排除的候选，必须先让用户确认是否涉及本次修改，"
                "再按 scan 输出执行 codecheck-scope；禁止先派修复 Agent。", 2)
        if scan.get("status") == "TOOL_ERROR":
            api.die("CodeCheck 工具本轮已真实尝试但不可用/不可解析；这是建议项留痕，"
                "不派修复 Agent，直接 done。", 2)
        if scan.get("count", 0) == 0:
            api.die("机器首检为 0 告警，不应派 codecheck-fix-agent；直接 done。", 2)
        if not scan.get("files"):
            api.die("CodeCheck 首检没有业务代码文件却记录了告警，状态自相矛盾；"
                "重新执行 codecheck-scan，禁止把文档或全仓当修复范围。", 2)
        changed, why = api._source_changed_since(scan.get("head", ""), st)
        if why:
            api.die("CodeCheck 首检基点失效:" + why + "；重新执行 codecheck-scan", 2)
        if changed:
            api.die("首检后、修复 Agent 启动前源码已变化: " + "、".join(changed[:5])
                + "。禁止主会话先修再补手续；回退这些改动后重扫。", 2)
    scan = (st.get("quality", {}) or {}).get("codecheck_scan", {})
    task_files = list(scan.get("files", [])) if kind == "CODECHECK" else list(source_files)
    if kind == "UT":
        task_files.extend(
            path for path in ut_accumulated if path not in task_files)
    groups = _classify_task_files_from_runtime(
        task_files, st)
    cfg = st.get("config", {})
    task_head = api.sh("git rev-parse --verify HEAD")
    sources = _resolve_requirement_sources_from_runtime(st)
    execution_files = (
        task_files if kind == "COMPILE"
        else (
            groups["business"]
            or groups["tests"]
            or groups["build"]
        )
    )
    roots, unresolved = _resolve_task_roots_from_runtime(
        execution_files)
    execution_plan = quality_task_card_use_cases.ExecutionRootPlan(
        roots=tuple(roots),
        unresolved=tuple(unresolved),
    )
    notes = []
    ut_batches = ()
    ut_phase = ""
    if kind == "UT":
        ut_targets, ut_batches, ut_phase = _prepare_ut_session(
            st, sid, args, groups, task_head, ut_accumulated,
            ut_prior_returned)
        session = st.get("ut_session") or {}
        if session.get("completed_batches") or ut_phase == "final":
            sources = _incremental_ut_sources(
                st, final=ut_phase == "final")
    ut_contract = (
        ut_artifact_contract(ut_targets, ut_batches)
        if kind == "UT" else {})
    lines = quality_task_card_documents.build_full_task_document({
        "kind": kind,
        "sid": sid,
        "project_root": os.path.abspath(os.getcwd()),
        "head": task_head,
        "config": cfg,
        "diff": diff,
        "scope": args.scope or "",
        "precommit_review": precommit_review,
        "inherited_dirty": tuple(inherited_dirty),
        "sources": tuple(sources),
        "groups": quality_task_card_use_cases.TaskFileGroups(
            business=tuple(groups["business"]),
            tests=tuple(groups["tests"]),
            build=tuple(groups["build"]),
        ),
        "change_count": len(changes),
        "task_file_count": len(task_files),
        "execution_plan": execution_plan,
        "lightcheck": lightcheck_result,
        "notes": tuple(notes),
        "scan": scan,
        "ut_targets": ut_targets,
        "ut_artifact_contract": ut_contract,
        "ut_batches": ut_batches,
        "ut_phase": ut_phase,
        "execution_contract": st.get("execution_contract"),
    })
    _store_agent_task(flow, st, args, {
        "kind": kind, "sid": sid, "document": lines,
        "task_head": task_head,
        "precommit_review": precommit_review, "scan": scan,
        "task_files": task_files, "execution_files": execution_files,
        "lightcheck_result": lightcheck_result, "ut_targets": ut_targets,
        "inherited_dirty": inherited_dirty,
        "ut_phase": ut_phase,
        "ut_artifact_contract": ut_contract,
    })
