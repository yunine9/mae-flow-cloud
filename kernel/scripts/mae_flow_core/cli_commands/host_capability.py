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


def _proof_payload(path):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
        if os.path.islink(absolute) or not os.path.isfile(absolute):
            raise ValueError("凭据必须是普通文件")
        if info.st_size > 32 * 1024:
            raise ValueError("凭据文件过大")
        with open(absolute, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _die("无法读取宿主凭据 %s: %s" % (absolute, exc))
    if not isinstance(value, dict) or value.get("schema") != PROOF_SCHEMA:
        _die("宿主凭据 schema 必须是 %s" % PROOF_SCHEMA)
    return value


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


def verify_host_proof(state, proof_path, action, payload):
    authority = (state.get("execution_contract") or {}).get("host_authority")
    if not isinstance(authority, dict) or authority.get("schema") != AUTHORITY_SCHEMA:
        _die("当前任务没有固定 Cloud 宿主公钥，拒绝宿主命令")
    proof = _proof_payload(proof_path)
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
    return unsigned["nonce"]


def save_with_host_proof(state, nonce):
    consumed = state.setdefault("host_capability_nonces", [])
    consumed.append(nonce)
    # Proofs expire in two minutes. A bounded replay window is sufficient and
    # prevents the task state growing forever during a long-lived MR.
    if len(consumed) > 256:
        del consumed[:-256]
    api.save_state(state)
