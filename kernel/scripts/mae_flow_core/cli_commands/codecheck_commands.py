"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CODECHECK_LINE_SLACK, HERE, STATE_PATH, append_codecheck_event, codecheck_log_path,
    hashlib, load_json, os, quality_codecheck_state, re, read_bytes, sys, time,
    write_text,
)
from .wiring import api
from mae_flow_core import host_env
from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.quality.attempts import begin_attempt


def _begin_codecheck_round(st, sid, head, files):
    attempt = begin_attempt(st, "codecheck", head, limit=2)
    if not attempt.exhausted:
        api.save_state(st)
        return True
    st.setdefault("quality", {})["codecheck_scan"] = {
        "step": sid,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "head": head,
        "count": None,
        "status": "MAX_ROUNDS",
        "files": list(files),
        "pairs": [],
        "commands": [],
        "rounds": attempt.count,
    }
    st.setdefault("risks", []).append(
        "CodeCheck 已达到最多两轮；剩余规范问题按诊断留痕，禁止继续循环")
    api.save_state(st)
    print("[mae-flow] CodeCheck 已完成最多两轮，本次不再启动第三轮。"
          "剩余问题已写入交付风险，直接 done 进入 UT。")
    raise SystemExit(0)

def _die_unless_legal_fix_round(st, sid, changed):
    """进入规范检查后源码变了:必须有一轮可核实的 Agent 收尾令牌背书。

    "谁修的"合法轮令牌由子 Agent 返回钩子签发;云端宿主没有那个钩子,
    令牌恒缺,任何修复轮都会死在这里——同族死点,随台账门禁一起放开。
    机器真相不受影响:重扫本身就是对当前代码重新跑扫描器,零信任自述。
    """
    if not host_env.worker_agent_ledger_gates():
        return
    try:
        tok = load_json(STATE_PATH + ".tokens").get("CODECHECK", {})
    except Exception:
        tok = {}
    legal_round = (isinstance(tok, dict) and tok.get("step") == sid
                   and tok.get("status") in ("CLEAN", "REMAINING"))
    after, token_err = api._source_changed_since(tok.get("head", ""), st) if legal_round else (None, "无合法令牌")
    if not legal_round or token_err or after:
        api.die("进入规范检查后源码已被修改，但没有一轮可核实的 CodeCheck Agent 收尾: " + "、".join(changed[:5])
            + "。禁止主会话先修再补跑首检；回退越权改动。若确为上一轮 Agent 修复，先让它按契约合法收尾。", 2)


