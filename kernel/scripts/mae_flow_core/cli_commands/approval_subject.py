"""Immutable subjects for human approval cards at the CLI/Git boundary.

An answer proves consent only for the exact files that were presented.  This
module deliberately hashes content rather than mtimes so edit-then-restore and
same-second writes cannot reuse a stale approval.
"""

import hashlib
import json
import os
import subprocess

from mae_flow_core.foundation.fingerprints import review_path_fingerprint
from mae_flow_core.orchestration.work_package import resolve_ticket_segment


# These files describe Mae-Flow's own runtime, not the code/document change a
# person is reviewing.  In particular, saving ``approval_subject`` updates
# .mae-flow.json; hashing that file would invalidate a card merely by creating
# it and can trap the Agent in an endless "show -> answer -> stale" loop.
_FLOW_CONTROL_PATHSPECS = (
    ":(exclude).mae-flow.json",
    ":(exclude).mae-flow.json.*",
    ":(exclude).mae-flow-history.jsonl",
    ":(exclude).mae-flow-need-reload",
    ":(exclude).mae-flow",
    ":(exclude).mae-flow/**",
    ":(exclude).mae-flow-work",
    ":(exclude).mae-flow-work/**",
    ":(exclude).codecheckcli",
    ":(exclude).codecheckcli/**",
    ":(exclude).mae-flow-order.json",
    ":(exclude).mae-flow-chain.md",
    ":(exclude).mae-flow-defaults.json",
)


def _git(root, *args, binary=False):
    result = subprocess.run(
        ["git", "-C", root] + list(args), capture_output=True,
        text=not binary, check=False)
    if result.returncode:
        error = result.stderr
        if isinstance(error, bytes):
            error = error.decode("utf-8", errors="replace")
        raise RuntimeError((error or "git command failed").strip())
    return result.stdout


def _package_paths(root, state, names):
    ticket = str(((state or {}).get("config") or {}).get("单号", "")).strip()
    if not ticket:
        raise RuntimeError("缺少单号，无法定位待审批产物")
    segment = resolve_ticket_segment(root, ticket)
    folder = os.path.join(os.path.abspath(root), ".mae-flow-work", segment)
    return [os.path.join(folder, name + ".md") for name in names]


def _artifact_payload(root, state, spec):
    paths = _package_paths(root, state, spec.get("artifacts") or ())
    missing = [path for path in paths if not os.path.isfile(path)]
    if missing:
        raise RuntimeError("待审批产物尚未生成: " + "、".join(
            os.path.relpath(path, root) for path in missing))
    return {
        "kind": "artifacts",
        "paths": [os.path.relpath(path, root).replace(os.sep, "/")
                  for path in paths],
        "fingerprints": [review_path_fingerprint(path) for path in paths],
    }


def _review_base(state, step_id):
    return str((state or {}).get("implementation_base_head", "") or "HEAD")


def _manifest_scope(state):
    """交付清单文件集。清单存在时它就是审批对象的全部范围。"""
    manifest = (state or {}).get("delivery_manifest") or {}
    paths = [str(path) for path in (manifest.get("files") or ())
             if isinstance(path, str) and str(path).strip()]
    return sorted(set(paths))


