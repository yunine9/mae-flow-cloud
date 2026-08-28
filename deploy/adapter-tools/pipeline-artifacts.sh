#!/bin/bash
# pipeline-artifacts.sh: 拉流水线失败材料（quality JSON + reviewtips + 构建日志原文）
# 输出: JSON 数组 [{name, text}]
# 每个序列化后的 item 尽量严格控制在 512KB 以内
# 2026-08-27:
#   1. repo_path URL 编码
#   2. 构建日志小于上限时保留完整原文
#   3. 大日志改为“头 + 截断标记 + 尾”，尾部权重大于头部
#   4. 按 UTF-8/实际 JSON 序列化大小控制 512KB，不再按 Python 字符数截断
#   5. quality/reviewtips 超限时仍输出合法 JSON 包装，而不是半截 JSON
# 2026-08-28 收编进仓版本化(逻辑照搬内网实测稳定版,零改动),仅把
# 写死的地址提成带默认值的环境变量:MFC_CODEHUB_API /
# MFC_CODEHUB_CLI_HOST / MFC_MCP_SSE_HOST / MFC_MCP_SSE_PORT /
# MFC_MCP_TOKEN_FILE / MFC_MCP_CLIENT_DIR。
#
# adapter.json 用法(直接输出 [{name,text}] 数组):
#   "pipeline_artifacts": {
#     "command": ["bash", ".../pipeline-artifacts.sh",
#                 "{repo_path}", "{sha}", "{token}"],
#     "fields": {"name": {"json": "name"}, "text": {"json": "text"}}
#   }
set -euo pipefail

REPO_PATH="$1"
SHA="$2"
TOKEN="$3"

# SSE MCP 客户端已随仓收编在本目录:缺省从脚本自身目录 import,
# 显式设了 MFC_MCP_CLIENT_DIR(如沿用 ~/.config 旧部署)则以其为准。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MFC_MCP_CLIENT_DIR="${MFC_MCP_CLIENT_DIR:-$SCRIPT_DIR}"

exec python3 - "$REPO_PATH" "$SHA" "$TOKEN" << 'PYEOF'
import json
import os
import re
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request

repo_path = sys.argv[1]
sha = sys.argv[2]
token = sys.argv[3]
env = {**os.environ, 'CODEHUB_TOKEN': token}

decoded_repo = urllib.parse.unquote(repo_path)
encoded_repo = urllib.parse.quote(decoded_repo, safe='')

CODEHUB_API = os.environ.get(
    'MFC_CODEHUB_API', 'https://codehub-y.huawei.com/api/v4')
CLI_HOST = os.environ.get('MFC_CODEHUB_CLI_HOST', 'yellow')
MCP_SSE_HOST = os.environ.get('MFC_MCP_SSE_HOST', '10.244.150.123')
MCP_SSE_PORT = int(os.environ.get('MFC_MCP_SSE_PORT', '9000'))
MCP_TOKEN_FILE = os.path.expanduser(os.environ.get(
    'MFC_MCP_TOKEN_FILE', '~/.config/mae-flow-cloud/mcp-token'))
MCP_CLIENT_DIR = os.path.expanduser(os.environ.get(
    'MFC_MCP_CLIENT_DIR', '~/.config/mae-flow-cloud'))
MAX_ITEM_BYTES = 512 * 1024

proxy_handler = urllib.request.ProxyHandler({})
opener = urllib.request.build_opener(proxy_handler)


def redact(value):
    text = str(value)
    if token:
        text = text.replace(token, '***')
    return text


def log_err(msg):
    print(f'[pipeline-artifacts] {redact(msg)}', file=sys.stderr)


def fetch_url(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {'Private-Token': token})
    try:
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        log_err(f'fetch_url HTTP {e.code}: {url[:120]}')
        return None
    except Exception as e:
        log_err(f'fetch_url 失败: {e} url={url[:120]}')
        return None


def utf8_len(text):
    return len(text.encode('utf-8', errors='replace'))


def take_utf8_prefix(text, max_bytes):
    if max_bytes <= 0:
        return ''
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode('utf-8', errors='ignore')


def take_utf8_suffix(text, max_bytes):
    if max_bytes <= 0:
        return ''
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= max_bytes:
        return text
    return raw[-max_bytes:].decode('utf-8', errors='ignore')


