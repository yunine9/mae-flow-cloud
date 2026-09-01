"""Cryptographic capability for Cloud-owned delivery commands.

The Agent can invoke the public Mae-Flow CLI, so command spelling is never an
authorization boundary.  Cloud keeps the RSA private key outside the mounted
task workspace and pins only the public key in the task state.  Every host
mutation therefore carries a short-lived, task/action/payload-bound proof.
"""

import base64
import hashlib
import hmac
import json
import stat

from .shared import os, time
from .wiring import api


PROOF_SCHEMA = "mae-flow-host-proof/1"
AUTHORITY_SCHEMA = "mae-flow-host-authority/1"
_RSA_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _die(message):
    api.die("delivery: " + message, 2)


def _text(value, name, limit):
    result = str(value or "").strip()
    if not result:
        _die("%s 不能为空" % name)
    if len(result) > limit:
        _die("%s 超过 %s 字符" % (name, limit))
    return result


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _secure_mode(info, expected, label):
    mode = stat.S_IMODE(info.st_mode)
    if mode != expected:
        _die("%s 权限必须是 %s，当前是 %s" % (
            label, oct(expected), oct(mode)))
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        _die("%s 不属于当前宿主进程" % label)


def _secure_directory(path, label):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
    except OSError as exc:
        _die("无法读取%s %s: %s" % (label, absolute, exc))
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        _die("%s必须是真实目录" % label)
    if os.path.realpath(absolute) != absolute:
        _die("%s不能经过符号链接" % label)
    _secure_mode(info, 0o700, label)
    return absolute


def _secure_file(path, label, limit=32 * 1024):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
    except OSError as exc:
        _die("无法读取%s %s: %s" % (label, absolute, exc))
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        _die("%s必须是普通文件" % label)
    if os.path.realpath(absolute) != absolute:
        _die("%s不能经过符号链接" % label)
    if info.st_size > limit:
        _die("%s过大" % label)
    _secure_mode(info, 0o600, label)
    return absolute


def _capability_root():
    """Locate the host-only trust root without trusting task state or args.

    Production repositories live at ``<data>/<task>/<repo>`` and the Cloud
    trust root at ``<data>/.host-capabilities``.  The contract fixture runs a
    repository directly as its workspace, so it uses the one-level fallback.
    If the production root exists it always wins; an Agent-created inner
    directory can therefore only cause a visible refusal, never become trust.
    """
    project = os.path.realpath(os.getcwd())
    workspace = os.path.dirname(project)
    candidates = (
        os.path.join(os.path.dirname(workspace), ".host-capabilities"),
        os.path.join(workspace, ".host-capabilities"),
    )
    for candidate in candidates:
        if os.path.lexists(candidate):
            root = _secure_directory(candidate, "宿主信任根")
            try:
                if os.path.commonpath((project, root)) == project:
                    _die("宿主信任根不能位于 Agent 工作区")
            except ValueError:
                _die("宿主信任根与任务工作区不在同一文件系统")
            return root
    _die("当前任务找不到 Cloud 宿主信任根，拒绝宿主命令")


def _read_json_file(path, label):
    absolute = _secure_file(path, label)
    try:
        with open(absolute, "r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _die("无法读取%s %s: %s" % (label, absolute, exc))


def _proof_payload(path):
    root = _capability_root()
    absolute = os.path.abspath(path)
    if os.path.dirname(absolute) != root:
        _die("宿主凭据不在 Cloud 宿主信任根内")
    value = _read_json_file(absolute, "宿主凭据")
    if not isinstance(value, dict) or value.get("schema") != PROOF_SCHEMA:
        _die("宿主凭据 schema 必须是 %s" % PROOF_SCHEMA)
    nonce = _text(value.get("nonce"), "proof.nonce", 200)
    if os.path.basename(absolute) != "proof-%s.json" % nonce:
        _die("宿主凭据文件名与 nonce 不匹配")
    return value, root


def _b64url(value):
    encoded = str(value or "").encode("ascii")
    return base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))