def _worktree_payload(root, state, step_id):
    """工作区审批对象。

    2026-08-29 用户拍板:有交付清单时,人批的是**清单那组文件的内容与
    集合**,不是整个工作区的每个字节——清单外的残留构建产物、临时
    文件怎么变都不作废批复("产物留工作区别删"与"确认绑文件集合"
    两条口径在此对齐);清单内内容变了、清单增删了文件仍然作废
    (旧决定不背书新代码,这条红线不动)。因此收窄模式下:
    - pathspec 限定为清单精确路径(清单归一化已禁 glob/魔法前缀);
    - `head` 不进哈希——流水线修复在清单外推进 commit 不该打人;
    - 暂存状态不进哈希——同样的内容 staged/unstaged 之别与检视无关,
      内容差异由 diff(worktree vs base)与逐文件指纹兜住。
    没有清单的步骤(如 build_review)保持整工作区绑定的老语义。
    """
    base = _review_base(state, step_id)
    head = str(_git(root, "rev-parse", "--verify", "HEAD")).strip()
    scope = _manifest_scope(state)
    if scope:
        diff = _git(root, "diff", "--binary", "--no-ext-diff", base, "--",
                    *scope, binary=True)
        return {
            "kind": "worktree",
            "scope": "delivery_manifest",
            "base": base,
            "paths": scope,   # 集合本身进哈希:清单增删文件即新卡
            "diff_sha256": hashlib.sha256(diff).hexdigest(),
            "path_fingerprints": [
                review_path_fingerprint(os.path.join(root, path))
                for path in scope
            ],
        }
    review_paths = (".",) + _FLOW_CONTROL_PATHSPECS
    diff = _git(root, "diff", "--binary", "--no-ext-diff", base, "--",
                *review_paths, binary=True)
    status = _git(
        root, "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--", *review_paths, binary=True)
    untracked = _git(
        root, "ls-files", "--others", "--exclude-standard", "-z",
        "--", *review_paths, binary=True)
    paths = [item.decode("utf-8", errors="surrogateescape")
             for item in untracked.split(b"\0") if item]
    return {
        "kind": "worktree",
        "base": base,
        "head": head,
        "diff_sha256": hashlib.sha256(diff).hexdigest(),
        "status_sha256": hashlib.sha256(status).hexdigest(),
        "untracked": paths,
        "untracked_fingerprints": [
            review_path_fingerprint(os.path.join(root, path)) for path in paths
        ],
    }


def build_subject(root, state, step_id, step):
    spec = (step or {}).get("approval_subject")
    if not isinstance(spec, dict):
        return None
    kind = str(spec.get("kind", ""))
    if kind == "artifacts":
        payload = _artifact_payload(root, state, spec)
    elif kind == "worktree":
        payload = _worktree_payload(root, state, step_id)
    else:
        raise RuntimeError("未知审批对象类型: " + (kind or "空"))
    payload.update({"schema": "mae-flow-approval/1", "step": step_id})
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")
    payload["sha256"] = hashlib.sha256(encoded).hexdigest()
    payload["id"] = payload["sha256"][:16]
    return payload


def subject_matches(root, state, step_id, step):
    stored = (state or {}).get("approval_subject") or {}
    try:
        current = build_subject(root, state, step_id, step)
    except (OSError, RuntimeError) as exc:
        return False, "无法重新核对审批内容: " + str(exc)
    if stored.get("step") != step_id or not stored.get("sha256"):
        if current:
            # 2026-08-26 单次确认修复:缺卡不再打回重问。模型天然
            # "产物定稿即刻询问",而卡历史上要到首次 done 才生成,第一份
            # 答案因无印章被验真过滤,用户被原样重问一遍(spec/story 双
            # 确认,run8b/run9 双跑必现)。现在答案捕获钩子会按捕获瞬间
            # 的内容现算指纹盖章,这里补绑同一算法的卡后放行——共识交给
            # ack 验真裁决:只有"印章 sha == 此刻内容 sha"的答案作数。
            # 跳过询问直接 done 仍被 ack 缺失拦住;内容变更走下方分支
            # 照旧强制重新展示。防线没有降级,只是绑定时刻不再打人。
            state["approval_subject"] = current
            return True, ""
        return False, (
            "绑定当前内容的新审批卡已自动生成；直接重新展示并取得一次决定，"
            "无需重新解释或重做已经完成的工作")
    if not current or current.get("sha256") != stored.get("sha256"):
        if current:
            current["supersedes"] = str(stored.get("id") or "")
            state["approval_subject"] = current
        return False, (
            "检视内容已经变化，旧决定已自动失效，新审批卡已自动生成；"
            "直接重新展示并取得一次决定，无需让 Agent 反复解释或返工")
    return True, ""
