"""Durable host receipts: what one Cloud host action sealed, and how it is
verified later.

分工:host_capability 回答"这条命令是不是宿主发的"(信任根、绑定、签名);
本模块回答"宿主上一次把这一单封成了什么样"(投影、落盘、回溯核对)。
两者拆开是因为它们的失败语义必须不同——鉴权 fail-closed,历史台账
体检 fail-soft(读不动的旧收据跳过接着找,不许升级成拒绝服务)。
"""

import hashlib
import hmac
import json
import stat

from .shared import os, time
from .wiring import api
from .host_capability import (
    PROOF_SCHEMA, _bound_task_id, _canonical, _capability_root, _die,
    _trusted_authority, _verify_rsa_sha256)

LIFECYCLE_SCHEMA = "mae-flow-host-lifecycle/2"
RECEIPT_SCHEMA = "mae-flow-host-receipt/1"
# 收据现在只封摘要,恒定几百字节;上限留给"写坏了/被人塞了别的东西"。
_RECEIPT_LIMIT = 32 * 1024


def _digest(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def external_facts(state):
    """The one normalization both writer and verifier must share."""
    return ((state.get("quality") or {}).get("external_verification")) or {}


def _active_batch(loop):
    if not isinstance(loop, dict):
        return None
    active_id = str(loop.get("active_batch_id") or "")
    if not active_id:
        return None
    return next((item for item in loop.get("batches", [])
                 if isinstance(item, dict)
                 and str(item.get("batch_id") or "") == active_id), None)


def host_projection(state, action, payload):
    """Seal the complete lifecycle produced by one host mutation.

    A receipt for only ``PASS`` or ``results`` can be spliced together with an
    Agent-written ``current``/``status``.  Every host action therefore seals the
    same indivisible lifecycle projection; later legitimate host actions simply
    emit a newer complete projection.

    2026-09-01 勘误:投影原来把**整份 delivery_loop 与逐条意见正文**封进
    收据。写盘不限体积、读回限 32 KiB,一轮 12 条 350 字的 MR 检视(内核
    自己允许单条 4000 字)就越线;之后 feedback-open / feedback-result /
    pipeline record 乃至 MR 合入后的 close 全部永久失败,而且**制造死锁
    的那条命令自己报成功**,没有任何命令能救回来(实测复现)。改封摘要:
    防篡改强度一个字节没松,体积从此恒定。
    """
    if action not in ("feedback-open", "feedback-result", "close",
                      "pipeline-record", "intervention-reconcile"):
        return None
    loop = state.get("delivery_loop")
    loop = loop if isinstance(loop, dict) else None
    return {
        "schema": LIFECYCLE_SCHEMA,
        "action": action,
        "current": state.get("current"),
        "active_batch_id": (loop or {}).get("active_batch_id") if loop else None,
        "delivery_loop_digest": _digest(loop),
        "active_batch_digest": _digest(_active_batch(loop)),
        "external_verification_digest": _digest(external_facts(state)),
        "user_intervention_digest": _digest(state.get("user_intervention")),
    }


def _receipt_prefix(task_id):
    """Receipts belong to (task, workspace), not to a bare task id.

    信任根是按部署共享的目录:同一个任务号在另一份代码仓里(重建、
    夹具、诊断克隆)会读到不属于它的历史收据,于是"生命周期投影对不上"
    ——一单被另一单的陈账挡死。把工作区一起算进归属,串味从此不可能。
    """
    identity = "%s\0%s" % (task_id, os.path.realpath(os.getcwd()))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest() + ".receipt-"


def _receipt_path(root, task_id, nonce):
    if not all(char.isalnum() or char in "-_" for char in nonce):
        _die("宿主凭据 nonce 格式不合法")
    return os.path.join(root, "%s%s.json" % (_receipt_prefix(task_id), nonce))


def _stage_receipt(context, projection):
    """Durably stage the receipt **before** the state it seals is saved.

    2026-09-01 勘误:原来是先 save_state 再落收据。中间失败一次就留下
    "状态已推进、收据不存在"的账,而所有 trusted_* 都要求存在收据——
    宿主从此被自己锁在门外。现在先把收据 fsync 到同目录临时文件,
    状态存住了才原子改名;存不住就把临时文件删掉,不留孤儿收据
    (孤儿收据会给 Agent 伪造状态提供现成背书)。
    """
    proof = context["proof"]
    path = _receipt_path(context["root"], proof["task_id"], proof["nonce"])
    record = {
        "schema": RECEIPT_SCHEMA,
        "proof": proof,
        # 只留摘要。原来这里逐字存整份 payload——一批 12 条 350 字的
        # 检视意见就把收据顶到 16 KiB,和当初封整份 delivery_loop 是
        # 同一个体积漏口。摘要够用:proof 已被签名绑住 payload_digest,
        # 载荷原文本来就在任务状态与事实文件里。
        "payload_digest": _digest(context["payload"]),
        "projection": projection,
        "projection_digest": _digest(projection),
        "recorded_at": int(time.time()),
    }
    staged = path + ".staged"
    try:
        descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(_canonical(record) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        _die("无法落盘宿主权威收据: %s" % exc)
    return staged, path


def _readable_receipt(path):
    """Read one historical receipt, or ``None`` when it cannot be trusted.

    2026-09-01 勘误:这三个扫描函数原来对每一份历史收据都走严格
    _read_json_file,权限被动过、体积超限、写坏了任何一条都会 SystemExit
    掀掉整条宿主命令——反馈、流水线登记、连 MR 合入后的 close 一起永久
    失败,且无命令可救。鉴权仍旧 fail-closed(签名、载荷摘要、投影逐字
    比对一个都没松);松掉的只是"读不动的旧文件跳过去接着找"。
    """
    try:
        absolute = os.path.abspath(path)
        info = os.lstat(absolute)
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)
                or os.path.realpath(absolute) != absolute
                or info.st_size > _RECEIPT_LIMIT
                or stat.S_IMODE(info.st_mode) != 0o600
                or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
            return None
        with open(absolute, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _scan_receipts(state):
    """Yield every readable receipt of the bound task, newest name first.

    The authority is resolved once: it is the same public key for every receipt
    of one task, and hoisting it keeps the per-record loop incapable of dying.
    """
    root = _capability_root()
    task_id = _bound_task_id(root)
    authority = _trusted_authority(state, {"task_id": task_id}, root)
    prefix = _receipt_prefix(task_id)
    try:
        names = sorted(os.listdir(root))
    except OSError as exc:
        _die("无法读取 Cloud 宿主信任根: %s" % exc)
    for name in reversed(names):
        if not name.startswith(prefix) or not name.endswith(".json"):
            continue
        record = _readable_receipt(os.path.join(root, name))
        if record is not None:
            yield authority, record


def _valid_stored_receipt(authority, record, action, projection):
    if record.get("schema") != RECEIPT_SCHEMA:
        return False
    proof = record.get("proof")
    if not isinstance(proof, dict) or proof.get("action") != action:
        return False
    if str(proof.get("task_id") or "") != str(authority.get("task_id") or ""):
        return False
    unsigned = {key: proof.get(key) for key in (
        "schema", "task_id", "action", "payload_digest", "nonce", "issued_at")}
    signature = str(proof.get("signature") or "")
    if (unsigned.get("schema") != PROOF_SCHEMA
            or not _verify_rsa_sha256(
                authority, _canonical(unsigned).encode("utf-8"), signature)):
        return False
    # 载荷摘要以**被签名的那份**为准;收据里那份只是同一事实的副本,
    # 两者必须一致,谁也不能单独改。
    return (hmac.compare_digest(str(record.get("payload_digest") or ""),
                                str(unsigned.get("payload_digest") or ""))
            and hmac.compare_digest(str(record.get("projection_digest") or ""),
                                    _digest(projection))
            and hmac.compare_digest(
                _canonical(record.get("projection")).encode("utf-8"),
                _canonical(projection).encode("utf-8")))


def trusted_projection(state, action, projection):
    """Verify a state projection against a host-only durable receipt."""
    for authority, record in _scan_receipts(state):
        if _valid_stored_receipt(authority, record, action, projection):
            return True
    return False


def has_receipt_for(state, action):
    """Whether this task ever produced a valid receipt for one host action."""
    for authority, record in _scan_receipts(state):
        proof = record.get("proof")
        stored = record.get("projection")
        if (isinstance(proof, dict) and proof.get("action") == action
                and isinstance(stored, dict)
                and _valid_stored_receipt(authority, record, action, stored)):
            return True
    return False


def has_host_receipt(state):
    """Whether this task has ever produced a host receipt at all.

    第一条宿主动作必须有权开链。收据落在 Agent 够不着的信任根里
    (0600、工作区之外),"一份都没有"只可能是"这个任务还没发生过宿主
    动作"——老任务升级、迁移前的现场、刚建的任务——不可能是 Agent 把
    它们删干净了。要求"开链之前先有链"只会把宿主自己锁在门外:反馈
    永远打不开,而且没有任何命令能补开第一环。
    """
    for _authority, _record in _scan_receipts(state):
        return True
    return False


def trusted_current_lifecycle(state, actions):
    """Require an exact signed predecessor before another host transition."""
    return any(trusted_projection(
        state, action, host_projection(state, action, {}))
        for action in actions)


def trusted_pipeline_projection(state, projection):
    """Verify the exact pipeline fact inside an authentic pipeline receipt.

    Later feedback legitimately changes ``current`` and ``delivery_loop``. The
    original pipeline receipt remains authoritative for its immutable quality
    projection, while ready/terminal attestations still require a separate
    full-lifecycle receipt for their current state.
    """
    wanted = _digest(projection or {})
    for authority, record in _scan_receipts(state):
        stored = record.get("projection")
        if (isinstance(stored, dict)
                and hmac.compare_digest(
                    str(stored.get("external_verification_digest") or ""), wanted)
                and _valid_stored_receipt(
                    authority, record, "pipeline-record", stored)):
            return True
    return False


def trusted_active_batch(state, actions):
    """Verify active_batch_id and the complete active batch against a receipt.

    Agent work may legitimately move ``current`` between host calls, but it may
    not rewrite which feedback owns the writer or any field of that batch.
    """
    loop = state.get("delivery_loop") or {}
    active_id = str(loop.get("active_batch_id") or "")
    active = _active_batch(loop)
    if not active_id or active is None:
        return False
    wanted = _digest(active)
    for authority, record in _scan_receipts(state):
        stored = record.get("projection")
        if not isinstance(stored, dict):
            continue
        proof = record.get("proof")
        action = str((proof or {}).get("action") or "") \
            if isinstance(proof, dict) else ""
        if (action in actions
                and stored.get("active_batch_id") == active_id
                and hmac.compare_digest(
                    str(stored.get("active_batch_digest") or ""), wanted)
                and _valid_stored_receipt(authority, record, action, stored)):
            return True
    return False


def save_with_host_proof(state, context):
    nonce = context["proof"]["nonce"]
    consumed = state.setdefault("host_capability_nonces", [])
    consumed.append(nonce)
    # Proofs expire in two minutes. A bounded replay window is sufficient and
    # prevents the task state growing forever during a long-lived MR.
    if len(consumed) > 256:
        del consumed[:-256]
    projection = host_projection(
        state, context["proof"]["action"], context["payload"])
    if projection is None:
        _die("宿主命令没有形成可核对的权威投影")
    staged, path = _stage_receipt(context, projection)
    try:
        api.save_state(state)
    except BaseException:
        try:
            os.unlink(staged)
        except OSError:
            pass
        raise
    try:
        os.rename(staged, path)
    except OSError as exc:
        _die("无法落盘宿主权威收据: %s" % exc)
