"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    BashGateContext, BashWriteContext, EditGateContext, HERE, OwnershipFacts,
    STATE_PATH, WRITEISH_STRONG, WRITEISH_WEAK, decide_bash_write,
    decide_commit_branch, decide_edit,
    decide_ownership, decide_post_commit, decide_pre_commit, git_intent,
    guard_intent, os, re, replace, source_unlocked_for, sys, time,
    workflow_chosen,
)
from ..workflow.advisories import lightcheck_advisory, record_advisory
# quality_input_snapshot/successful_quality_execution 必须静态导入。经 api.* 动态
# 取时它们并未注册,AttributeError 被 _gate_compile_task_window 的 except 吞掉 →
# completed 恒为假 → 已签发 COMPILE 任务卡的步骤里任何提交都被永久拦死。
from ..workflow.quality_executions import (
    quality_input_snapshot,
    successful_quality_execution,
)
from mae_flow_core.foundation.worktree_intent import (
    worktree_discard_paths)
from .external_repair_gate import gate_repair_add, gate_repair_commit
from .wiring import api


def _hook_rule_message(rule, message):
    if os.environ.get("MAE_FLOW_HOOK_TRACE") == "1":
        return "[mae-flow-rule=%s]\n%s" % (
            rule or "absolute-policy", message)
    return message


def _die_rule(rule, message):
    api.die(_hook_rule_message(rule, message), 2)


def _die_decision(decision):
    _die_rule(getattr(decision, "rule", ""), decision.message)


def _advisory_lightcheck_before_commit(st, snapshot):
    """Check exact commit candidates; any timeout/crash remains non-blocking."""
    try:
        result = api._pending_lightcheck_scope(st, snapshot)
    except BaseException as exc:
        result = api._lightcheck_tool_error(
            "提交前轻量检查启动失败；已记录诊断，不阻断流程: " + str(exc))
        result["report_path"] = api._save_lightcheck_result(
            result, "提交前：异常安全降级")
    api._print_lightcheck_result(result, quiet=True)
    _keep_advisory(st, "lightcheck", lightcheck_advisory(result))


def _relay_hint(block_id):
    """告诉 Agent 怎么征求许可:编号必须写进问用户的那句话。

    授权验真只认"这条回答里有本次编号"——所以编号不能只印在报错里给 Agent 看,
    必须转述给用户。不说这一句,Agent 就会拿别处的同意来试,试不通再瞎猜参数
    (实战里它去传了 allow --paths,而这个参数不存在)。
    """
    return ("\n如需放行:用 AskUserQuestion 征求用户许可,"
            "**把放行编号 %s 原样写进问题正文**(选项照旧简短,如「允许」「不允许」),"
            "再执行 allow %s --message-id <那条消息的 ID>。"
            % (block_id, block_id))


def _keep_advisory(st, kind, message):
    """Non-blocking Gate signals must survive the exit-0 stderr black hole."""
    if not message:
        return
    try:
        record_advisory(
            STATE_PATH, (st or {}).get("current", ""), kind, message,
            time.strftime("%Y-%m-%d %H:%M:%S"))
    except Exception:
        pass

def _redirect_targets(c):
    """提取 >/>> 的真实落盘目标。fd 复制(2>&1)与空设备不算写文件。

    校准实锤:目标带引号(`> "src/a.c"`,Windows 习惯写法)曾整体逃逸捕获,
    源码保护与 specs 真相源双拦全部短路——引号形态必须同样捕获。"""
    out = []
    for m in re.finditer(
            r"""\d*>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>'"]+))""", c):
        t = (m.group(1) or m.group(2) or m.group(3) or "").strip()
        if not t or t.lower() in ("/dev/null", "nul"):
            continue
        out.append(t)
    return out

def _gate_edit(flow, st, sid, step, intent, jdie):
    p = intent.subject
    rel = api._repo_rel_for_match(p)
    pm = rel if rel is not None else p
    plugin_root = api.norm(os.path.abspath(os.path.join(HERE, ".."))).lower()
    decision = decide_edit(EditGateContext(
        path=p,
        match_path=pm,
        step=sid or "",
        inside_plugin=api.norm(os.path.abspath(p)).lower().startswith(
            plugin_root + "/"),
        is_source=api._is_source_path(p, st, flow),
        source_unlocked=source_unlocked_for(st, sid),
        workflow_chosen=workflow_chosen(st),
    ))
    if decision.kind == "absolute":
        _die_decision(decision)
    if decision.kind == "block":
        jdie(decision.rule, decision.message)
    if decision.kind == "advisory":
        _keep_advisory(st, decision.rule, decision.message)
    sys.exit(0)