def cmd_codecheck_scan(flow, st, args):
    if st["current"] not in ("verify_codecheck", "tw_codecheck", "rf_codecheck"):
        api.die("codecheck-scan 只能在规范检查步骤执行；先按 current 进入对应步骤。", 2)
    sid = st["current"]
    # 云端:不装工具、不扫、不冷却,如实记账后交由流水线。装不上还每次
    # 空撞安装 + TOOL_ERROR 引人走恢复通道,是纯噪声(云端 task-1 实锤)。
    if not host_env.codecheck_runs_locally():
        st.setdefault("quality", {})["codecheck_scan"] = {
            "step": sid,
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "head": api.sh("git rev-parse --verify HEAD"),
            "count": None,
            "status": "PIPELINE",
            "pairs": [],
            "commands": [],
            "error": "",
        }
        api.save_state(st)
        print("[mae-flow] 云端宿主:CodeCheck 交由流水线核对,本地不扫;"
              "lightcheck 照常执行。直接继续本步其余检查。")
        return
    entry_head = (st.get("step_heads", {}) or {}).get(sid, "")
    if entry_head:
        changed, why = api._source_changed_since(entry_head, st)
        if why:
            api.die("无法核对规范检查入口 HEAD:" + why, 2)
        if changed:
            _die_unless_legal_fix_round(st, sid, changed)
    files, err = api._biz_changed_files(st)
    if err:
        api.die(err, 2)
    head = api.sh("git rev-parse --verify HEAD")
    _begin_codecheck_round(st, sid, head, files)
    # 兼容升级前已在途、尚未把过程目录写进 .gitignore 的项目；只改本机
    # info/exclude，避免诊断日志被后续宽范围操作意外带入提交。
    api._git_local_runtime_ignore()
    append_codecheck_event(
        os.getcwd(), st, "scan.requested", {
            "head": head,
            "files": files, "file_count": len(files),
        })
    if files:
        result, err = api._run_codecheck(files, st, "harness-scan")
    else:
        log_path = append_codecheck_event(
            os.getcwd(), st, "scan.empty", {
                "head": api.sh("git rev-parse --verify HEAD"),
                "reason": "no-business-code-files",
            })
        result, err = ({
            "total": 0, "pairs": [], "commands": [],
            "log_path": log_path or codecheck_log_path(os.getcwd(), st),
        }, "")
    if err:
        # CodeCheck 是辅助规范工具，不是编译器或测试器。它的版本、输出协议和
        # 可用性都不稳定；真实尝试一次后把诊断绑定当前源码即可，不让工具故障
        # 把交付流程永久封死，也不要求用户为同一工具问题反复确认。
        tool_error = quality_codecheck_state.build_tool_error_scan(
            step=sid,
            at=time.strftime("%Y-%m-%d %H:%M:%S"),
            head=head,
            files=tuple(files),
            error=err,
            log_path=codecheck_log_path(os.getcwd(), st),
        )
        st.setdefault("quality", {})["codecheck_scan"] = (
            tool_error.as_record())
        append_codecheck_event(
            os.getcwd(), st, "scan.tool_error",
            tool_error.event_record())
        st["quality"].pop("codecheck_verify", None)
        api._drop_agent_token("CODECHECK")
        (st.get("agent_tasks", {}) or {}).pop("CODECHECK", None)
        api.save_state(st)
        print("[mae-flow] ⚠ CodeCheck 已真实尝试但工具不可用或输出无法解析；"
              "诊断已绑定当前 HEAD，本轮按建议项留痕，不派修复 Agent，也不重复长跑。",
              file=sys.stderr)
        print(err, file=sys.stderr)
        print("[mae-flow] CodeCheck 详细日志: %s"
              % api.norm(codecheck_log_path(os.getcwd(), st)))
        print("直接 done；源码若变化，当前诊断会失效并要求重新尝试。")
        return
    scoped = api._codecheck_scope_classification(
        result, st, files)
    completed = quality_codecheck_state.build_completed_scan(
        step=sid,
        at=time.strftime("%Y-%m-%d %H:%M:%S"),
        head=head,
        files=tuple(files),
        scoped=scoped,
        moonlight=api._moonlight(st),
        fallback_log_path=codecheck_log_path(
            os.getcwd(), st),
    )
    if completed.moonlight_included:
        print("[mae-flow] 🌙 月光模式无法进行用户范围裁决；%d 条疑似范围外告警"
              "已保守全部计入本次修复范围。"
              % completed.moonlight_included)
    scan_record = completed.as_record()
    st.setdefault("quality", {})["codecheck_scan"] = (
        scan_record)
    append_codecheck_event(
        os.getcwd(), st, "scan.completed",
        completed.event_record())
    result = {
        "total": scan_record["count"],
        "pairs": scan_record["pairs"],
        "commands": scan_record["commands"],
        "scope_reasons": scan_record["scope_reasons"],
        "log_path": scan_record["log_path"],
    }
    candidates = scan_record["scope_candidates"]
    excluded_pairs = (
        [] if scoped.classified else None)
    st["quality"].pop("codecheck_verify", None)
    if result.get("pairs"):
        print("[mae-flow] 机器已直接计入本次修改的告警:")
        for i, pair in enumerate(result["pairs"], 1):
            print("  A%d | %s | %s:%s" % (
                i, pair[0], pair[1], pair[2] if pair[2] is not None else "?"))
    if candidates:
        print("[mae-flow] ⚠ 机器按变更行±%d/变更函数预分类出 %d 条“归属不确定”告警；"
              "它们尚未被排除，必须先让用户确认是否涉及本次修改。"
              % (CODECHECK_LINE_SLACK, len(candidates)))
        for item in candidates:
            print("  %s | %s | %s:%s | %s" % (
                item["id"], item["rule"], item["file"], item["line"],
                item["reason"]))
        print("用 AskUserQuestion 分批展示上述候选，让用户选择“涉及本次修改”的编号。")
        print("确认后先执行 messages 取得该回答 ID，再执行以下二选一命令：")
        print('  python "%s" codecheck-scope --include W1,W3 --message-id <ID>'
              % os.path.abspath(sys.argv[0]))
        print('  python "%s" codecheck-scope --none --message-id <ID>'
              % os.path.abspath(sys.argv[0]))
        print("在 codecheck-scope 完成前，禁止生成修复任务卡，也不能 done。")
    elif excluded_pairs is None and result["total"]:
        print("[mae-flow] ⚠ 本轮告警明细缺行号,无法区分存量与本单修改,"
              "已保守全算。", file=sys.stderr)
    # 每次重扫都是新一轮；旧 Agent 令牌不能替新告警背书。
    api._drop_agent_token("CODECHECK")
    (st.get("agent_tasks", {}) or {}).pop("CODECHECK", None)
    api.save_state(st)
    print(f"[mae-flow] CodeCheck 首检完成:业务文件 {len(files)} 个,告警 {result['total']} 条。")
    print("[mae-flow] CodeCheck 详细日志: %s"
          % api.norm(result.get("log_path") or codecheck_log_path(os.getcwd(), st)))
    if candidates:
        print("先完成用户范围确认；此时显示的告警数仅为机器明确相关部分。")
    elif result["total"]:
        print("禁止主会话修复。下一步执行 agent-task codecheck 生成完整任务卡，再启动 codecheck-fix-agent。")
    else:
        print("零告警，不派修复 agent；直接 done（期间源码若变化，证据会过期并要求重扫）。")

