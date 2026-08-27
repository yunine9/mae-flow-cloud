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
    # 构建产物不进授权集合:修复期编译出的 __pycache__/.o/target 树
    # 曾同时被本闸要求"必须全上车"、被 ownership 闸硬拦"禁止上车",
    # 两条无编号规则互相否定,Agent 无出路(排查实锤)。产物既不必
    # 提交也不许提交,从"必须精确等于"的集合里出账即可。
    return {
        api._repo_path_identity(path) for path in paths
        if not api._build_artifact_confidence(path)
    }


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
            "流水线 RED 修复窗口里没有可自动提交的新增业务改动。授权集合"
            "只收「登记 RED 之后新出现的脏文件」,不含:登记前已有改动、"
            "启动前脏文件、构建产物、过程文档(openspec/、docs/story 等)。"
            "若你的修复确实都落在这些排除项里,不要反复尝试提交——"
            "如实结束当前回合说明情况,交由宿主与人工裁决。")
    if actual != allowed:
        die_rule(
            "bash-external-repair-files",
            "本次流水线修复提交必须精确包含失败 SHA 之后的业务改动。缺少: %s；"
            "夹带: %s。流程内部文件、流水线登记前已有改动、启动前脏文件和"
            "构建产物不会获得自动授权(产物请清理出工作区或原样留着,"
            "不要提交)。按上面两个清单用 git add / git restore --staged "
            "调平后重试提交。"
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
            "流水线自动修复只能精确暂存失败 SHA 之后产生的业务文件,以下"
            "路径不在授权集合: "
            + "、".join(outside)
            + "。不得夹带流程状态、启动前脏文件、登记 RED 前已有改动或"
            "构建产物(产物清理出工作区或留在本地即可)。把它们移出 add "
            "清单后重试。")
    return True