def _compile_candidate_groups(candidate_snapshot, compile_side_effects):
    staged_paths = {
        api._repo_path_identity(path)
        for path in candidate_snapshot.get("staged_paths", ())
    }
    command_paths = {
        api._repo_path_identity(path)
        for path in candidate_snapshot.get("working_paths", ())
    }
    return (
        tuple(
            path for path in compile_side_effects
            if api._repo_path_identity(path) in staged_paths
        ),
        tuple(
            path for path in compile_side_effects
            if api._repo_path_identity(path) in command_paths
        ),
    )


def _enforce_commit_ownership(decision, jdie, st=None):
    if decision.block:
        if decision.block.rule in {
                "bash-compile-side-effects",
                "bash-build-artifacts",
                }:
            # Integrity/provenance hard blocks are not user-decision permits.
            # Keep their recovery local and write no strike/permit state.
            _die_decision(decision.block)
        jdie(decision.block.rule, decision.block.message)
    for message in decision.advisories:
        print(message, file=sys.stderr)
        _keep_advisory(st, "commit-ownership", message)


def _gate_confirmed_manifest_candidates(st, candidate_snapshot):
    if gate_repair_commit(st, candidate_snapshot, _die_rule):
        return
    manifest = st.get("delivery_manifest") or {}
    if not manifest:
        return
    if not manifest.get("confirmed"):
        _die_rule(
            "bash-delivery-manifest-unconfirmed",
            "交付清单尚未由用户确认。先执行 manifest show，收到用户回答后"
            "使用 manifest confirm --message-id <消息ID>。")
    expected = {
        api._repo_path_identity(path) for path in manifest.get("files", ())
    }
    actual = {
        api._repo_path_identity(path)
        for path in candidate_snapshot.get("paths", ())
    }
    if actual != expected:
        # 指路必须指向真正能改清单的命令:manifest show 只读,曾把修复
        # Agent 指进空门原地打转(排查实锤)。
        _die_rule(
            "bash-delivery-manifest-files",
            "待提交文件必须精确等于用户确认的交付清单。缺少: %s；夹带: %s。"
            "用 manifest show 核对清单，再用 git add / git restore --staged "
            "把暂存内容调整到与清单一致；清单本身需要变(新增/剔除文件)时，"
            "用 manifest set --file <路径>... --target <检视产物> 重设并"
            "重新取得用户确认——show 只能看不能改。"
            % ("、".join(sorted(expected - actual)) or "无",
               "、".join(sorted(actual - expected)) or "无"))


def _gate_confirmed_manifest_add(st, add_paths):
    if gate_repair_add(st, add_paths, _die_rule):
        return
    manifest = st.get("delivery_manifest") or {}
    if not add_paths or not manifest:
        return
    if not manifest.get("confirmed"):
        # 与 commit 侧同一条规则必须给同样完整的出路(add 先于 commit
        # 被撞到,原来只有一句"不行")。
        _die_rule(
            "bash-delivery-manifest-unconfirmed",
            "交付清单尚未由用户确认，不能暂存交付文件。先执行 manifest "
            "show，收到用户回答后使用 manifest confirm --message-id "
            "<消息ID>，再按清单精确 git add。")
    allowed = {
        api._repo_path_identity(path) for path in manifest.get("files", ())
    }
    outside = [
        path for path in add_paths
        if api._repo_path_identity(path) not in allowed
    ]
    if outside:
        _die_rule(
            "bash-delivery-manifest-stage",
            "git add 只能包含用户确认清单中的精确文件: "
            + "、".join(outside)
            + "。执行 manifest show 核对清单后只暂存其中的文件；"
            "这些文件确实属于本次交付时，用 manifest set --file <路径>... "
            "--target <检视产物> 把它们纳入清单并重新取得用户确认"
            "——show 只能看不能改。")


def _gate_commit_candidates(c, st, jdie):
    candidate_snapshot = api._pending_commit_candidates(c)
    _gate_confirmed_manifest_candidates(st, candidate_snapshot)
    (inherited, foreign_openspec, compile_side_effects, strong_artifacts,
     unproven_paths, artifact_hints) = api._pending_commit_files(
         c, st, candidate_snapshot)
    (staged_compile_side_effects, command_compile_side_effects) = (
        _compile_candidate_groups(candidate_snapshot, compile_side_effects))
    decision = decide_ownership(OwnershipFacts(
        candidate_paths=tuple(candidate_snapshot.get("paths") or []),
        inherited=tuple(inherited),
        foreign_openspec=tuple(foreign_openspec),
        compile_side_effects=tuple(compile_side_effects),
        staged_compile_side_effects=staged_compile_side_effects,
        command_compile_side_effects=command_compile_side_effects,
        strong_artifacts=tuple(strong_artifacts),
        unproven_paths=tuple(unproven_paths),
        artifact_hints=tuple(artifact_hints),
    ))
    _enforce_commit_ownership(decision, jdie, st)
    _advisory_lightcheck_before_commit(st, candidate_snapshot)

