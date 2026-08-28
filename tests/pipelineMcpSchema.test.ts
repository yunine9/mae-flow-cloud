/**
 * 内网五网关 tools/list 的真实参数契约。Python 脚本是部署执行面，
 * 不能只靠 TypeScript typecheck；这里用假客户端直接跑策略函数，证明
 * 状态链和 artifacts 链发出的 tools/call 参数都不再是旧猜法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const HARNESS = String.raw`
import importlib.util
import os
import pathlib
import sys
import tempfile

root = pathlib.Path.cwd()
tools = root / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))

import pipeline_log
from mcp_tool_contracts import (
    actual_head_pipeline_arguments,
    build_record_arguments,
    coverage_arguments,
    mergeable_state_arguments,
    pipeline_quality_arguments,
    project_info_arguments,
)

assert project_info_arguments('https://codehub/group/repo') == {
    'git_url': 'https://codehub/group/repo'}
assert mergeable_state_arguments('42', '17') == {
    'request': {'project_id': '42', 'merge_request_iid': 17}}
assert actual_head_pipeline_arguments('42', '17') == {
    'request': {
        'project_id': '42', 'merge_request_iid': 17, 'show_job': True}}
assert pipeline_quality_arguments('42', '99') == {
    'request': {'project_id': '42', 'pipeline_id': 99}}
assert build_record_arguments('record-1', 'group-1') == {
    'record_id': 'record-1', 'group_id': 'group-1'}
assert coverage_arguments('job-1') == {'jobId': 'job-1'}
try:
    build_record_arguments('record-1', 'group-1', page=1)
    raise AssertionError('旧 page 猜参必须被共享契约拒绝')
except ValueError:
    pass


class FakeContext:
    def __init__(self):
        self.calls = []
        self.writes = {}
        self._w3token = ''

    def mcp_call(self, gateway, tool, arguments, timeout=60):
        self.calls.append((gateway, tool, arguments))
        return self._answer(tool)

    def call_tool(self, tool, arguments):
        self.calls.append(('codehub', tool, arguments))
        return self._answer(tool)

    def _answer(self, tool):
        if tool == 'get_project_info':
            return {'id': '42'}
        if tool == 'get_merge_request_mergeable_state':
            return {'ci_state_passed': False}
        if tool == 'get_merge_request_actual_head_pipeline':
            return {'id': 99, 'status': 'failed', 'sha': 'a' * 40}
        if tool == 'get_pipeline_quality':
            return {'checks': []}
        if tool == 'get_build_log_url':
            return {}
        if tool == 'get_record_log':
            return {'log': 'compiler failure'}
        if tool in ('get_build_error_info', 'get_record_fullstages'):
            return {}
        if tool == 'CodeCovDiffCoverageTool':
            return {'diffCoverage': 80}
        raise AssertionError(f'unexpected tool {tool}')

    def fetch_json(self, *args, **kwargs):
        raise RuntimeError('force MCP project fallback')

    def write_json(self, name, value):
        self.writes[name] = value

    def write_text(self, name, value):
        self.writes[name] = value

    def log(self, message):
        pass

    def sse_client(self):
        class BrokenSse:
            def download_build_logs(self, *args):
                raise RuntimeError('force build MCP fallback')
        return BrokenSse()

    def sse_token(self):
        return 'fixture-token'


ctx = FakeContext()
data = pipeline_log.PipelineData(
    'group/repo', 'a' * 40, '',
    'https://codehub.example/group/repo/merge_requests/17')
pipeline_log.resolve_mr(data, ctx)
assert data.project_id == '42'
assert ctx.calls[-1] == (
    'codehub', 'get_project_info',
    {'git_url': 'https://codehub.example/group/repo'})

data.pipeline_id = '99'
pipeline_log.strategy_pipeline_detail(data, ctx)
pipeline_log.strategy_mergeable_state(data, ctx)
pipeline_log.strategy_pipeline_quality(data, ctx)
assert ('codehub', 'get_merge_request_actual_head_pipeline', {
    'request': {
        'project_id': '42', 'merge_request_iid': 17,
        'show_job': True}}) in ctx.calls
assert ('codehub', 'get_merge_request_mergeable_state', {
    'request': {'project_id': '42', 'merge_request_iid': 17}}) in ctx.calls
assert ('codehub', 'get_pipeline_quality', {
    'request': {'project_id': '42', 'pipeline_id': 99}}) in ctx.calls

data.record_ids = ['record-1']
data.x_auth_groups = 'group-1'
pipeline_log.strategy_build_logs(data, ctx)
build_calls = [call for call in ctx.calls if call[0] == 'build']
assert {call[1] for call in build_calls} == {
    'get_build_log_url', 'get_record_log',
    'get_build_error_info', 'get_record_fullstages'}
assert all(call[2].get('group_id') == 'group-1' for call in build_calls)
assert all('page' not in call[2] for call in build_calls)

data.ut_job_ids = ['job-1']
pipeline_log.strategy_coverage(data, ctx)
assert ctx.calls[-1] == (
    'codecov', 'CodeCovDiffCoverageTool', {'jobId': 'job-1'})
assert data.guessed == []

status_path = tools / 'pipeline-status-mcp.py'
spec = importlib.util.spec_from_file_location('pipeline_status_mcp', status_path)
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)

client = FakeContext()
assert status.resolve_project_id(
    client, 'https://codehub.example/group/repo.git') == '42'
assert client.calls[-1] == (
    'codehub', 'get_project_info',
    {'git_url': 'https://codehub.example/group/repo.git'})
picked = {}
status.enrich_from_quality(client, '42', '99', picked)
assert client.calls[-1] == (
    'codehub', 'get_pipeline_quality', {
        'request': {'project_id': '42', 'pipeline_id': 99}})
`;

test("CodeHub/Build/CodeCov 两条部署链使用 tools/list 真实参数", () => {
  const result = spawnSync("python3", ["-c", HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `Python MCP 契约回归失败：\n${result.stdout}\n${result.stderr}`);
});

const NO_DATA_HARNESS = String.raw`
import pathlib
import sys

tools = pathlib.Path.cwd() / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))
import pipeline_log

class Context:
    def __init__(self):
        self.writes = {}
    def mcp_call(self, gateway, tool, arguments, timeout=60):
        return 'No data found'
    def write_json(self, name, value):
        self.writes[name] = value
    def redact(self, value):
        return str(value)

data = pipeline_log.PipelineData('group/repo', 'a' * 40, '', '')
data.ut_job_ids = ['CodeCCP20-fixture']
ctx = Context()
try:
    pipeline_log.strategy_coverage(data, ctx)
    raise AssertionError('No data found 不能被当作 coverage ok')
except RuntimeError as error:
    assert '均未拿到' in str(error)
assert ctx.writes['coverage_summary.json'] == {
    'CodeCCP20-fixture': 'empty: No data found'}
`;

test("CodeCov 的 No data found 记为缺证据，不冒充 coverage 成功", () => {
  const result = spawnSync("python3", ["-c", NO_DATA_HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `Coverage 诚实性回归失败：\n${result.stdout}\n${result.stderr}`);
});

const EVIDENCE_HARNESS = String.raw`
import json
import pathlib
import sys
import tempfile

tools = pathlib.Path.cwd() / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))
import pipeline_log


class NoEvidenceContext:
    def __init__(self):
        self.writes = {}
        self._w3token = ''
    def sse_client(self):
        class Sse:
            def download_build_logs(self, *args):
                return [('record-1', None)]
        return Sse()
    def sse_token(self):
        return 'fixture-token'
    def mcp_call(self, gateway, tool, arguments, timeout=60):
        return {}
    def write_json(self, name, value):
        self.writes[name] = value
    def write_text(self, name, value):
        self.writes[name] = value
    def log(self, message):
        pass


data = pipeline_log.PipelineData('group/repo', 'a' * 40, '', '')
data.record_ids = ['record-1']
data.x_auth_groups = 'group-1'
try:
    pipeline_log.strategy_build_logs(data, NoEvidenceContext())
    raise AssertionError('构建各路全空不能被记成 ok')
except RuntimeError as error:
    assert '均未拿到' in str(error)


class FileContext:
    def __init__(self, root):
        self.root = pathlib.Path(root)
    def write_text(self, name, value):
        (self.root / name).write_text(value, encoding='utf-8')


with tempfile.TemporaryDirectory() as raw:
    ctx = FileContext(raw)
    evidence = set()
    long_log = ('normal build line\n' * 40000
                + 'Mml.cpp:91: fatal error: missing_header.h\n'
                + 'normal tail\n' * 40000)
    pipeline_log.write_build_log(ctx, 'record-1', long_log, evidence)
    excerpt = (pathlib.Path(raw) / 'build_error_excerpt_record-1.txt') \
        .read_text(encoding='utf-8')
    assert 'Mml.cpp:91: fatal error: missing_header.h' in excerpt

with tempfile.TemporaryDirectory() as raw:
    root = pathlib.Path(raw)
    (root / 'pipeline_log_summary.json').write_text(
        json.dumps({'strategies': {'build-logs': {'status': 'ok'}}}),
        encoding='utf-8')
    (root / 'codecheck_detail.json').write_text(
        json.dumps({'file': 'src/a.cpp', 'line': 17,
                    'rule': 'G.FUN.01-CPP', 'message': 'bad function'}),
        encoding='utf-8')
    (root / 'build_errors_record-1.json').write_text(
        json.dumps({'file': 'src/b.cpp', 'line': 9,
                    'message': 'undefined reference'}), encoding='utf-8')
    for index in range(20):
        (root / f'build_log_{index}.txt').write_text(
            f'log {index}\n' + ('x' * 600000), encoding='utf-8')
    items = pipeline_log.collect_output_items(raw)
    names = [item['name'] for item in items]
    assert names[0] == 'pipeline_log_summary.json'
    assert 'codecheck_detail.json' in names
    assert 'build_errors_record-1.json' in names
    assert 'pipeline_artifacts_omitted.json' in names
    assert len(json.dumps(items, ensure_ascii=False).encode('utf-8')) \
        <= pipeline_log.MAX_BUNDLE_BYTES
    manifest = json.loads(next(
        item['text'] for item in items
        if item['name'] == 'pipeline_artifacts_omitted.json'))
    assert any(row['name'].startswith('build_log_')
               for row in manifest['files'])
`;

test("构建证据全空不报成功，长日志保留错误片段且总包不撞上限", () => {
  const result = spawnSync("python3", ["-c", EVIDENCE_HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `流水线证据预算回归失败：\n${result.stdout}\n${result.stderr}`);
});
