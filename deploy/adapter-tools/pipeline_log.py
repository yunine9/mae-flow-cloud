#!/usr/bin/env python3
"""pipeline_log.py — toolkit「PipelineLog 编排器」的忠实移植。

出身(2026-08-28 用户带回 toolkit 全景图 + 源码仲裁):toolkit 的流水线
修复闭环采用「先采后修」——所有外部系统交互集中在 PipelineLog 编排器,
8 个 Strategy 按依赖顺序执行、逐个填充共享 PipelineData、全部落盘为
本地文件;修复 Agent 只读本地文件,不再调 API。本模块照抄这套结构:
Strategy 名、落盘文件名、降级链全部沿用 toolkit 原样。

Strategy 执行顺序(toolkit 拓扑序的线性化):
  pipeline-info     SSE 网关 get_mr_pipeline_info → pipeline_info.json
  pipeline-detail   codehub MCP actual_head_pipeline → pipeline_detail.json
                    (降级: REST v4 pipelines?sha=,来源存疑但现网在用)
  mergeable-state   codehub MCP mergeable_state → mergeable_state.json
  pipeline-quality  codehub MCP get_pipeline_quality → pipeline_quality.json
                    (降级: codehub-cli pipeline quality,toolkit 同款降级)
  build-logs        SSE 下载 → build MCP zip → build MCP 分页;
                    同时采 get_build_error_info / get_record_fullstages
  codecheck         codeccp MCP query_mr_info → codecheck_detail.json
                    (降级①: REST reviewtips 按 codeccpJobId×toolType;
                     降级②: REST defect/list 按 taskId——taskId 出处
                     未钉死,拿不到就明说跳过)
  coverage          codecov MCP CodeCovDiffCoverageTool 按 utJobIds
  ai-review-tips    行云 AI Review 纯 REST(唯一非 MCP 通路)

红线:每个 Strategy fail-open——单路失败只进 errors 清单,绝不拦别路、
绝无无限等待(所有网络调用带超时,分页带页数预算)。最后写
pipeline_log_summary.json 如实记录每个策略 ok/failed/skipped 与原因,
修复 Agent 和人都能一眼看出哪路证据缺了、为什么缺。

入参形状对拍纪律:标了「猜」的工具入参(get_pipeline_quality、
get_build_log_url、get_record_log、CodeCovDiffCoverageTool 等)按
toolkit 汇总表推断,内网跑 `mcp_http_client.py --gateway <名>
--list-tools` 打出 inputSchema 后,对不上的回外网钉死——内网不改代码。

令牌纪律:token/w3token 只进请求头,永不落盘、永不进日志;错误文本
一律 redact。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request

MAX_ITEM_BYTES = 512 * 1024

CODEHUB_API = os.environ.get(
    'MFC_CODEHUB_API', 'https://codehub-y.huawei.com/api/v4')
CLI_HOST = os.environ.get('MFC_CODEHUB_CLI_HOST', 'yellow')
MCP_SSE_HOST = os.environ.get('MFC_MCP_SSE_HOST', '10.244.150.123')
MCP_SSE_PORT = int(os.environ.get('MFC_MCP_SSE_PORT', '9000'))
MCP_TOKEN_FILE = os.path.expanduser(os.environ.get(
    'MFC_MCP_TOKEN_FILE', '~/.config/mae-flow-cloud/mcp-token'))
W3TOKEN_FILE = os.environ.get('MFC_W3TOKEN_FILE', '')
# 行云 AI Review 是 toolkit 里唯一纯 REST 的外部系统(无 MCP 网关)。
AI_REVIEW_URL = os.environ.get(
    'MFC_AI_REVIEW_URL',
    'https://xingyun.rnd.huawei.com/gateway/aisystemservice/'
    'ai-code-review/reviewTips/json')
CODECCP_REST = os.environ.get(
    'MFC_CODECCP_REST',
    'https://codeccp.tool.huawei.com/gateway/CodeCCP20Service/rest/codeccp20')

# CodeCheck 类 reviewtips 遍历的工具维度(toolkit 同款清单)。
REVIEWTIP_TOOL_TYPES = ['codecheck', 'build2.0', 'codechecktest', 'CPP_UT']


# ---------------------------------------------------------------------------
# 共享数据袋(toolkit 的 PipelineData 对应物)
# ---------------------------------------------------------------------------
class PipelineData:
    def __init__(self, project_path: str, sha: str, ref: str, mr_url: str):
        self.project_path = project_path        # group/repo(已解码)
        self.sha = sha
        self.ref = ref
        self.mr_url = mr_url
        self.mr_iid = None
        self.project_id = None
        self.pipeline_id = None
        self.pipeline_status = ''
        self.commit_id = ''
        self.defects = []                       # SSE pipeline_info 的 defects
        self.record_ids = []                    # build2.0 的构建记录
        self.x_auth_groups = None
        self.ut_job_ids = []
        self.codeccp_job_id = ''                # quality 里 jobId= 提出来的
        self.summary = {}                       # strategy → {status, note}
        self.guessed = []                       # 用了「猜」入参的调用点


# ---------------------------------------------------------------------------
# 执行环境:输出目录 + 各协议客户端(全部懒加载,拿不到就如实报)
# ---------------------------------------------------------------------------
class Context:
    def __init__(self, out_dir: str, token: str, client_dir: str):
        self.out_dir = out_dir
        self.token = token
        self.client_dir = client_dir
        self._http_clients = {}
        self._sse_client = None
        self._sse_error = None
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}))   # 网关直连,不走代理(实测 407)
        self._w3token = ''
        if W3TOKEN_FILE:
            try:
                with open(os.path.expanduser(W3TOKEN_FILE),
                          encoding='utf-8') as fh:
                    self._w3token = fh.read().strip()
            except OSError:
                pass

    # -- 日志(带脱敏) --
    def redact(self, value) -> str:
        text = str(value)
        for secret in (self.token, self._w3token):
            if secret:
                text = text.replace(secret, '<token>')
        return text

    def log(self, msg: str) -> None:
        print(f'[pipeline-log] {self.redact(msg)}', file=sys.stderr)

    # -- 落盘 --
    def write_json(self, name: str, obj) -> None:
        path = os.path.join(self.out_dir, name)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)

    def write_text(self, name: str, text: str) -> None:
        path = os.path.join(self.out_dir, name)
        with open(path, 'w', encoding='utf-8', errors='replace') as fh:
            fh.write(text)

    # -- REST(CodeHub v4,Private-Token) --
    def fetch_json(self, url: str, headers=None, timeout=30):
        req = urllib.request.Request(
            url, headers=headers or {'Private-Token': self.token})
        with self.opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))

    # -- streamable-HTTP MCP(六网关注册表在 mcp_http_client.py) --
    def mcp_call(self, gateway: str, tool: str, arguments: dict,
                 timeout: float = 60):
        sys.path.insert(0, self.client_dir)
        from mcp_http_client import McpHttpClient, gateway_url
        if gateway not in self._http_clients:
            client = McpHttpClient(url=gateway_url(gateway),
                                   token=self.token, w3token=self._w3token)
            client.initialize()
            self._http_clients[gateway] = client
        return self._http_clients[gateway].call_tool(
            tool, arguments, timeout=timeout)

    # -- 旧式 SSE MCP(日志网关专用,协议不同于 streamable HTTP) --
    def sse_client(self):
        if self._sse_client is None and self._sse_error is None:
            try:
                sys.path.insert(0, self.client_dir)
                from mcp_sse_client import SSEMcpClient
                client = SSEMcpClient(MCP_SSE_HOST, MCP_SSE_PORT)
                client.connect()
                client.initialize()
                self._sse_client = client
            except Exception as error:      # 连不上如实记,别处照常跑
                self._sse_error = self.redact(str(error))
        if self._sse_client is None:
            raise RuntimeError(f'SSE 网关不可用: {self._sse_error}')
        return self._sse_client

    def sse_token(self) -> str:
        with open(MCP_TOKEN_FILE, encoding='utf-8') as fh:
            return fh.read().strip()

    def close(self) -> None:
        if self._sse_client is not None:
            try:
                self._sse_client.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Strategy 实现(名字与 toolkit 一致)
# ---------------------------------------------------------------------------
def resolve_mr(data: PipelineData, ctx: Context) -> None:
    """入口归一:拿到 mr_url / mr_iid / project_id。

    toolkit 天然 MR-first(Monitor 就是围着 MR 转);我们的适配器入口
    是 (repo, sha, ref[, mr_url]),没给 mr_url 就按 source_branch 反查
    ——这是我们与 toolkit 的入口差异,不是降级。
    """
    encoded_repo = urllib.parse.quote(data.project_path, safe='')
    if data.mr_url:
        match = re.search(r'/merge_requests?/(\d+)', data.mr_url)
        if match:
            data.mr_iid = int(match.group(1))
    if not data.mr_url and not data.ref:
        # 老脚本的找 MR 路径:sha → 流水线 → ref → source_branch 反查。
        try:
            pipelines = ctx.fetch_json(
                f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
                f'?sha={urllib.parse.quote(data.sha, safe="")}'
                f'&per_page=3&order_by=id&sort=desc') or []
            if pipelines:
                data.ref = str(pipelines[0].get('ref') or '')
        except Exception as error:
            ctx.log(f'sha 反查 ref 失败: {error}')
    if not data.mr_url and data.ref:
        encoded_ref = urllib.parse.quote(data.ref, safe='')
        mrs = ctx.fetch_json(
            f'{CODEHUB_API}/projects/{encoded_repo}/merge_requests'
            f'?source_branch={encoded_ref}&state=opened')
        if mrs:
            data.mr_url = mrs[0].get('web_url', '')
            data.mr_iid = mrs[0].get('iid')
            data.project_id = mrs[0].get('project_id')
    if data.project_id is None:
        try:
            project = ctx.fetch_json(
                f'{CODEHUB_API}/projects/{encoded_repo}')
            if isinstance(project, dict):
                data.project_id = project.get('id')
        except Exception as error:
            ctx.log(f'project_id 反查失败: {error}')
    if data.project_id is None and data.mr_url:
        # 兜底走 codehub MCP get_project_info;入参形状「猜」,
        # 待 --list-tools 对拍钉死。
        data.guessed.append('codehub.get_project_info({"url"})')
        try:
            project = ctx.mcp_call('codehub', 'get_project_info',
                                   {'url': data.mr_url})
            if isinstance(project, dict):
                data.project_id = (project.get('id')
                                   or project.get('project_id'))
        except Exception as error:
            ctx.log(f'get_project_info 失败: {error}')


def strategy_pipeline_info(data: PipelineData, ctx: Context) -> None:
    """SSE 网关 get_mr_pipeline_info → pipeline_info.json(无降级)。

    这是整条链的信息枢纽:defects(toolName/record_ids/x_auth_groups)
    和 utJobIds 都从这来。
    """
    if not data.mr_url:
        raise RuntimeError('无 MR(未给 mr_url 且 source_branch 反查为空)')
    info = ctx.sse_client().get_mr_pipeline_info(data.mr_url)
    if not info:
        raise RuntimeError('get_mr_pipeline_info 返回空')
    ctx.write_json('pipeline_info.json', info)
    data.defects = info.get('defects', []) or []
    data.ut_job_ids = list(info.get('utJobIds') or [])
    for defect in data.defects:
        data.ut_job_ids.extend(defect.get('utJobIds') or [])
        if defect.get('toolName') == 'build2.0':
            data.record_ids = list(defect.get('record_ids') or [])
            data.x_auth_groups = defect.get('x_auth_groups')
    data.ut_job_ids = list(dict.fromkeys(data.ut_job_ids))


def strategy_pipeline_detail(data: PipelineData, ctx: Context) -> None:
    """codehub MCP actual_head_pipeline → pipeline_detail.json。

    降级:REST v4 pipelines?sha=(该端点出处存疑,但现网脚本在用且
    可跑;toolkit 此策略无降级,是我们为了不空手加的保底)。
    """
    detail = None
    if data.project_id is not None and data.mr_iid is not None:
        try:
            detail = ctx.mcp_call(
                'codehub', 'get_merge_request_actual_head_pipeline',
                {'project_id': data.project_id,
                 'merge_request_iid': data.mr_iid, 'show_job': True})
        except Exception as error:
            ctx.log(f'actual_head_pipeline 失败,转 REST 降级: {error}')
    if detail:
        ctx.write_json('pipeline_detail.json', detail)
        if isinstance(detail, dict):
            data.pipeline_id = detail.get('id') or detail.get('pipeline_id')
            data.pipeline_status = str(detail.get('status', ''))
            data.commit_id = str(
                detail.get('sha') or detail.get('commit_id') or '')
            job_id = detail.get('codeccpJobId') or detail.get('codeccp_job_id')
            if job_id:
                data.codeccp_job_id = str(job_id)
        return
    # ---- REST 降级 ----
    encoded_repo = urllib.parse.quote(data.project_path, safe='')
    pipelines = ctx.fetch_json(
        f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
        f'?sha={urllib.parse.quote(data.sha, safe="")}'
        f'&per_page=5&order_by=id&sort=desc') or []
    chosen = next((p for p in pipelines if p.get('status') == 'failed'),
                  None) or next(
        (p for p in pipelines if p.get('status') == 'success'), None)
    if not chosen:
        raise RuntimeError('MCP 与 REST 都没拿到本 SHA 的流水线')
    data.pipeline_id = chosen.get('id')
    data.pipeline_status = str(chosen.get('status', ''))
    data.commit_id = str(chosen.get('sha') or '')
    jobs = ctx.fetch_json(
        f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
        f'/{data.pipeline_id}/jobs') or []
    ctx.write_json('pipeline_detail.json',
                   {'_source': 'rest-v4-fallback', 'pipeline': chosen,
                    'jobs': jobs})


def strategy_mergeable_state(data: PipelineData, ctx: Context) -> None:
    """codehub MCP mergeable_state → mergeable_state.json(toolkit 无降级)。

    9+10 项门禁布尔,修复 Agent 用它判断除了流水线还有什么卡着。
    """
    if data.project_id is None or data.mr_iid is None:
        raise RuntimeError('缺 project_id/mr_iid,无法查门禁')
    state = ctx.mcp_call('codehub', 'get_merge_request_mergeable_state',
                         {'project_id': data.project_id,
                          'merge_request_iid': data.mr_iid})
    if not state:
        raise RuntimeError('mergeable_state 返回空')
    ctx.write_json('mergeable_state.json', state)


def strategy_pipeline_quality(data: PipelineData, ctx: Context) -> None:
    """codehub MCP get_pipeline_quality → pipeline_quality.json。

    降级:codehub-cli pipeline quality(toolkit 的 CLI 降级同款,也是
    我们现网跑通的路)。从 metrics.real 里正则提 jobId= 作 codeccpJobId。
    """
    quality = None
    if data.pipeline_id is not None and data.project_id is not None:
        # 入参形状「猜」:表里只说按 pipeline 查,字段名待 --list-tools。
        data.guessed.append(
            'codehub.get_pipeline_quality({"project_id","pipeline_id"})')
        try:
            quality = ctx.mcp_call('codehub', 'get_pipeline_quality',
                                   {'project_id': data.project_id,
                                    'pipeline_id': data.pipeline_id})
        except Exception as error:
            ctx.log(f'get_pipeline_quality 失败,转 CLI 降级: {error}')
    if not quality and data.pipeline_id is not None:
        proc = subprocess.run(
            ['codehub-cli', 'pipeline', 'quality', str(data.pipeline_id),
             '--host', CLI_HOST, '--insecure',
             '--project', data.project_path, '--format', 'json'],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, 'CODEHUB_TOKEN': ctx.token})
        if proc.returncode == 0 and proc.stdout.strip():
            quality = json.loads(proc.stdout)
        else:
            raise RuntimeError(
                f'CLI 降级 rc={proc.returncode} '
                f'stderr={ctx.redact(proc.stderr[:200])}')
    if not quality:
        raise RuntimeError('无 pipeline_id 或两路都没拿到 quality')
    ctx.write_json('pipeline_quality.json', quality)
    for check in quality.get('checks', []) if isinstance(quality, dict) else []:
        for metric in check.get('metrics', []):
            real = metric.get('real', '')
            if isinstance(real, str) and 'jobId=' in real:
                match = re.search(r'jobId=([A-Za-z0-9._:-]+)', real)
                if match and not data.codeccp_job_id:
                    data.codeccp_job_id = match.group(1)


def strategy_build_logs(data: PipelineData, ctx: Context) -> None:
    """构建日志三级降级 + 结构化错误 + 构建阶段(toolkit 原样)。

    ① SSE download_build_task_log(现网跑通的主路)
    ② build MCP get_build_log_url → 下载 zip → 解压
    ③ build MCP get_record_log 分页(预算 50 页)
    随每条 record 另采 get_build_error_info(结构化编译错误,Agent 最
    好用的一份)与 get_record_fullstages(哪个阶段挂的)。
    """
    if not data.record_ids:
        raise RuntimeError('pipeline_info 未给出 build2.0 record_ids')
    pending = list(data.record_ids)
    # ① SSE 批量下载
    if data.x_auth_groups:
        try:
            logs = ctx.sse_client().download_build_logs(
                data.record_ids, data.x_auth_groups, ctx.sse_token())
            for rid, content in logs:
                if content:
                    ctx.write_text(f'build_log_{rid}.txt', content)
                    if rid in pending:
                        pending.remove(rid)
        except Exception as error:
            ctx.log(f'SSE 构建日志失败,全部转 build 网关: {error}')
    # ②③ build 网关降级(逐条,入参形状「猜」record_id/page)
    for rid in pending:
        data.guessed.append('build.get_build_log_url({"record_id"})')
        text = ''
        try:
            answer = ctx.mcp_call('build', 'get_build_log_url',
                                  {'record_id': rid})
            url_val = answer.get('url') if isinstance(answer, dict) else answer
            if isinstance(url_val, str) and url_val.startswith('http'):
                import io
                import zipfile
                with ctx.opener.open(url_val, timeout=30) as resp:
                    blob = resp.read()
                try:
                    with zipfile.ZipFile(io.BytesIO(blob)) as arc:
                        text = '\n\n'.join(
                            arc.read(m).decode('utf-8', 'replace')
                            for m in arc.namelist())
                except zipfile.BadZipFile:
                    text = blob.decode('utf-8', 'replace')
        except Exception as error:
            ctx.log(f'build zip 降级 {rid} 失败: {error}')
        if not text.strip():
            try:
                pages, page = [], 1
                while page <= 50:   # 页数预算,绝无无限翻页
                    chunk = ctx.mcp_call('build', 'get_record_log',
                                         {'record_id': rid, 'page': page})
                    piece = chunk.get('log') if isinstance(chunk, dict) \
                        else chunk
                    if not isinstance(piece, str) or not piece:
                        break
                    pages.append(piece)
                    if isinstance(chunk, dict) and not chunk.get('has_more'):
                        break
                    page += 1
                text = ''.join(pages)
            except Exception as error:
                ctx.log(f'build 分页降级 {rid} 失败: {error}')
        if text.strip():
            ctx.write_text(f'build_log_{rid}.txt', text)
    # 结构化错误 + 阶段(增益,拿不到不算本策略失败)
    for rid in data.record_ids[:5]:
        try:
            errors = ctx.mcp_call('build', 'get_build_error_info',
                                  {'record_id': rid})
            if errors:
                ctx.write_json(f'build_errors_{rid}.json', errors)
        except Exception as error:
            ctx.log(f'get_build_error_info {rid} 失败: {error}')
        try:
            stages = ctx.mcp_call('build', 'get_record_fullstages',
                                  {'record_id': rid})
            if stages:
                ctx.write_json(f'build_stages_{rid}.json', stages)
        except Exception as error:
            ctx.log(f'get_record_fullstages {rid} 失败: {error}')


def strategy_codecheck(data: PipelineData, ctx: Context) -> None:
    """CodeCheck 缺陷三级降级(toolkit 原样)→ codecheck_detail.json。

    ① codeccp MCP query_mr_info(主路)
    ② REST reviewtips 按 codeccpJobId × 工具维度
    ③ REST defect/list 按 taskId——taskId 从哪来 toolkit 表里没钉死,
      我们现网也没拿到过,所以只在上游真给了 taskId 时才尝试,否则
      如实 skip(不猜)。
    """
    if data.mr_url:
        try:
            detail = ctx.mcp_call('codeccp', 'query_mr_info',
                                  {'url': data.mr_url})
            if detail:
                ctx.write_json('codecheck_detail.json', detail)
                return
        except Exception as error:
            ctx.log(f'codeccp query_mr_info 失败,转 reviewtips: {error}')
    if not data.codeccp_job_id:
        raise RuntimeError('主路失败且无 codeccpJobId,reviewtips 无从查起')
    collected = {}
    for tool_type in REVIEWTIP_TOOL_TYPES:
        try:
            tips_url = (
                f'{CODECCP_REST}/reviewtips/json'
                f'?jobId={urllib.parse.quote(data.codeccp_job_id, safe="")}'
                f'&toolType={urllib.parse.quote(tool_type, safe="")}')
            # 鉴权头并集:表载 X-Auth-Token+w3token,现网脚本实跑的是
            # Bearer+Private-Token——都带上,哪对生效以内网实测为准。
            headers = {
                'Authorization': f'Bearer {ctx.token}',
                'Private-Token': ctx.token,
                'X-Auth-Token': ctx.token,
            }
            if ctx._w3token:
                headers['w3token'] = ctx._w3token
            req = urllib.request.Request(tips_url, headers=headers)
            with ctx.opener.open(req, timeout=10) as resp:
                tips = json.loads(resp.read().decode('utf-8'))
            if tips.get('noteTip') or tips.get('rowMarker'):
                collected[tool_type] = tips
        except Exception as error:
            ctx.log(f'reviewtips {tool_type} 失败: {error}')
    if not collected:
        raise RuntimeError('reviewtips 各工具维度均无内容(defect/list 需 '
                           'taskId,上游未提供,如实跳过)')
    ctx.write_json('codecheck_detail.json',
                   {'_source': 'rest-reviewtips-fallback', **collected})


def strategy_coverage(data: PipelineData, ctx: Context) -> None:
    """codecov MCP CodeCovDiffCoverageTool 按 utJobIds(toolkit 无降级)。

    每个 UT job 一份 coverage_diff_*.json,外加 coverage_summary.json。
    """
    if not data.ut_job_ids:
        raise RuntimeError('pipeline_info 未给出 utJobIds')
    summary = {}
    for ut_job in data.ut_job_ids[:5]:
        data.guessed.append('codecov.CodeCovDiffCoverageTool({"jobId"})')
        try:
            coverage = ctx.mcp_call('codecov', 'CodeCovDiffCoverageTool',
                                    {'jobId': ut_job})
            if coverage:
                ctx.write_json(f'coverage_diff_{ut_job}.json', coverage)
                summary[str(ut_job)] = 'ok'
            else:
                summary[str(ut_job)] = 'empty'
        except Exception as error:
            summary[str(ut_job)] = f'failed: {ctx.redact(error)[:120]}'
    if not any(v == 'ok' for v in summary.values()):
        raise RuntimeError(f'覆盖率各 job 均未拿到: {summary}')
    ctx.write_json('coverage_summary.json', summary)


def strategy_ai_review_tips(data: PipelineData, ctx: Context) -> None:
    """行云 AI Review 检视建议(纯 REST)→ ai_review_tips.json。"""
    if data.project_id is None or data.mr_iid is None:
        raise RuntimeError('缺 project_id/mr_iid')
    last_commit = data.commit_id or data.sha
    tips_url = (
        f'{AI_REVIEW_URL}?projectId={data.project_id}&mrId={data.mr_iid}'
        f'&lastCommitId={urllib.parse.quote(last_commit, safe="")}')
    req = urllib.request.Request(tips_url,
                                 headers={'X-Auth-Token': ctx.token})
    with ctx.opener.open(req, timeout=15) as resp:
        tips = json.loads(resp.read().decode('utf-8'))
    if not tips:
        raise RuntimeError('行云返回空')
    ctx.write_json('ai_review_tips.json', tips)


STRATEGIES = [
    ('pipeline-info', strategy_pipeline_info),
    ('pipeline-detail', strategy_pipeline_detail),
    ('mergeable-state', strategy_mergeable_state),
    ('pipeline-quality', strategy_pipeline_quality),
    ('build-logs', strategy_build_logs),
    ('codecheck', strategy_codecheck),
    ('coverage', strategy_coverage),
    ('ai-review-tips', strategy_ai_review_tips),
]


def run(project_path: str, sha: str, token: str, out_dir: str,
        ref: str = '', mr_url: str = '', client_dir: str = '') -> dict:
    """跑完整编排,返回 summary(同时落盘 pipeline_log_summary.json)。"""
    os.makedirs(out_dir, exist_ok=True)
    data = PipelineData(urllib.parse.unquote(project_path), sha, ref, mr_url)
    ctx = Context(out_dir, token,
                  client_dir or os.path.dirname(os.path.abspath(__file__)))
    try:
        try:
            resolve_mr(data, ctx)
        except Exception as error:
            ctx.log(f'MR 归一失败(相关策略会各自如实报): {error}')
        for name, strategy in STRATEGIES:
            try:
                strategy(data, ctx)
                data.summary[name] = {'status': 'ok'}
                ctx.log(f'{name}: ok')
            except Exception as error:
                # fail-open:失败进清单,别的策略照常跑。
                note = ctx.redact(str(error) or
                                  traceback.format_exc()[-200:])[:300]
                data.summary[name] = {'status': 'failed', 'note': note}
                ctx.log(f'{name}: failed — {note}')
        summary = {
            'sha': sha,
            'mr_url': data.mr_url,
            'pipeline_id': data.pipeline_id,
            'pipeline_status': data.pipeline_status,
            'strategies': data.summary,
            'guessed_args': sorted(set(data.guessed)),
        }
        ctx.write_json('pipeline_log_summary.json', summary)
        return summary
    finally:
        ctx.close()


# ---------------------------------------------------------------------------
# 512KB 预算装箱(从 pipeline-artifacts.sh 收编的既有实现,语义不变)
# ---------------------------------------------------------------------------
def _utf8_len(text):
    return len(text.encode('utf-8', errors='replace'))


def _take_utf8_prefix(text, max_bytes):
    if max_bytes <= 0:
        return ''
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode('utf-8', errors='ignore')


def _take_utf8_suffix(text, max_bytes):
    if max_bytes <= 0:
        return ''
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= max_bytes:
        return text
    return raw[-max_bytes:].decode('utf-8', errors='ignore')


def _truncate_utf8_head_tail(
    text, max_bytes, head_ratio=0.15,
    marker_template=('\n\n===== 中间内容因大小限制省略；'
                     '原始 UTF-8 大小 {size} bytes =====\n\n'),
):
    """严格按 UTF-8 bytes 做 head+tail 截断,不切坏 UTF-8 字符。"""
    raw_size = _utf8_len(text)
    if raw_size <= max_bytes:
        return text
    marker = marker_template.format(size=raw_size)
    marker_bytes = _utf8_len(marker)
    if max_bytes <= marker_bytes + 32:
        return _take_utf8_suffix(text, max_bytes)
    payload_budget = max_bytes - marker_bytes
    head_budget = int(payload_budget * head_ratio)
    tail_budget = payload_budget - head_budget
    head = _take_utf8_prefix(text, head_budget)
    tail = _take_utf8_suffix(text, tail_budget)
    result = head + marker + tail
    if _utf8_len(result) > max_bytes:
        overflow = _utf8_len(result) - max_bytes
        tail = _take_utf8_suffix(tail, max(0, _utf8_len(tail) - overflow - 8))
        result = head + marker + tail
    return result


def _serialized_item_size(item):
    return len(json.dumps(item, ensure_ascii=False,
                          separators=(',', ':')).encode('utf-8'))


def fit_text_item(name, text, max_item_bytes=MAX_ITEM_BYTES):
    """返回序列化后 <= max_item_bytes 的 {name,text};大文本头少尾多,
    优先保留失败现场(构建日志的错误都在尾部)。"""
    item = {'name': name, 'text': text}
    if _serialized_item_size(item) <= max_item_bytes:
        return item
    low, high, best = 1024, max_item_bytes, ''
    while low <= high:
        mid = (low + high) // 2
        candidate_text = _truncate_utf8_head_tail(text, mid, head_ratio=0.15)
        if _serialized_item_size(
                {'name': name, 'text': candidate_text}) <= max_item_bytes:
            best = candidate_text
            low = mid + 1
        else:
            high = mid - 1
    if not best:
        best = _take_utf8_suffix(text, max(0, max_item_bytes // 2))
    item = {'name': name, 'text': best}
    while (_serialized_item_size(item) > max_item_bytes
           and _utf8_len(item['text']) > 1024):
        new_budget = max(1024, int(_utf8_len(item['text']) * 0.9))
        item['text'] = _truncate_utf8_head_tail(text, new_budget,
                                                head_ratio=0.15)
    return item


def fit_json_item(name, obj, max_item_bytes=MAX_ITEM_BYTES):
    """JSON 小于上限原样 pretty-print;超限输出仍合法的截断包装。"""
    full_text = json.dumps(obj, ensure_ascii=False, indent=2)
    item = {'name': name, 'text': full_text}
    if _serialized_item_size(item) <= max_item_bytes:
        return item
    original_size = _utf8_len(full_text)
    note = ('原始 JSON 超过 artifact 大小限制；preview 为原始序列化 JSON '
            '的头尾片段，不是完整原对象。')
    low, high, best_wrapper = 1024, max_item_bytes, None
    while low <= high:
        mid = (low + high) // 2
        preview = _truncate_utf8_head_tail(
            full_text, mid, head_ratio=0.25,
            marker_template=('\n\n===== 原始 JSON 中间内容因大小限制省略；'
                             '原始 UTF-8 大小 {size} bytes =====\n\n'))
        wrapper_text = json.dumps(
            {'_truncated': True, '_original_utf8_bytes': original_size,
             '_note': note, 'preview': preview},
            ensure_ascii=False, indent=2)
        if _serialized_item_size(
                {'name': name, 'text': wrapper_text}) <= max_item_bytes:
            best_wrapper = wrapper_text
            low = mid + 1
        else:
            high = mid - 1
    if best_wrapper is None:
        best_wrapper = json.dumps(
            {'_truncated': True, '_original_utf8_bytes': original_size,
             '_note': note,
             'preview': _take_utf8_suffix(full_text, 64 * 1024)},
            ensure_ascii=False, indent=2)
    return fit_text_item(name, best_wrapper, max_item_bytes=max_item_bytes)


def collect_items(project_path: str, sha: str, token: str,
                  ref: str = '', mr_url: str = '',
                  client_dir: str = '') -> list:
    """编排采集 + 装箱:适配器 pipeline_artifacts 命令的完整实现。

    「先采后修」的落地:编排器把证据落盘到临时 pipeline/ 目录,这里
    再逐文件装箱成 [{name,text}] 交给宿主写进任务工作区——修复 Agent
    只读这些本地文件,不再调任何外部 API。
    """
    import tempfile
    out_dir = tempfile.mkdtemp(prefix='pipeline-log-')
    run(project_path, sha, token, out_dir,
        ref=ref, mr_url=mr_url, client_dir=client_dir)
    items = []
    # summary 放最前:Agent 先看哪路证据有、哪路缺、为什么缺。
    names = sorted(os.listdir(out_dir),
                   key=lambda n: (n != 'pipeline_log_summary.json', n))
    for name in names:
        path = os.path.join(out_dir, name)
        try:
            with open(path, encoding='utf-8', errors='replace') as fh:
                content = fh.read()
        except OSError:
            continue
        if name.endswith('.json'):
            try:
                items.append(fit_json_item(name, json.loads(content)))
                continue
            except json.JSONDecodeError:
                pass
        items.append(fit_text_item(name, content))
    return items
