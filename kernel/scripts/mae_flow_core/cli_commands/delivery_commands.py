"""Trusted Cloud host commands for the continuous delivery review loop."""
import hashlib
import json
from .shared import os, time
from .wiring import api
from .delivery_support import (
    render_delivery_feedback,
    unpushed_commits as collect_unpushed_commits,
)
from .user_intervention import clear_stale_evidence
from mae_flow_core.quality.external_repair import (
    clear_feedback_authorization, issue_feedback_authorization)
from mae_flow_core.workflow.execution_contract import continuous_review_enabled
from .host_capability import (
    host_managed_continuous_review, verify_host_proof)
from .host_receipts import (
    attest_host_receipts, external_facts, has_host_receipt, has_receipt_for,
    save_with_host_proof, trusted_active_batch, trusted_current_lifecycle,
    trusted_pipeline_projection)
BATCH_SCHEMA = "mae-flow-feedback-batch/1"
RESULT_SCHEMA = "mae-flow-feedback-result/1"
STATE_SCHEMA = "mae-flow-delivery-loop/1"
_RESULTS = frozenset(("fixed", "explained", "needs_human", "not_applicable"))
_WAITING = frozenset(("external_verify", "delivery_watch"))
_WRITER = frozenset(("feedback_triage", "build", "domain_archive",
                     "delivery_review", "push"))
def _die(message):
    api.die("delivery: " + message, 2)


def _verify_host_proof(state, args, action, payload):
    return verify_host_proof(state, args.host_proof, action, payload)


def _payload(path, schema):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
        if os.path.islink(absolute) or not os.path.isfile(absolute):
            raise ValueError("事实文件必须是普通文件")
        if info.st_size > 512 * 1024:
            raise ValueError("事实文件超过 512 KiB")
        with open(absolute, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _die("无法读取事实文件 %s: %s" % (absolute, exc))
    if not isinstance(value, dict) or value.get("schema") != schema:
        _die("事实文件 schema 必须是 %s" % schema)
    return value


def _text(value, name, limit=4000, required=True):
    result = str(value or "").strip()
    if required and not result:
        _die("%s 不能为空" % name)
    if len(result) > limit:
        _die("%s 超过 %s 字符" % (name, limit))
    return result


def _loop(state):
    loop = state.setdefault("delivery_loop", {
        "schema": STATE_SCHEMA,
        "delivery_round": 0,
        "active_batch_id": "",
        "batches": [],
        "close_events": [],
    })
    if loop.get("schema") != STATE_SCHEMA:
        _die("delivery_loop 状态版本不受支持")
    loop.setdefault("delivery_round", 0)
    loop.setdefault("active_batch_id", "")
    loop.setdefault("batches", [])
    loop.setdefault("close_events", [])
    return loop


def _batch(loop, batch_id):
    return next((
        item for item in loop.get("batches", [])
        if isinstance(item, dict) and item.get("batch_id") == batch_id
    ), None)


def _capability(state):
    if not (host_managed_continuous_review()
            or continuous_review_enabled(state)):
        _die("当前任务没有启用 Cloud continuous_review 执行契约，拒绝静默降级")


def _head():
    value = api.sh("git rev-parse --verify HEAD")
    if not value:
        _die("无法读取当前 HEAD")
    return value


def _item(raw):
    if not isinstance(raw, dict):
        _die("items 每一项必须是 JSON object")
    item_id = _text(raw.get("id"), "items.id", 200)
    source = _text(raw.get("source"), "items.source", 80)
    result = {
        "id": item_id,
        "source": source,
        "source_id": _text(raw.get("source_id"), "items.source_id", 200),
        "source_revision": int(raw.get("source_revision", raw.get("revision", 0)) or 0),
        "kind": _text(raw.get("kind"), "items.kind", 80, required=False),
        "summary": _text(raw.get("summary"), "items.summary", 4000),
        "material": _text(raw.get("material"), "items.material", 1000, required=False),
        "verification": _text(raw.get("verification"), "items.verification", 80),
    }
    if raw.get("file") is not None:
        result["file"] = _text(raw.get("file"), "items.file", 1000, required=False)
    if raw.get("line") is not None:
        try:
            result["line"] = int(raw.get("line"))
        except (TypeError, ValueError):
            _die("items.line 必须是整数")
    return result


def _history(state, step, result, note):
    state.setdefault("history", []).append({
        "step": step,
        "result": result,
        "note": note,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


def _adopt_watch(state, payload, proof_nonce):
    """One-way adoption for pre-contract Cloud tasks already awaiting merge."""
    migration_id = _text(payload.get("batch_id"), "batch_id", 200)
    contract = state.get("execution_contract") or {}
    if contract.get("host") != "cloud":
        _die("只有旧 Cloud 任务可以迁移到持续检视")
    loop = _loop(state)
    migrations = loop.setdefault("migrations", [])
    previous = next((
        item for item in migrations
        if isinstance(item, dict) and item.get("migration_id") == migration_id
    ), None)
    if previous is not None:
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": STATE_SCHEMA, "idempotent": True,
            "migration_id": migration_id, "current": state.get("current"),
        }, ensure_ascii=False))
        return
    if state.get("current") != "end":
        _die("adopt-watch 只接受旧终态 end，当前是 %s"
             % str(state.get("current") or "?"))
    head = _head()
    external = ((state.get("quality") or {}).get("external_verification") or {})
    if external.get("verdict") != "PASS" or external.get("sha") != head:
        _die("旧终态没有绑定当前 HEAD 的权威 PASS，不能安全迁移")
    contract["continuous_review"] = True
    state["execution_contract"] = contract
    state["current"] = "delivery_watch"
    state.setdefault("step_heads", {})["delivery_watch"] = head
    migrations.append({
        "migration_id": migration_id,
        "kind": "terminal-to-delivery-watch",
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "head": head,
    })
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": STATE_SCHEMA, "idempotent": False,
        "migration_id": migration_id, "current": "delivery_watch",
    }, ensure_ascii=False))