def cmd_codecheck_scope(flow, st, args):
    """把机器准备排除的 CodeCheck 结果交给用户裁定是否涉及本次修改。"""
    if st["current"] not in ("verify_codecheck", "tw_codecheck", "rf_codecheck"):
        api.die("codecheck-scope 只能在规范检查步骤使用。", 2)
    scan = (st.get("quality", {}) or {}).get(
        "codecheck_scan", {})
    ok, authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("CodeCheck 涉及范围确认验真失败:" + why, 2)
    decision = quality_codecheck_state.decide_scope_with_ports(
        scan=scan,
        current_step=st["current"],
        include_text=args.include or "",
        none=bool(args.none),
        ack=authorization,
        authorization=authorization_receipt,
        source_changed_since=lambda head: (
            api._source_changed_since(head, st)
        ),
        verify_ack=lambda _ack: (True, ""),
        now=lambda: time.strftime("%Y-%m-%d %H:%M:%S"),
    )
    if decision.error:
        api.die(decision.error, 2)
    scan = decision.as_record()
    st.setdefault("quality", {})["codecheck_scan"] = scan
    append_codecheck_event(
        os.getcwd(), st, "scope.decided",
        decision.event_record())
    include = set(decision.included)
    st["quality"].pop("codecheck_verify", None)
    api._drop_agent_token("CODECHECK")
    (st.get("agent_tasks", {}) or {}).pop("CODECHECK", None)
    api.save_state(st)
    if include:
        print("[mae-flow] 用户确认以下候选涉及本次修改: "
              + "、".join(sorted(include)) + "；已加入本轮修复范围。")
    else:
        print("[mae-flow] 用户确认疑似范围外候选均不涉及本次修改。")
    print("最终本轮告警 %d 条，用户确认不涉及 %d 条。"
          % (scan["count"], scan["stock_excluded"]))
    print("[mae-flow] CodeCheck 详细日志: %s"
          % api.norm(scan.get("log_path") or codecheck_log_path(os.getcwd(), st)))
    if scan["count"]:
        print("现在执行 agent-task codecheck 生成任务卡并启动修复 Agent。")
    else:
        print("最终范围为 0 条，可直接 done。")

