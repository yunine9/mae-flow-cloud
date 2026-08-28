#!/usr/bin/env python3
"""流水线状态编排脚本(adapter pipeline_status 的 contract 模式候选)。

输出**就是宿主契约**:{"runs":[{status, sha, is_valid, pipeline_id,
web_url, log?, checks:[{dimension,status,job,stage,tool,url,details}]}]}
——适配层 contract:true 直通,不用逐字段抽取配置。

取数链(照 toolkit 的 3 层降级,2026-08-28 对比报告 §2.1):
① MCP codehub 网关 get_merge_request_actual_head_pipeline(show_job)
② CodeHub REST actual_head_pipeline?show_job=true
③ REST pipelines?sha= 列表(没有 MR 号时的最后一路)
质量粒度增益(可失败,不拦主链):MCP get_pipeline_quality →
codequality_check 并进对应维度的 details。

防陈灯是本脚本的第一职责:is_valid 与流水线 sha **原样回显**给宿主,
由宿主机械核验"结果属于当次提交"(旧绿灯不背书新代码);认不出的
状态词如实映射失败退非零,绝不猜——适配层降级链会接住。

用法: pipeline-status.py --sha <sha> --repo <url> [--mr <iid>]
      [--token <t>](适配层注入;缺席回落 gateways.json 的 token_file)
      [--selftest] 打印取数计划与各路可达性(令牌打码)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mfc_gateways import Gateways, GatewayError, repo_path_of  # noqa: E402


# 平台状态词 → 宿主契约(run 级只有三个词;checks 级七个)。
RUN_STATUS = {
    "success": "success", "passed": "success",
    "failed": "failed", "error": "failed", "canceled": "failed",
    "cancelled": "failed",
    "running": "running", "pending": "running", "created": "running",
    "preparing": "running", "waiting_for_resource": "running",
    "manual": "running", "scheduled": "running",
}
CHECK_STATUS = {
    "success": "success", "passed": "success",
    "failed": "failed", "error": "failed",
    "running": "running", "pending": "pending", "created": "pending",
    "canceled": "canceled", "cancelled": "canceled",
    "skipped": "skipped", "manual": "not_run", "not_run": "not_run",
}

# job/stage 名 → COMPILE/UT/CODECHECK 维度。内网 job 命名不吻合时改
# 同目录 dimension-map.json(数组 [{"pattern": 正则, "dimension": 词}],
# 先命中先赢),不用改本脚本。
DEFAULT_DIMENSION_RULES = [
    {"pattern": r"codecheck|codeccp|superchecker|code_?quality|lint|"
                r"secsolar|cmetrics", "dimension": "CODECHECK"},
    {"pattern": r"\but\b|unit[_-]?test|测试|autotest|llt|coverage|codecov",
     "dimension": "UT"},
    {"pattern": r"build|compile|编译|maven|cmake|make\b|package",
     "dimension": "COMPILE"},
]


def dimension_rules():
    override = Path(__file__).with_name("dimension-map.json")
    if override.exists():
        return json.loads(override.read_text(encoding="utf-8"))
    return DEFAULT_DIMENSION_RULES


def dimension_of(name: str, stage: str, rules) -> str | None:
    haystack = f"{stage} {name}".lower()
    for rule in rules:
        if re.search(rule["pattern"], haystack, re.I):
            return rule["dimension"]
    return None


def map_word(raw, table, what: str) -> str:
    word = str(raw or "").strip().lower()
    if word not in table:
        raise GatewayError(
            f"{what} 状态词 \"{word}\" 不认识,拒绝猜——把它补进脚本"
            "映射表(或 dimension-map.json)再跑")
    return table[word]


def jobs_to_checks(stages, rules) -> list[dict]:
    """stages+jobs 树 → 契约 checks。同一维度多个 job 时:任一 failed
    即 failed(红灯不许被后跑的绿 job 洗掉),否则取最后一个的状态。"""
    picked: dict[str, dict] = {}
    for stage in stages or []:
        stage_name = str(stage.get("name") or "")
        for job in stage.get("jobs") or []:
            name = str(job.get("name") or "")
            dimension = dimension_of(name, stage_name, rules)
            if not dimension:
                continue
            check = {
                "dimension": dimension,
                "status": map_word(job.get("status"), CHECK_STATUS,
                                   f"job {name}"),
                "job": name,
                **({"stage": stage_name} if stage_name else {}),
                **({"url": str(job.get("web_url"))}
                   if job.get("web_url") else {}),
            }
            existing = picked.get(dimension)
            if existing is None or existing["status"] != "failed":
                if existing and existing["status"] == "failed" \
                        and check["status"] != "failed":
                    continue
                picked[dimension] = check
            if check["status"] == "failed":
                picked[dimension] = check
    return list(picked.values())


def quality_details(gateways: Gateways, project: str, pipeline_id: str,
                    checks: list[dict]) -> None:
    """get_pipeline_quality 的 codequality_check 并进 details(增益路,
    失败不拦主链——细节拿不到不等于状态拿不到)。"""
    try:
        quality = gateways.mcp("codehub", "get_pipeline_quality", {
            "project_id": project, "pipeline_id": pipeline_id})
    except GatewayError as error:
        print(f"[pipeline-status] 质量明细增益路失败(忽略): {error}",
              file=sys.stderr)
        return
    rows = (quality or {}).get("codequality_check") \
        if isinstance(quality, dict) else None
    if not isinstance(rows, list):
        return
    rules = dimension_rules()
    for row in rows:
        if not isinstance(row, dict):
            continue
        tool = str(row.get("tool") or row.get("tool_name") or "")
        dimension = dimension_of(tool, str(row.get("stage") or ""), rules) \
            or "CODECHECK"
        for check in checks:
            if check["dimension"] != dimension:
                continue
            check.setdefault("tool", tool or None)
            details = check.setdefault("details", [])
            message = str(row.get("message") or row.get("metric")
                          or json.dumps(row, ensure_ascii=False)[:300])
            details.append({
                "message": message,
                **({"tool": tool} if tool else {}),
                **({"rule": str(row.get("rule"))} if row.get("rule") else {}),
                **({"file": str(row.get("file"))} if row.get("file") else {}),
            })
            if check.get("tool") is None:
                check.pop("tool")


def fetch_pipeline(gateways: Gateways, args) -> dict | None:
    """三路降级取 actual_head_pipeline(或 sha 反查)。返回平台原始
    pipeline 对象,None=平台明确说"没有"(宿主继续等,不是错)。"""
    project = repo_path_of(args.repo)
    failures = []
    if args.mr:
        # ① MCP codehub 网关(toolkit 主路)。
        try:
            result = gateways.mcp(
                "codehub", "get_merge_request_actual_head_pipeline",
                {"project_id": project, "merge_request_iid": args.mr,
                 "show_job": True})
            if isinstance(result, dict):
                return result
            failures.append(f"MCP 返回形状意外: {str(result)[:200]}")
        except GatewayError as error:
            failures.append(f"MCP 路: {error}")
        # ② REST actual_head_pipeline。
        rest = gateways.config.get("codehub_rest") or {}
        if rest.get("base_url"):
            try:
                return gateways.rest(
                    f"{rest['base_url']}/projects/{project}/merge_requests/"
                    f"{args.mr}/actual_head_pipeline?show_job=true",
                    rest.get("headers") or {})
            except GatewayError as error:
                failures.append(f"REST actual_head 路: {error}")
    # ③ 没有 MR 号(或前两路全挂):按 sha 反查流水线列表。
    rest = gateways.config.get("codehub_rest") or {}
    if rest.get("base_url"):
        try:
            listed = gateways.rest(
                f"{rest['base_url']}/projects/{project}/pipelines"
                f"?sha={args.sha}", rest.get("headers") or {})
            rows = listed if isinstance(listed, list) \
                else (listed or {}).get("pipelines") or []
            if rows:
                return rows[-1] if isinstance(rows[-1], dict) else None
            return None  # 平台明说没有:宿主继续等,不算失败
        except GatewayError as error:
            failures.append(f"REST sha 反查路: {error}")
    raise GatewayError("全部取数路失败:\n" + "\n".join(
        f"  - {why}" for why in failures))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--mr", default="")
    parser.add_argument("--token", default="")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    gateways = Gateways()
    if args.token:
        gateways.token = args.token  # 适配层注入的个人/服务令牌优先
    if args.selftest:
        print("== pipeline-status selftest ==")
        print(f"repo_path: {repo_path_of(args.repo)}")
        print(f"mr: {args.mr or '(缺席,将走 sha 反查路)'}")
        for name in ("codehub",):
            configured = bool(
                ((gateways.config.get('mcp') or {}).get(name) or {})
                .get('url'))
            print(f"MCP {name}: {'已配置' if configured else '未配置(走 REST)'}")
        print(f"REST base: "
              f"{(gateways.config.get('codehub_rest') or {}).get('base_url')}")
    pipeline = fetch_pipeline(gateways, args)
    if pipeline is None:
        print(json.dumps({"runs": []}, ensure_ascii=False))
        return 0
    rules = dimension_rules()
    checks = jobs_to_checks(pipeline.get("stages"), rules)
    pipeline_id = str(pipeline.get("id") or "")
    if pipeline_id and checks:
        quality_details(gateways, repo_path_of(args.repo), pipeline_id,
                        checks)
    run = {
        "status": map_word(pipeline.get("status"), RUN_STATUS, "pipeline"),
        # 防陈灯回显:sha 与 is_valid 原样交给宿主机械核验。
        **({"sha": str(pipeline.get("sha"))} if pipeline.get("sha") else {}),
        **({"is_valid": bool(pipeline.get("is_valid"))}
           if "is_valid" in pipeline else {}),
        **({"pipeline_id": pipeline_id} if pipeline_id else {}),
        **({"web_url": str(pipeline.get("web_url"))}
           if pipeline.get("web_url") else {}),
        **({"checks": checks} if checks else {}),
    }
    print(json.dumps({"runs": [run]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GatewayError as error:
        print(f"[pipeline-status] {error}", file=sys.stderr)
        sys.exit(2)