def _open(flow, state, args):
    del flow
    payload = _payload(args.file, BATCH_SCHEMA)
    proof_nonce = _verify_host_proof(state, args, "feedback-open", payload)
    if payload.get("mode") == "adopt-watch":
        return _adopt_watch(state, payload, proof_nonce)
    _capability(state)
    batch_id = _text(payload.get("batch_id"), "batch_id", 200)
    if host_managed_continuous_review():
        existing_loop = state.get("delivery_loop")
        active_id = (str(existing_loop.get("active_batch_id") or "")
                     if isinstance(existing_loop, dict) else "")
        predecessor_ok = (trusted_active_batch(state, (
            "feedback-open", "feedback-result", "pipeline-record"))
            if active_id
            else trusted_current_lifecycle(state, (
                "pipeline-record", "feedback-open", "feedback-result",
                "intervention-reconcile")))
        # 有链才查链。一份收据都没有 = 这一单还没发生过宿主动作(老任务
        # 升级、迁移前的现场),这条命令本身就是第一环;这时还要求"先有
        # 前驱收据"等于宣布这单的反馈永远打不开,且无命令可补。
        if not predecessor_ok and has_host_receipt(state):
            _die("打开反馈前的持续检视生命周期没有宿主收据，拒绝接着可篡改状态推进")
    loop = _loop(state)
    previous = _batch(loop, batch_id)
    if previous is not None:
        incoming_digest = _result_digest({
            "task_id": payload.get("task_id"),
            "base_sha": payload.get("base_sha"),
            "items": payload.get("items"),
        })
        if previous.get("payload_digest") != incoming_digest:
            _die("批次 %s 的载荷与首次登记不一致，拒绝当作幂等重放" % batch_id)
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": STATE_SCHEMA,
            "idempotent": True,
            "batch_id": batch_id,
            "status": previous.get("status"),
            "current": state.get("current"),
        }, ensure_ascii=False))
        return
    if state.get("current") == "end":
        _die("任务已由 merged close 进入终态，不能再打开反馈")
    if state.get("current") in ("config_confirm", "workflow_select", "branch_create"):
        _die("任务尚未建立完整交付上下文，不能打开持续检视批次")
    base_sha = _text(payload.get("base_sha"), "base_sha", 80)
    head = _head()
    external = ((state.get("quality") or {}).get("external_verification") or {})
    allowed_bases = {head, str(external.get("sha") or "")}
    for existing in loop.get("batches", []):
        if isinstance(existing, dict):
            allowed_bases.add(str(existing.get("base_sha") or ""))
    if base_sha not in allowed_bases:
        _die("base_sha %s 与当前 HEAD/当前交付轮不一致（当前 HEAD %s）"
             % (base_sha[:12], head[:12]))
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        _die("items 必须是非空数组")
    items = [_item(value) for value in raw_items]
    ids = [value["id"] for value in items]
    if len(ids) != len(set(ids)):
        _die("同一批次 items.id 不得重复")
    loop["delivery_round"] = int(loop.get("delivery_round") or 0) + 1
    active_batch = _batch(loop, str(loop.get("active_batch_id") or ""))
    # A RED result for the code produced by the previous batch is itself new
    # feedback. The previous receipts stay immutable/auditable, but it no
    # longer owns the writer; otherwise the RED batch would queue behind a
    # PASS that can never happen and Cloud would livelock on external_verify.
    if active_batch and active_batch.get("status") == "awaiting_verification":
        active_batch["status"] = "addressed"
        active_batch["verification_failed_at"] = time.strftime(
            "%Y-%m-%d %H:%M:%S")
        loop["active_batch_id"] = ""
        clear_feedback_authorization(state)
        active_batch = None
    active = bool(active_batch)
    status = "queued" if active else "repairing"
    record = {
        "batch_id": batch_id,
        "task_id": _text(payload.get("task_id"), "task_id", 200),
        "round": loop["delivery_round"],
        "base_sha": base_sha,
        "opened_at": _text(payload.get("opened_at"), "opened_at", 80),
        "from_step": str(state.get("current") or ""),
        "status": status,
        "items": items,
        "payload_digest": _result_digest({
            "task_id": payload.get("task_id"),
            "base_sha": payload.get("base_sha"),
            "items": payload.get("items"),
        }),
    }
    loop["batches"].append(record)
    old = str(state.get("current") or "")
    if not active:
        loop["active_batch_id"] = batch_id
        issue_feedback_authorization(
            state, batch_id=batch_id, base_sha=base_sha,
            at=record["opened_at"], dirty_paths=api._dirty_paths(),
            allowed_paths=(item.get("file", "") for item in items))
        if old in _WAITING:
            state["current"] = "feedback_triage"
            state.setdefault("step_heads", {})["feedback_triage"] = head
    _history(state, old, "feedback-open:" + batch_id,
             "收到 %s 条反馈；%s" % (len(items), status))
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": STATE_SCHEMA,
        "idempotent": False,
        "batch_id": batch_id,
        "status": status,
        "current": state.get("current"),
        "round": record["round"],
    }, ensure_ascii=False))