def truncate_utf8_head_tail(
    text,
    max_bytes,
    head_ratio=0.15,
    marker_template='\n\n===== 中间内容因大小限制省略；原始 UTF-8 大小 {size} bytes =====\n\n',
):
    """严格按 UTF-8 bytes 做 head+tail 截断，不切坏 UTF-8 字符。"""
    raw_size = utf8_len(text)
    if raw_size <= max_bytes:
        return text

    marker = marker_template.format(size=raw_size)
    marker_bytes = utf8_len(marker)

    if max_bytes <= marker_bytes + 32:
        return take_utf8_suffix(text, max_bytes)

    payload_budget = max_bytes - marker_bytes
    head_budget = int(payload_budget * head_ratio)
    tail_budget = payload_budget - head_budget

    head = take_utf8_prefix(text, head_budget)
    tail = take_utf8_suffix(text, tail_budget)
    result = head + marker + tail

    # UTF-8 边界处理可能有极小偏差，再做最终保险。
    if utf8_len(result) > max_bytes:
        overflow = utf8_len(result) - max_bytes
        tail = take_utf8_suffix(tail, max(0, utf8_len(tail) - overflow - 8))
        result = head + marker + tail

    return result


def serialized_item_size(item):
    return len(
        json.dumps(
            item,
            ensure_ascii=False,
            separators=(',', ':'),
        ).encode('utf-8')
    )