def _verify_rsa_sha256(authority, message, signature):
    try:
        modulus = int.from_bytes(_b64url(authority.get("n")), "big")
        exponent = int.from_bytes(_b64url(authority.get("e")), "big")
        signed = int.from_bytes(_b64url(signature), "big")
        if modulus <= 0 or exponent <= 0 or signed >= modulus:
            return False
        size = (modulus.bit_length() + 7) // 8
        encoded = pow(signed, exponent, modulus).to_bytes(size, "big")
    except (TypeError, ValueError, OverflowError):
        return False
    digest_info = _RSA_SHA256_PREFIX + hashlib.sha256(message).digest()
    if len(encoded) < len(digest_info) + 11 or not encoded.startswith(b"\x00\x01"):
        return False
    separator = encoded.find(b"\x00", 2)
    if separator < 10 or any(value != 0xff for value in encoded[2:separator]):
        return False
    return hmac.compare_digest(encoded[separator + 1:], digest_info)


def _trusted_authority(state, proof, root):
    task_id = _text(proof.get("task_id"), "proof.task_id", 200)
    name = hashlib.sha256(task_id.encode("utf-8")).hexdigest() + ".json"
    stored = _read_json_file(os.path.join(root, name), "宿主能力")
    if not isinstance(stored, dict) or stored.get("schema") != \
            "mae-flow-host-capability/1":
        _die("宿主能力文件格式损坏")
    authority = stored.get("authority")
    if not isinstance(authority, dict) or authority.get("schema") != \
            AUTHORITY_SCHEMA or authority.get("alg") != "RS256":
        _die("宿主能力没有有效的 RS256 公钥")
    if str(authority.get("task_id") or "") != task_id:
        _die("宿主能力绑定的任务不匹配")
    try:
        modulus = int.from_bytes(_b64url(authority.get("n")), "big")
        exponent = int.from_bytes(_b64url(authority.get("e")), "big")
    except (TypeError, ValueError, UnicodeError):
        _die("宿主能力公钥编码无效")
    if modulus.bit_length() < 2048 or exponent != 65537:
        _die("宿主能力公钥必须是 2048 位以上 RSA 且 e=65537")
    expected_key_id = hashlib.sha256((
        "%s.%s" % (authority.get("n"), authority.get("e"))
    ).encode("utf-8")).hexdigest()[:24]
    if not hmac.compare_digest(str(authority.get("key_id") or ""),
                               expected_key_id):
        _die("宿主能力 key_id 与公钥不匹配")
    pinned = (state.get("execution_contract") or {}).get("host_authority")
    if not isinstance(pinned, dict) or not hmac.compare_digest(
            _canonical(pinned), _canonical(authority)):
        _die("任务状态中的宿主公钥与 Cloud 信任根不一致，拒绝执行")
    return authority


def verify_host_proof(state, proof_path, action, payload):
    proof, root = _proof_payload(proof_path)
    authority = _trusted_authority(state, proof, root)
    unsigned = {
        "schema": PROOF_SCHEMA,
        "task_id": _text(proof.get("task_id"), "proof.task_id", 200),
        "action": _text(proof.get("action"), "proof.action", 40),
        "payload_digest": _text(
            proof.get("payload_digest"), "proof.payload_digest", 128),
        "nonce": _text(proof.get("nonce"), "proof.nonce", 200),
        "issued_at": int(proof.get("issued_at") or 0),
    }
    if unsigned["task_id"] != str(authority.get("task_id") or ""):
        _die("宿主凭据绑定的任务不匹配")
    if unsigned["action"] != action:
        _die("宿主凭据绑定的动作不匹配")
    expected = hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()
    if not hmac.compare_digest(unsigned["payload_digest"], expected):
        _die("宿主凭据绑定的载荷摘要不匹配")
    now = int(time.time())
    if unsigned["issued_at"] < now - 120 or unsigned["issued_at"] > now + 30:
        _die("宿主凭据已过期或时间异常")
    if unsigned["nonce"] in state.setdefault("host_capability_nonces", []):
        _die("宿主凭据已经消费，拒绝重放")
    signature = _text(proof.get("signature"), "proof.signature", 8192)
    if authority.get("alg") != "RS256" or not _verify_rsa_sha256(
            authority, _canonical(unsigned).encode("utf-8"), signature):
        _die("宿主凭据签名无效")
    return {
        "root": root,
        "proof": {**unsigned, "signature": signature},
        "payload": payload,
    }


def _batch_projection(state, batch_id, result=False):
    loop = state.get("delivery_loop") or {}
    batch = next((item for item in loop.get("batches", [])
                  if isinstance(item, dict)
                  and str(item.get("batch_id") or "") == str(batch_id)), None)
    if not batch:
        return None
    keys = (("batch_id", "task_id", "base_sha", "opened_at", "items",
             "payload_digest") if not result else
            ("batch_id", "base_sha", "results", "result_digest",
             "result_head", "result_at"))
    return {key: batch.get(key) for key in keys}