def _result_digest(results):
    encoded = json.dumps(results, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _promote(state, loop):
    queued = next((
        item for item in loop.get("batches", [])
        if isinstance(item, dict) and item.get("status") == "queued"
    ), None)
    if queued is None:
        loop["active_batch_id"] = ""
        clear_feedback_authorization(state)
        return None
    queued["status"] = "repairing"
    loop["active_batch_id"] = queued["batch_id"]
    issue_feedback_authorization(
        state, batch_id=queued["batch_id"], base_sha=queued["base_sha"],
        at=queued.get("opened_at", ""), dirty_paths=api._dirty_paths(),
        allowed_paths=(item.get("file", "")
                       for item in queued.get("items", [])))
    return queued


def complete_verified_feedback(state, verified_sha):
    """Close an addressed code-changing batch after authoritative PASS."""
    loop = state.get("delivery_loop") or {}
    batch = _batch(loop, str(loop.get("active_batch_id") or ""))
    if not batch or batch.get("status") != "awaiting_verification":
        return False
    batch["status"] = "closed"
    batch["verified_sha"] = str(verified_sha or "")
    batch["closed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    for previous in loop.get("batches", []):
        if isinstance(previous, dict) and previous.get("status") == "addressed":
            previous["status"] = "closed"
            previous["verified_sha"] = str(verified_sha or "")
            previous["closed_at"] = batch["closed_at"]
    _history(state, state.get("current", ""),
             "feedback-verified:" + batch["batch_id"],
             "权威验证通过 %s" % str(verified_sha or "")[:12])
    return bool(_promote(state, loop))


def _result(flow, state, args):
    del flow
    payload = _payload(args.file, RESULT_SCHEMA)
    proof_nonce = _verify_host_proof(state, args, "feedback-result", payload)
    _capability(state)
    if (host_managed_continuous_review()
            and not trusted_active_batch(state, (
                "feedback-open", "pipeline-record", "feedback-result"))):
        _die("登记结果前的反馈生命周期没有宿主收据，拒绝接着可篡改状态推进")
    batch_id = _text(payload.get("batch_id"), "batch_id", 200)
    loop = _loop(state)
    batch = _batch(loop, batch_id)
    if batch is None:
        _die("找不到反馈批次 %s" % batch_id)
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        _die("results 必须是数组")
    results = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            _die("results 每一项必须是 JSON object")
        status = _text(raw.get("status"), "results.status", 40)
        if status not in _RESULTS:
            _die("results.status 只能是 " + "/".join(sorted(_RESULTS)))
        results.append({
            "id": _text(raw.get("id"), "results.id", 200),
            "status": status,
            "summary": _text(raw.get("summary"), "results.summary", 4000),
            "evidence": _text(raw.get("evidence"), "results.evidence", 4000,
                              required=False),
        })
    expected = {item["id"] for item in batch.get("items", [])}
    actual = {item["id"] for item in results}
    if len(actual) != len(results) or actual != expected:
        _die("逐条回执必须精确覆盖本批反馈。缺少: %s；夹带: %s"
             % ("、".join(sorted(expected - actual)) or "无",
                "、".join(sorted(actual - expected)) or "无"))
    digest = _result_digest(results)
    if batch.get("result_digest"):
        if batch.get("result_digest") != digest:
            _die("批次 %s 已登记不同结果，拒绝覆盖" % batch_id)
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": STATE_SCHEMA, "idempotent": True,
            "batch_id": batch_id, "status": batch.get("status"),
            "current": state.get("current"),
        }, ensure_ascii=False))
        return
    if batch_id != str(loop.get("active_batch_id") or ""):
        _die("反馈批次 %s 尚未取得唯一 writer，不能提前登记处理结果"
             % batch_id)
    head = _head()
    declared_changed = bool(payload.get("changed"))
    changed = declared_changed or head != batch.get("base_sha")
    batch["results"] = results
    batch["result_digest"] = digest
    batch["result_head"] = head
    batch["result_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    if any(item["status"] == "needs_human" for item in results):
        batch["status"] = "needs_human"
    elif changed:
        clear_stale_evidence(state)
        batch["status"] = "awaiting_verification"
        if state.get("current") == "feedback_triage":
            state["current"] = "build"
            state.setdefault("step_heads", {})["build"] = head
    else:
        batch["status"] = "closed"
        batch["closed_at"] = batch["result_at"]
        promoted = _promote(state, loop)
        state["current"] = "feedback_triage" if promoted else "delivery_watch"
        state.setdefault("step_heads", {})[state["current"]] = head
    _history(state, str(batch.get("from_step") or ""),
             "feedback-result:" + batch_id,
             "%s；HEAD %s" % (batch["status"], head[:12]))
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": STATE_SCHEMA,
        "idempotent": False,
        "batch_id": batch_id,
        "status": batch["status"],
        "current": state.get("current"),
        "changed": changed,
    }, ensure_ascii=False))


