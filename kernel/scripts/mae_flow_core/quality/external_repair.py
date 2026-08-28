"""Narrow Core-owned authorization for Cloud pipeline repair commits.

The original delivery manifest remains the human-approved delivery scope.  A
pipeline RED can legitimately require an additional test or source file, but
asking for another human Diff approval would turn the lightweight repair loop
back into the heavyweight workflow.

2026-08-28 勘误:窗口原来绑 "HEAD == failed_sha",第一笔修复提交改变
HEAD 即静默失效——Agent 漏提交一个文件想补第二刀时,直接摔进按旧清单
判定的交付清单闸(排查实锤的"能编辑不能提交"反向死角)。现在窗口以
"宿主登记的 RED 判决还指着 failed_sha"为生命期:同一轮修复允许多笔
本地提交;宿主取回新 SHA 的流水线结果重新登记时,窗口自然关闭或换发。
"""

from mae_flow_core.foundation.source_paths import repository_path_identity
from mae_flow_core.guard.manifest import validate_delivery_document_boundary


def issue_repair_authorization(state, decision, *, head, at, dirty_paths=()):
    """Issue/clear a failed-SHA-bound repair window from a pipeline verdict."""
    if getattr(decision, "verdict", "") != "RED":
        state.pop("external_repair_authorization", None)
        return None
    existing = (state or {}).get("external_repair_authorization") or {}
    if (
        existing.get("schema") == "mae-flow-external-repair/1"
        and existing.get("status") == "ready"
        and existing.get("failed_sha") == str(head or "")
    ):
        # 宿主轮询对同一 SHA 重复登记 RED 时不许重取 baseline_dirty:
        # Agent 改到一半的文件会被划成"登记前已有改动"永久排除,修完
        # 反被告知"先产生真实修复"(排查实锤的吞修复死角)。原授权原样续用。
        return existing
    authorization = {
        "schema": "mae-flow-external-repair/1",
        "status": "ready",
        "failed_sha": str(head or ""),
        "issued_at": str(at or ""),
        # Anything already dirty when RED was registered is not attributable
        # to the repair Agent and may not hitch a ride in its automatic commit.
        "baseline_dirty": list(dict.fromkeys(
            str(path) for path in dirty_paths if str(path))),
    }
    state["external_repair_authorization"] = authorization
    return authorization


def active_repair_authorization(state, head):
    """窗口生命期 = 登记在案的 RED 判决仍指着签发时的 failed_sha。

    刻意不再比对当前 HEAD(见模块 docstring 勘误):第一笔修复提交后
    HEAD 前移,窗口保持打开,允许补提交;宿主对新 SHA 登记结果时授权
    被换发或清除,窗口随之关闭。head 参数保留是给调用方对账用的,
    判活本身不看它。"""
    del head
    authorization = (state or {}).get("external_repair_authorization") or {}
    external = (((state or {}).get("quality") or {}).get(
        "external_verification") or {})
    failed_sha = authorization.get("failed_sha") or ""
    active = bool(
        (state or {}).get("current") == "external_verify"
        and authorization.get("schema") == "mae-flow-external-repair/1"
        and authorization.get("status") == "ready"
        and failed_sha
        and external.get("verdict") == "RED"
        and external.get("sha") == failed_sha
    )
    return active, authorization


def _identity(path):
    return repository_path_identity(path, case_insensitive=True)


def eligible_repair_paths(state, head, dirty_paths, repository_root=None):
    """Return exact business paths attributable to the active RED repair."""
    active, authorization = active_repair_authorization(state, head)
    if not active:
        return ()
    excluded = {
        _identity(path) for path in (
            list((state or {}).get("initial_dirty") or ())
            + list(authorization.get("baseline_dirty") or ()))
        if isinstance(path, str)
    }
    eligible = []
    for path in dirty_paths:
        if not isinstance(path, str) or _identity(path) in excluded:
            continue
        try:
            validate_delivery_document_boundary((path,))
        except ValueError:
            continue
        eligible.append(path)
    return tuple(dict.fromkeys(eligible))