def host_projection(state, action, payload):
    """Stable authority-owned projection for a host mutation receipt."""
    if action == "feedback-open":
        if payload.get("mode") == "adopt-watch":
            return {
                "migration_id": payload.get("batch_id"),
                "current": state.get("current"),
                "continuous_review": bool((state.get("execution_contract") or {})
                                          .get("continuous_review")),
            }
        return _batch_projection(state, payload.get("batch_id"))
    if action == "feedback-result":
        return _batch_projection(state, payload.get("batch_id"), result=True)
    if action == "close":
        loop = state.get("delivery_loop") or {}
        event_id = str(payload.get("event_id") or "")
        return next((item for item in loop.get("close_events", [])
                     if isinstance(item, dict)
                     and str(item.get("event_id") or "") == event_id), None)
    if action == "pipeline-record":
        return (state.get("quality") or {}).get("external_verification")
    if action == "intervention-reconcile":
        return state.get("user_intervention")
    return None


def _receipt_path(root, task_id, nonce):
    if not all(char.isalnum() or char in "-_" for char in nonce):
        _die("宿主凭据 nonce 格式不合法")
    task_hash = hashlib.sha256(task_id.encode("utf-8")).hexdigest()
    return os.path.join(root, "%s.receipt-%s.json" % (task_hash, nonce))


def _write_receipt(context, projection):
    proof = context["proof"]
    path = _receipt_path(context["root"], proof["task_id"], proof["nonce"])
    record = {
        "schema": "mae-flow-host-receipt/1",
        "proof": proof,
        "payload": context["payload"],
        "projection": projection,
        "projection_digest": hashlib.sha256(
            _canonical(projection).encode("utf-8")).hexdigest(),
        "recorded_at": int(time.time()),
    }
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(_canonical(record) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        _die("无法落盘宿主权威收据: %s" % exc)


def _valid_stored_receipt(state, record, action, projection, root):
    if not isinstance(record, dict) or record.get("schema") != \
            "mae-flow-host-receipt/1":
        return False
    proof = record.get("proof")
    payload = record.get("payload")
    if not isinstance(proof, dict) or proof.get("action") != action:
        return False
    authority = _trusted_authority(state, proof, root)
    unsigned = {key: proof.get(key) for key in (
        "schema", "task_id", "action", "payload_digest", "nonce", "issued_at")}
    signature = str(proof.get("signature") or "")
    if (unsigned.get("schema") != PROOF_SCHEMA
            or not _verify_rsa_sha256(
                authority, _canonical(unsigned).encode("utf-8"), signature)):
        return False
    payload_digest = hashlib.sha256(
        _canonical(payload).encode("utf-8")).hexdigest()
    projection_digest = hashlib.sha256(
        _canonical(projection).encode("utf-8")).hexdigest()
    return (hmac.compare_digest(str(unsigned.get("payload_digest") or ""),
                                payload_digest)
            and hmac.compare_digest(str(record.get("projection_digest") or ""),
                                    projection_digest)
            and hmac.compare_digest(
                _canonical(record.get("projection")).encode("utf-8"),
                _canonical(projection).encode("utf-8")))


def trusted_projection(state, action, projection):
    """Verify a state projection against a host-only durable receipt."""
    root = _capability_root()
    authority = (state.get("execution_contract") or {}).get("host_authority") or {}
    task_id = str(authority.get("task_id") or "")
    if not task_id:
        return False
    prefix = hashlib.sha256(task_id.encode("utf-8")).hexdigest() + ".receipt-"
    for name in reversed(sorted(os.listdir(root))):
        if not name.startswith(prefix) or not name.endswith(".json"):
            continue
        try:
            record = _read_json_file(
                os.path.join(root, name), "宿主权威收据")
            if _valid_stored_receipt(state, record, action, projection, root):
                return True
        except SystemExit:
            raise
    return False


def save_with_host_proof(state, context):
    nonce = context["proof"]["nonce"]
    consumed = state.setdefault("host_capability_nonces", [])
    consumed.append(nonce)
    # Proofs expire in two minutes. A bounded replay window is sufficient and
    # prevents the task state growing forever during a long-lived MR.
    if len(consumed) > 256:
        del consumed[:-256]
    api.save_state(state)
    projection = host_projection(
        state, context["proof"]["action"], context["payload"])
    if projection is None:
        _die("宿主命令没有形成可核对的权威投影")
    _write_receipt(context, projection)