def _close(flow, state, args):
    proof_payload = {
        "reason": args.reason,
        "sha": args.sha,
        "event_id": args.event_id,
    }
    proof_nonce = _verify_host_proof(state, args, "close", proof_payload)
    _capability(state)
    if args.reason != "merged":
        _die("close 当前只接受 --reason merged")
    event_id = _text(args.event_id, "event_id", 200)
    loop = _loop(state)
    previous = next((
        item for item in loop.get("close_events", [])
        if isinstance(item, dict) and item.get("event_id") == event_id
    ), None)
    if previous is not None:
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({**previous, "idempotent": True}, ensure_ascii=False))
        return
    verified = external_facts(state)
    verified_sha = str(verified.get("sha") or "")
    # 两条分支原来走的是两个语义不同的函数:else 分支拿"外部验证事实"
    # 去和"生命周期投影"逐字比对,永远不可能相等——只要走到那条路就是
    # 必死的 close。收据校验只有一种正确形态,不再留第二条。
    #
    # 有过流水线收据才拿收据说话。这一单的 PASS 若登记在能力链之前
    # (老任务、迁移现场),它永远拿不出 pipeline-record 收据;此时还要
    # 求"没收据就不许 close",等于宣布 MR 合入了任务也永远关不掉,而
    # 合入本身是远端事实、迁移时宿主已核对过这份 PASS 绑当前 HEAD。
    if (not trusted_pipeline_projection(state, verified)
            and has_receipt_for(state, "pipeline-record")):
        _die("当前流水线 PASS 没有 Cloud 宿主权威收据，拒绝 close")
    if verified.get("verdict") != "PASS" or args.sha != verified_sha:
        _die("合入源 SHA %s 没有当前权威 PASS 背书（最近验证 %s）"
             % (str(args.sha)[:12], verified_sha[:12] or "无"))
    if not flow.get("steps", {}).get("end", {}).get("terminal"):
        _die("内核流程缺少终态 end")
    dirty = list(api._dirty_paths())
    local_head = _head()
    unpushed_commits = collect_unpushed_commits(verified_sha, local_head, _die)
    old = str(state.get("current") or "")
    event = {
        "schema": STATE_SCHEMA,
        "event_id": event_id,
        "reason": "merged",
        "sha": str(args.sha),
        "local_head": local_head,
        "unpushed_local_commits": unpushed_commits,
        "closed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "unpushed_local_paths": dirty,
        "idempotent": False,
    }
    loop["close_events"].append(event)
    loop["active_batch_id"] = ""
    for batch in loop.get("batches", []):
        if isinstance(batch, dict) and batch.get("status") not in ("closed",):
            batch["status"] = "superseded_by_merge"
    clear_feedback_authorization(state)
    state.pop("external_repair_authorization", None)
    state["current"] = "end"
    _history(state, old, "delivery-close:merged", "MR 已合入 %s" % args.sha[:12])
    save_with_host_proof(state, proof_nonce)
    print(json.dumps(event, ensure_ascii=False))


def cmd_delivery(flow, state, args):
    if args.delivery_action == "feedback-open":
        return _open(flow, state, args)
    if args.delivery_action == "feedback-result":
        return _result(flow, state, args)
    if args.delivery_action == "close":
        return _close(flow, state, args)
    if args.delivery_action == "attest":
        return attest_host_receipts(state, args)
    _die("未知动作")
