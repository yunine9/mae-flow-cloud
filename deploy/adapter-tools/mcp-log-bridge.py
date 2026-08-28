#!/usr/bin/env python3
"""失败材料下载桥(adapter pipeline_artifacts 的命令):把构建日志与
CodeCheck 缺陷明细落盘到 --out 目录,适配层读目录回给宿主,宿主镜像
到任务工作区外的 ../pipeline/ 给修复 Agent 读。

取数链照 toolkit(2026-08-28 对比报告 §2.2,每路独立降级):
- 现场索引:SSE 网关 get_mr_pipeline_info(defects/record_ids/
  x_auth_groups/utJobIds 都从这来)
- 构建日志 3 路:① SSE MCP download_build_task_log
  ② build MCP get_build_log_url(zip)③ build MCP get_record_log(分页)
- CodeCheck 缺陷 3 路:① codeccp MCP query_mr_info
  ② CodeCCP reviewtips REST ③ CodeCCP defect/list REST(要 third_build_id)

修复 Agent 没有这些材料就是在瞎修——本脚本每一路失败都单独记 stderr
并继续其他路;**全部路都失败才退非零**(适配层降级链/诚实 502 接住),
拿到一部分算一部分,残缺材料也比没有强。落盘文件:
  pipeline-info.json     现场索引(defects 原文)
  build-log-<id>.log     构建日志(每个 record 一份)
  codecheck-defects.md   缺陷明细(人可读,规则/文件/行号/描述)
  codecheck-defects.json 缺陷明细原文
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mfc_gateways import Gateways, GatewayError  # noqa: E402


def mr_web_url(repo: str, mr: str) -> str:
    base = repo[:-4] if repo.endswith(".git") else repo
    return f"{base.rstrip('/')}/merge_requests/{mr}" if mr else base


def write(out: Path, name: str, text: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / name).write_text(text, encoding="utf-8")
    print(f"[bridge] 落盘 {name}({len(text)} 字)", file=sys.stderr)


def pipeline_info(gateways: Gateways, args, out: Path,
                  failures: list[str]) -> dict:
    """现场索引:record_ids / x_auth_groups / defects / utJobIds。"""
    try:
        info = gateways.mcp("sse", "get_mr_pipeline_info",
                            {"url": mr_web_url(args.repo, args.mr)})
        if isinstance(info, dict):
            write(out, "pipeline-info.json",
                  json.dumps(info, ensure_ascii=False, indent=2))
            return info
        failures.append(f"pipeline_info 返回形状意外: {str(info)[:200]}")
    except GatewayError as error:
        failures.append(f"pipeline_info: {error}")
    return {}


def defect_records(info: dict) -> list[dict]:
    """defects 数组归一:每条至少given record_id;x_auth_groups 伴行。
    形状以内网实况为准(TODO 锚点 DEFECTS_SHAPE:拿到真实样例后钉死)。"""
    rows = info.get("defects")
    if not isinstance(rows, list):
        return []
    records = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        for record_id in row.get("record_ids") or (
                [row.get("record_id")] if row.get("record_id") else []):
            records.append({
                "record_id": str(record_id),
                "x_auth_groups": row.get("x_auth_groups")
                    or info.get("x_auth_groups"),
                "raw": row,
            })
    return records


def download_build_logs(gateways: Gateways, records: list[dict],
                        out: Path, failures: list[str]) -> int:
    """构建日志 3 路降级,逐 record 尝试;成功一份算一份。"""
    saved = 0
    for record in records:
        record_id = record["record_id"]
        name = f"build-log-{record_id}.log"
        # ① SSE MCP download_build_task_log
        try:
            log = gateways.mcp("sse", "download_build_task_log", {
                "record_id": record_id,
                "x_auth_groups": record.get("x_auth_groups")})
            if isinstance(log, str) and log.strip():
                write(out, name, log)
                saved += 1
                continue
        except GatewayError as error:
            failures.append(f"日志①(SSE {record_id}): {error}")
        # ② build MCP get_build_log_url → 下载 zip 解出文本
        try:
            answer = gateways.mcp("build", "get_build_log_url",
                                  {"record_id": record_id})
            url = answer.get("url") if isinstance(answer, dict) else answer
            if isinstance(url, str) and url.startswith("http"):
                with urllib.request.urlopen(url, timeout=gateways.timeout) \
                        as response:
                    blob = response.read()
                try:
                    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                        text = "\n\n".join(
                            archive.read(member).decode("utf-8", "replace")
                            for member in archive.namelist())
                except zipfile.BadZipFile:
                    text = blob.decode("utf-8", "replace")
                if text.strip():
                    write(out, name, text)
                    saved += 1
                    continue
        except (GatewayError, OSError) as error:
            failures.append(f"日志②(zip {record_id}): "
                            f"{gateways.mask(str(error))}")
        # ③ build MCP get_record_log 分页
        try:
            pages, page = [], 1
            while page <= 50:  # 预算:最多 50 页,绝无无限翻页
                chunk = gateways.mcp("build", "get_record_log", {
                    "record_id": record_id, "page": page})
                text = chunk.get("log") if isinstance(chunk, dict) else chunk
                if not isinstance(text, str) or not text:
                    break
                pages.append(text)
                if isinstance(chunk, dict) and not chunk.get("has_more"):
                    break
                page += 1
            if pages:
                write(out, name, "".join(pages))
                saved += 1
                continue
        except GatewayError as error:
            failures.append(f"日志③(分页 {record_id}): {error}")
        failures.append(f"record {record_id}: 三路都没拿到日志")
    return saved


def download_codecheck(gateways: Gateways, args, info: dict, out: Path,
                       failures: list[str]) -> int:
    """CodeCheck 缺陷明细 3 路降级;写 md+json 双份。"""
    defects = None
    # ① codeccp MCP query_mr_info
    try:
        answer = gateways.mcp("codeccp", "query_mr_info",
                              {"url": mr_web_url(args.repo, args.mr)})
        if isinstance(answer, (list, dict)):
            defects = answer
    except GatewayError as error:
        failures.append(f"缺陷①(codeccp MCP): {error}")
    # ② reviewtips REST
    if defects is None:
        rest = gateways.config.get("codeccp_rest") or {}
        if rest.get("reviewtips_url"):
            try:
                defects = gateways.rest(
                    rest["reviewtips_url"], rest.get("headers") or {},
                    method="POST",
                    body={"mrUrl": mr_web_url(args.repo, args.mr)})
            except GatewayError as error:
                failures.append(f"缺陷②(reviewtips REST): {error}")
    # ③ defect/list REST(要 third_build_id——从 pipeline_detail 来;
    #    TODO 锚点 THIRD_BUILD_ID:字段名以 toolkit 原文为准)
    if defects is None:
        rest = gateways.config.get("codeccp_rest") or {}
        job_id = str(info.get("third_build_id") or "")
        if rest.get("defect_list_url") and job_id:
            try:
                defects = gateways.rest(
                    rest["defect_list_url"], rest.get("headers") or {},
                    method="POST", body={"jobId": job_id})
            except GatewayError as error:
                failures.append(f"缺陷③(defect/list REST): {error}")
    if defects is None:
        return 0
    write(out, "codecheck-defects.json",
          json.dumps(defects, ensure_ascii=False, indent=2))
    rows = defects if isinstance(defects, list) else \
        next((value for value in defects.values()
              if isinstance(value, list)), [])
    lines = ["# CodeCheck 缺陷明细", ""]
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        site = f"{row.get('file') or row.get('filePath') or '?'}" \
               f":{row.get('line') or row.get('lineNum') or '?'}"
        rule = row.get("rule") or row.get("ruleName") or ""
        tip = row.get("noteTip") or row.get("message") \
            or row.get("description") or ""
        lines.append(f"- {site} [{rule}] {tip}")
    write(out, "codecheck-defects.md", "\n".join(lines) + "\n")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--mr", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--token", default="")
    args = parser.parse_args()
    out = Path(args.out)
    gateways = Gateways()
    if args.token:
        gateways.token = args.token
    failures: list[str] = []
    info = pipeline_info(gateways, args, out, failures)
    saved = 0
    saved += download_build_logs(
        gateways, defect_records(info), out, failures)
    saved += download_codecheck(gateways, args, info, out, failures)
    for line in failures:
        print(f"[bridge] 降级记录: {line}", file=sys.stderr)
    if saved == 0 and not info:
        # 一无所获且连索引都没拿到 = 这一路整体失败,交给适配层降级/502。
        print("[bridge] 全部取数路失败,零材料落盘", file=sys.stderr)
        return 2
    print(f"[bridge] 完成:{saved} 份材料"
          f"(index {'有' if info else '无'},降级 {len(failures)} 条)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GatewayError as error:
        print(f"[bridge] {error}", file=sys.stderr)
        sys.exit(2)