def fit_text_item(name, text, max_item_bytes=MAX_ITEM_BYTES):
    """
    返回序列化后 <= max_item_bytes 的 {name,text}。
    大文本采用头少尾多，优先保留构建失败现场。
    """
    item = {'name': name, 'text': text}
    if serialized_item_size(item) <= max_item_bytes:
        return item

    low = 1024
    high = max_item_bytes
    best = ''
    while low <= high:
        mid = (low + high) // 2
        candidate_text = truncate_utf8_head_tail(
            text,
            mid,
            head_ratio=0.15,
        )
        candidate = {'name': name, 'text': candidate_text}
        if serialized_item_size(candidate) <= max_item_bytes:
            best = candidate_text
            low = mid + 1
        else:
            high = mid - 1

    if not best:
        best = take_utf8_suffix(text, max(0, max_item_bytes // 2))

    item = {'name': name, 'text': best}

    # 极端转义场景最终保险。
    while serialized_item_size(item) > max_item_bytes and utf8_len(item['text']) > 1024:
        new_budget = max(1024, int(utf8_len(item['text']) * 0.9))
        item['text'] = truncate_utf8_head_tail(
            text,
            new_budget,
            head_ratio=0.15,
        )

    return item


def fit_json_item(name, obj, max_item_bytes=MAX_ITEM_BYTES):
    """
    JSON 小于上限：原样 pretty-print。
    JSON 超限：输出一个仍然合法的 JSON 包装，明确说明发生截断，并保存原 JSON 的头尾预览。
    """
    full_text = json.dumps(obj, ensure_ascii=False, indent=2)
    item = {'name': name, 'text': full_text}
    if serialized_item_size(item) <= max_item_bytes:
        return item

    original_size = utf8_len(full_text)
    note = (
        '原始 JSON 超过 artifact 大小限制；preview 为原始序列化 JSON 的头尾片段，'
        '不是完整原对象。'
    )

    # 用二分法找到能让整个 item <= 512KB 的最大 preview。
    low = 1024
    high = max_item_bytes
    best_wrapper = None

    while low <= high:
        mid = (low + high) // 2
        preview = truncate_utf8_head_tail(
            full_text,
            mid,
            head_ratio=0.25,
            marker_template=(
                '\n\n===== 原始 JSON 中间内容因大小限制省略；'
                '原始 UTF-8 大小 {size} bytes =====\n\n'
            ),
        )
        wrapper = {
            '_truncated': True,
            '_original_utf8_bytes': original_size,
            '_note': note,
            'preview': preview,
        }
        wrapper_text = json.dumps(wrapper, ensure_ascii=False, indent=2)
        candidate = {'name': name, 'text': wrapper_text}

        if serialized_item_size(candidate) <= max_item_bytes:
            best_wrapper = wrapper_text
            low = mid + 1
        else:
            high = mid - 1

    if best_wrapper is None:
        wrapper = {
            '_truncated': True,
            '_original_utf8_bytes': original_size,
            '_note': note,
            'preview': take_utf8_suffix(full_text, 64 * 1024),
        }
        best_wrapper = json.dumps(wrapper, ensure_ascii=False, indent=2)

    return fit_text_item(name, best_wrapper, max_item_bytes=max_item_bytes)


def extract_job_id(quality):
    for check in quality.get('checks', []):
        for metric in check.get('metrics', []):
            real = metric.get('real', '')
            if not isinstance(real, str) or 'jobId=' not in real:
                continue
            match = re.search(r'jobId=([A-Za-z0-9._:-]+)', real)
            if match:
                return match.group(1)
    return None


items = []

log_err(f'查询: repo={decoded_repo} sha={sha[:12]}')

pipelines = fetch_url(
    f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
    f'?sha={urllib.parse.quote(sha, safe="")}&per_page=3&order_by=id&sort=desc'
)

if not pipelines:
    log_err('流水线查询返回空')
    print(json.dumps([], ensure_ascii=False))
    sys.exit(0)

log_err(f'找到 {len(pipelines)} 条流水线')

for pipeline in pipelines:
    if pipeline.get('status') not in ('failed', 'success'):
        continue

    pid = pipeline.get('id')
    ref = pipeline.get('ref', '')

    # 1. quality JSON
    try:
        proc = subprocess.run(
            [
                'codehub-cli', 'pipeline', 'quality', str(pid),
                '--host', CLI_HOST, '--insecure',
                '--project', decoded_repo, '--format', 'json',
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )

        if proc.returncode == 0 and proc.stdout.strip():
            quality = json.loads(proc.stdout)
            items.append(
                fit_json_item(
                    f'pipeline-{pid}-quality.json',
                    quality,
                )
            )

            job_id = extract_job_id(quality)

            # 2. reviewtips
            if job_id:
                for tool_type in [
                    'codecheck',
                    'build2.0',
                    'codechecktest',
                    'CPP_UT',
                ]:
                    try:
                        tips_url = (
                            'https://codeccp.tool.huawei.com/gateway/'
                            'CodeCCP20Service/rest/codeccp20/reviewtips/json'
                            f'?jobId={urllib.parse.quote(job_id, safe="")}'
                            f'&toolType={urllib.parse.quote(tool_type, safe="")}'
                        )
                        tips_req = urllib.request.Request(
                            tips_url,
                            headers={
                                'Authorization': f'Bearer {token}',
                                'Private-Token': token,
                            },
                        )
                        with opener.open(tips_req, timeout=10) as tips_resp:
                            tips = json.loads(
                                tips_resp.read().decode('utf-8')
                            )

                        if tips.get('noteTip') or tips.get('rowMarker'):
                            items.append(
                                fit_json_item(
                                    f'pipeline-{pid}-{tool_type}-tips.json',
                                    tips,
                                )
                            )
                    except Exception as e:
                        log_err(f'reviewtips {tool_type} 失败: {e}')
        else:
            stderr = redact(proc.stderr[:200])
            log_err(
                f'codehub-cli quality pid={pid} '
                f'rc={proc.returncode} stderr={stderr}'
            )
    except Exception as e:
        log_err(f'quality 异常: {e}')

    # 3. 构建日志原文（via MCP SSE）——每个 record/job 单独一项
    if pipeline.get('status') == 'failed' and ref:
        try:
            encoded_ref = urllib.parse.quote(ref, safe='')
            mrs = fetch_url(
                f'{CODEHUB_API}/projects/{encoded_repo}/merge_requests'
                f'?source_branch={encoded_ref}&state=opened'
            )

            if mrs:
                mr_url = mrs[0].get('web_url', '')
                if mr_url:
                    sys.path.insert(0, MCP_CLIENT_DIR)
                    from mcp_sse_client import SSEMcpClient

                    with open(MCP_TOKEN_FILE, encoding='utf-8') as fh:
                        mcp_token = fh.read().strip()

                    log_err(f'MCP SSE 连接 mr={mr_url[:80]}')
                    client = SSEMcpClient(MCP_SSE_HOST, MCP_SSE_PORT)
                    try:
                        client.connect()
                        client.initialize()
                        info = client.get_mr_pipeline_info(mr_url)

                        if info:
                            defects = info.get('defects', [])
                            build_defect = next(
                                (
                                    defect
                                    for defect in defects
                                    if defect.get('toolName') == 'build2.0'
                                ),
                                None,
                            )

                            if (
                                build_defect
                                and build_defect.get('record_ids')
                                and build_defect.get('x_auth_groups')
                            ):
                                record_ids = build_defect['record_ids']
                                x_auth_groups = build_defect['x_auth_groups']

                                log_err(
                                    f'下载构建日志: {len(record_ids)} 条记录'
                                )
                                logs = client.download_build_logs(
                                    record_ids,
                                    x_auth_groups,
                                    mcp_token,
                                )

                                for rid, log_content in logs:
                                    if not log_content:
                                        continue

                                    # 小日志完整保留；大日志自动“头少 + 尾多”。
                                    items.append(
                                        fit_text_item(
                                            f'build_log_{rid}.txt',
                                            log_content,
                                        )
                                    )
                            else:
                                log_err(
                                    'build2.0 defect 无 record_ids/x_auth_groups'
                                )
                        else:
                            log_err('MCP get_mr_pipeline_info 返回空')
                    finally:
                        client.close()
            else:
                log_err(f'未找到 ref={ref} 的 MR')
        except Exception:
            log_err(
                f'MCP 构建日志失败: '
                f'{redact(traceback.format_exc())[:500]}'
            )

# 最终输出 UTF-8 JSON，避免中文被 \uXXXX 放大。
print(json.dumps(items, ensure_ascii=False, separators=(',', ':')))
PYEOF