def _gate_bash_writes(flow, st, sid, step, intent, jdie):
    c = intent.subject
    toks = intent.tokens
    redirects = _redirect_targets(c)
    strong_write = bool(re.search(WRITEISH_STRONG, c, re.I))
    weak_write = bool(re.search(WRITEISH_WEAK, c, re.I))
    writeish = strong_write or weak_write or bool(redirects)
    source_toks = [t for t in toks if api._is_source_path(t, st, flow)]
    redirect_sources = [t for t in redirects if api._is_source_path(t, st, flow)]
    offenders = list(dict.fromkeys(
        redirect_sources + (source_toks if strong_write else [])))
    source_unlocked = source_unlocked_for(st, sid)
    decision = decide_bash_write(BashWriteContext(
        command=c,
        tokens=tuple(toks),
        writeish=writeish,
        hits_internal_state=guard_intent.hits_path(
            intent,
            r"\.mae-flow(\.json|-history\.jsonl|-need-reload|-defaults\.json)"
            r"|\.mae-flow-work/(?:moonlight-report\.md|"
            r"(?:plugin-resources|repository-skills|host-skills)(?:/|$))"),
        step=sid or "",
        offenders=tuple(offenders),
        source_unlocked=source_unlocked,
        workflow_chosen=workflow_chosen(st),
    ))
    if decision.kind == "absolute":
        _die_decision(decision)
    if decision.kind == "block":
        jdie(decision.rule, decision.message)
    if decision.kind == "advisory":
        print(decision.message, file=sys.stderr)
    sys.exit(0)


def _git_actions_preflight(command):
    wrapped_git = git_intent.wrapped_git_mutations(command)
    if wrapped_git:
        _die_rule(
            "bash-wrapped-git",
            "Agent Bash 禁止用 Python/PowerShell/cmd/sh 等解释器或子进程"
            "换壳执行 git add/commit/push 来绕过 Hook。检测到: "
            + "、".join(wrapped_git)
            + "。保留现场并直接使用可见的 git 命令，让 Gate 正常裁决；"
            "若是用户本人决定在外部终端操作，应把命令和风险交给用户，"
            "不得由 Agent 代执行。",
        )
    alias_mutations = list(
        git_intent.inline_git_alias_mutations(command))
    for operation, _arguments in git_intent.git_invocations(command):
        expansion = api.argv_out([
            "git", "config", "--get", "alias." + operation,
        ])
        mutation = git_intent.git_alias_mutation(expansion)
        if mutation:
            alias_mutations.append(mutation)
    if alias_mutations:
        _die_rule(
            "bash-mutating-git-alias",
            "Agent Bash 禁止用 mutating Git alias 隐藏真实写动作。"
            "检测到 alias 最终指向: "
            + "、".join(dict.fromkeys(alias_mutations))
            + "。请改用可见的 canonical git add/commit/push/"
            "restore/rm/revert 命令，让 Gate 预检 exact action；"
            "只读 alias 不受影响，用户外部终端不受 Hook 约束。",
        )
    opaque_pathspecs = git_intent.opaque_pathspec_mutations(
        command)
    if opaque_pathspecs:
        _die_rule(
            "bash-opaque-pathspec",
            "Agent Git 写动作禁止使用 --pathspec-from-file/"
            "--pathspec-file-nul：Gate 无法在执行前核对其 exact candidates。"
            "检测到: " + "、".join(opaque_pathspecs)
            + "。请改为显式 `-- <paths>`，逐项展示并接受 ownership"
            " 检查；用户外部终端不受 Hook 约束。",
        )
    actions = git_intent.git_actions(
        command, actor="agent-hook")
    head_mutations = [
        action for action in actions
        if action.operation in ("commit", "revert")
    ]
    if len(head_mutations) > 1:
        _die_rule(
            "bash-multiple-head-mutations",
            "Agent 单条 Bash 中只能执行每次一个可审计的 "
            "git commit/revert；检测到 %d 个 HEAD 改写动作。"
            "请拆成独立命令，让 Gate 对每个 GitAction 的 message、"
            "paths 与 ownership 分别预检。用户在外部终端的操作"
            "不受此 Hook 约束。"
            % len(head_mutations),
        )
    return actions