def cmd_codecheck_record(flow, st, args):
    """CodeCheck 输出格式未知时的人工恢复口，不把工具兼容问题变成无解死锁。"""
    if st["current"] not in ("verify_codecheck", "tw_codecheck", "rf_codecheck"):
        api.die("codecheck-record 只能在规范检查步骤使用。", 2)
    if args.count < 0 or not args.reason:
        api.die("codecheck-record 需要非负 --count、--reason 和 --message-id。", 2)
    ok, _authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("人工确认验真失败:" + why, 2)
    diag = os.path.abspath(args.diagnostic)
    root = os.path.abspath(os.path.join(".mae-flow-work", "codecheck-diagnostics"))
    if not (diag == root or diag.startswith(root + os.sep)) or not os.path.isfile(diag):
        api.die("--diagnostic 必须是本流程保存的 .mae-flow-work/codecheck-diagnostics/ 文件。", 2)
    try:
        entered = time.mktime(time.strptime(api._step_entered_at(st), "%Y-%m-%d %H:%M:%S"))
    except Exception:
        entered = 0
    if os.path.getmtime(diag) + 2 < entered:
        api.die("诊断文件早于当前 CodeCheck 步骤，不能拿旧现场登记本轮结果；请重新执行 codecheck-scan。", 2)
    files, err = api._biz_changed_files(st)
    if err:
        api.die(err, 2)
    digest = hashlib.sha256(read_bytes(diag)).hexdigest()
    head = api.sh("git rev-parse --verify HEAD")
    records = quality_codecheck_state.build_manual_records(
        step=st["current"],
        head=head,
        files=tuple(files),
        count=args.count,
        diagnostic=diag,
        diagnostic_sha256=digest,
        reason=args.reason,
        authorization=authorization_receipt,
        at=time.strftime("%Y-%m-%d %H:%M:%S"),
        log_path=codecheck_log_path(os.getcwd(), st),
    )
    quality = st.setdefault("quality", {})
    quality["codecheck_manual"] = records.manual_record()
    quality["codecheck_scan"] = records.scan_record()
    append_codecheck_event(
        os.getcwd(), st, "manual.result_recorded",
        records.event_record())
    st["quality"].pop("codecheck_verify", None)
    api._drop_agent_token("CODECHECK")
    (st.get("agent_tasks", {}) or {}).pop("CODECHECK", None)
    api.save_state(st)
    print(f"[mae-flow] 已记录人工核对结果: {args.count} 条，绑定 HEAD {head[:12]} 与诊断 SHA256 {digest[:12]}。")
    print("[mae-flow] CodeCheck 详细日志: %s"
          % api.norm(codecheck_log_path(os.getcwd(), st)))
    print("0 条可直接 done；大于 0 条必须生成 codecheck 任务卡交修复 Agent，不能把人工记录当豁免。")

def cmd_approve_exemption(flow, st, args):
    if st["current"] not in ("verify_codecheck", "tw_codecheck", "rf_codecheck"):
        api.die("规范告警豁免只能在 CodeCheck 步骤审批。", 2)
    if not args.reason:
        api.die("approve-exemption 必须带 --reason 和 --message-id。", 2)
    asked, why = api.ev_agent_ran({"agent": "ASKUSER"}, st)
    if not asked:
        api.die("豁免前必须真实使用 AskUserQuestion 逐项呈用户裁决:" + why, 2)
    ok, _authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("豁免授权验真失败:" + why, 2)
    rule, file_name = args.rule.strip(), api.norm(args.file.strip()).lstrip("./")
    if not rule or not file_name:
        api.die("--rule/--file 不能为空。", 2)
    rec = {"rule": rule, "file": file_name, "reason": args.reason,
           "authorization": authorization_receipt,
           "step": st["current"], "at": time.strftime("%Y-%m-%d %H:%M:%S")}
    rows = st.setdefault("codecheck_exemptions", [])
    key = api._approval_key(rule, file_name)
    rows[:] = [x for x in rows if api._approval_key(x.get("rule", ""), x.get("file", "")) != key]
    rows.append(rec)
    package = ensure_work_package(
        os.getcwd(), st["config"].get("单号", ""))
    ex = os.path.join(package.root, "codecheck-exemptions.md")
    os.makedirs(os.path.dirname(ex), exist_ok=True)
    if not os.path.exists(ex):
        write_text(ex, "# CodeCheck 正式豁免记录\n\n")
    safe_reason = re.sub(r"[\r\n|]+", " ", args.reason).strip()
    with open(ex, "a", encoding="utf-8") as f:
        f.write(
            f"- {rule} | {file_name} | {safe_reason} | "
            f"用户消息:{authorization_receipt['message_id']} | "
            f"SHA256:{authorization_receipt['answer_sha256']}\n")
    append_codecheck_event(
        os.getcwd(), st, "exemption.approved", {
            "head": api.sh("git rev-parse --verify HEAD"),
            "rule": rule, "file": file_name,
            "reason": args.reason,
            "authorization": authorization_receipt,
            "record_file": os.path.abspath(ex),
        })
    api.save_state(st)
    print(f"[mae-flow] 已登记用户批准的正式豁免: {rule} | {file_name}\n"
          f"记录已写入本地过程件 {ex}；不得 git add/commit，禁止手写其他豁免冒充审批。")

def cmd_template(flow, args):
    """打印模板绝对路径(story|chain)。子 agent/会话在项目目录里搜不到插件安装目录,
    必须经本命令拿路径。"""
    name = {"story": "STORY-TEMPLATE.md", "chain": "CHAIN-TEMPLATE.md",
            "grill": "GRILL-PREP-TEMPLATE.md", "review": "REVIEW-TEMPLATE.md"}[args.kind]
    p = os.path.abspath(os.path.join(HERE, "..", "skills", "mae-flow", "assets", name))
    if not os.path.exists(p):
        api.die(name + " 模板缺失: " + p)
    print(p)
