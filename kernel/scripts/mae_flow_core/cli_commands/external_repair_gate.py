"""Git Gate adapter for the failed-SHA external repair authorization."""

from .shared import os
from .wiring import api
from mae_flow_core.quality.external_repair import (
    active_repair_authorization, eligible_repair_paths)


def _candidate_ids(state):
    head = api.sh("git rev-parse --verify HEAD")
    active, _authorization = active_repair_authorization(state, head)
    if not active:
        return None
    paths = eligible_repair_paths(
        state, head, api._dirty_paths(), repository_root=os.getcwd())
    return {api._repo_path_identity(path) for path in paths}


def gate_repair_commit(state, candidate_snapshot, die_rule):
    """Handle exact commit scope; return False outside a RED repair window."""
    allowed = _candidate_ids(state)
    if allowed is None:
        return False
    actual = {
        api._repo_path_identity(path)
        for path in candidate_snapshot.get("paths", ())
    }
    if not allowed:
        die_rule(
            "bash-external-repair-empty",
            "流水线 RED 修复窗口里没有可自动提交的新增业务改动；"
            "保持宿主等待并先产生真实修复，不要重复提交或请求人工 Diff。")
    if actual != allowed:
        die_rule(
            "bash-external-repair-files",
            "本次流水线修复提交必须精确包含失败 SHA 之后的业务改动。缺少: %s；"
            "夹带: %s。流程内部文件、流水线登记前已有改动和启动前脏文件"
            "不会获得自动授权。"
            % ("、".join(sorted(allowed - actual)) or "无",
               "、".join(sorted(actual - allowed)) or "无"))
    return True

def gate_repair_add(state, add_paths, die_rule):
    """Handle exact staging scope; return False outside a RED repair window."""
    allowed = _candidate_ids(state)
    if allowed is None:
        return False
    outside = [
        path for path in add_paths
        if api._repo_path_identity(path) not in allowed
    ]
    if outside:
        die_rule(
            "bash-external-repair-stage",
            "流水线自动修复只能精确暂存失败 SHA 之后产生的业务文件: "
            + "、".join(outside)
            + "。不得夹带流程状态、启动前脏文件或登记 RED 前已有改动。")
    return True