def _gate_head_actions(actions, st, jdie):
    commit_present = any(
        action.operation == "commit" for action in actions)
    revert_actions = [
        action for action in actions
        if action.operation == "revert"
    ]
    if revert_actions:
        target = revert_actions[-1].commit or "非精确提交"
        jdie(
            "bash-git-revert-user-authorization",
            "Agent 发起 git revert 会直接改写 HEAD，必须绑定用户明确要求"
            "回退的 exact commit。当前目标: " + target
            + "。若用户原话已明确包含该 commit，使用本次拦截编号签发"
            "一次性 exact 放行；否则先让用户裁决。",
        )
    return commit_present


def cmd_gate(flow, st, args):
    # 全局安装只是提供能力，不代表用户授权接管当前仓库。没有状态时必须 fail-open；
    # 真正启用流程只认 init 创建的 .mae-flow.json。
    if st is None:
        sys.exit(0)
    sid = st["current"] if st else None
    step = flow["steps"].get(sid, {}) if st else {}
    # end 状态保留在主文件中是为了报告与下一单滚动，不代表流程门禁仍活跃。
    # Hook 主路由已整体旁路；这里再做一次 CLI 级防御，避免旧 Hook、手工 gate
    # 调用或并发终态迁移继续拦截普通开发。
    if step.get("terminal"):
        sys.exit(0)

    intent = guard_intent.parse_intent(args.what, args.arg)

    def jdie(rule, msg):
        # 裁决类规则统一走 break-glass 出口(放行令+三振熔断);绝对类仍用裸 die
        api._gate_die(st, sid, rule, intent.subject, msg)
    # NTFS 不区分大小写:所有路径匹配一律 re.I
    if args.what == "edit":
        return _gate_edit(flow, st, sid, step, intent, jdie)
    if args.what == "bash":
        c = intent.subject
        git_command = args.arg
        git_actions = _git_actions_preflight(git_command)
        commit_present = _gate_head_actions(
            git_actions, st, jdie)
        # 按 token 匹配路径类 pattern:整串匹配时 `(^|/)src/` 对空格后的相对路径
        # (如 `sed -i ... src/main.c`)永远不命中
        toks = intent.tokens

        def hits_path(pat):
            return guard_intent.hits_path(intent, pat)

        internal_state = hits_path(
            r"(^|/)(\.mae-flow\.json(?:\.[\w-]+)*|"
            r"\.mae-flow-history\.jsonl|\.mae-flow-need-reload"
            r"|\.mae-flow-work/moonlight-report\.md)$")
        branch = intent.branch
        message_present, commit_message = (
            git_intent.git_commit_message(git_command))
        wanted = st["config"].get("分支名", "")
        add_paths, _add_force = api._git_add_pathspecs(
            git_command)
        _gate_confirmed_manifest_add(st, add_paths)
        context = BashGateContext(
            command=c,
            has_internal_state_path=internal_state,
            branch_name=branch.name if branch else "",
            branch_creating=bool(branch.creating) if branch else False,
            step=sid or "",
            wanted_branch=wanted,
            base_branch=st["config"].get("基线分支", ""),
            ticket=st["config"].get("单号", ""),
            commit_message_present=message_present,
            commit_message=commit_message,
            current_branch="",
            add_paths=tuple(add_paths),
            recursive_delete_targets=
                guard_intent.recursive_delete_targets(intent),
            state_active=bool(st),
            # 带着用户流程启动前未提交改动的文件,被 checkout/restore 瞄准丢弃
            user_scene_discards=tuple(
                path for path in worktree_discard_paths(c)
                if api._unchanged_initial_dirty(path, st or {})),
        )
        pre = decide_pre_commit(context)
        if pre.kind == "absolute":
            _die_decision(pre)
        if pre.kind == "block":
            jdie(pre.rule, pre.message)
        # 不给头部步骤开天窗:decide_commit_branch 的 docstring 记载过
        # 实锤——无人值守跑到 workflow_select 时模型把三个提交全落在
        # 基线分支上,恰恰因为这里曾按步骤跳过。分支名还没定时纯函数
        # 本来就放行(wanted 为空),不需要任何步骤白名单。
        if message_present and wanted:
            context = replace(
                context,
                current_branch=api.sh("git branch --show-current"),
            )
            branch_decision = decide_commit_branch(context)
            if branch_decision.kind == "block":
                jdie(branch_decision.rule, branch_decision.message)
        if commit_present:
            _gate_commit_candidates(git_command, st, jdie)
        post = decide_post_commit(context)
        if post.kind == "absolute":
            _die_decision(post)
        if post.kind == "block":
            jdie(post.rule, post.message)
        return _gate_bash_writes(flow, st, sid, step, intent, jdie)
    api.die("gate 用法: gate edit <路径> | gate bash <命令>")
