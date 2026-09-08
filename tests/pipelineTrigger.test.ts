import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// 执行 Python 主逻辑；替换平台边界，验证选取、失败语义和配置落盘。
test("pipeline trigger rejects false success and ambiguous MR; config preserves existing endpoints", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

root = Path.cwd()
sys.path.insert(0, str(root / 'deploy/adapter-tools'))
import pipeline_trigger as module
sha = 'a' * 40
p = {'id': 10, 'sha': sha, 'ref': 'feature', 'status': 'failed'}
mr = {'iid': 7, 'source_branch': 'feature', 'state': 'opened', 'sha': sha}

def run(rows, mrs=None, response=None, later=None):
    trigger = module.Trigger('group%2Frepo', sha, 'secret')
    queries = []
    def get(suffix, **query):
        queries.append((suffix, query))
        if suffix == '/merge_requests':
            return mrs if mrs is not None else [mr]
        return later if later is not None and len(queries) > 2 else rows
    trigger.get = get
    completed = response or subprocess.CompletedProcess([], 0, json.dumps({**p, 'status':'pending'}), '')
    with patch.object(module.subprocess, 'run', return_value=completed) as cli:
        result = trigger.run()
        if cli.called:
            args, kwargs = cli.call_args
            assert '--token' not in args[0]
            assert kwargs['env']['CODEHUB_TOKEN'] == 'secret'
            assert args[0][args[0].index('--project') + 1] == 'group/repo'
    assert queries[0][1]['sha'] == sha
    assert queries[0][1]['sort'] == 'desc'
    return result, cli

def rejected(fn):
    try:
        fn()
    except (ValueError, RuntimeError):
        return
    raise AssertionError('unexpected acceptance')

for state in ['running','pending','created','success']:
    result, cli = run([{**p, 'status': state}])
    assert result['sha'] == sha and result['status'] == 'running'
    assert not cli.called
result, cli = run([{**p, 'id': 30}, p])
assert cli.call_args.args[0][3] == '30'
assert cli.call_args.args[0][cli.call_args.args[0].index('--mr') + 1] == '7'
for code, out in [(1,''),(1,'{"error":"forbidden"}'),(0,'{}'),(0,'not-json'),(0,json.dumps({**p,'sha':'b'*40,'status':'running'}))]:
    response = subprocess.CompletedProcess([], code, out, 'HTTP 401 secret')
    rejected(lambda: run([p], response=response))
    result, _ = run([p], response=response, later=[{**p, 'status':'running'}])
    assert result['id'] == 10
for rows in [[], [{**p, 'sha': sha[:12] + 'b'*28}], [p, {**p,'id':11,'ref':'other'}], [{**p,'id':None}], [p]*100]:
    rejected(lambda: run(rows))
for state in ['manual','skipped','unknown']:
    rejected(lambda: run([{**p, 'status':state}]))
for mrs in [[], [mr, {**mr,'iid':8}], [{**mr,'sha':'b'*40}], [{**mr,'source_project_id':1,'target_project_id':2}]]:
    rejected(lambda: run([p], mrs=mrs))
rejected(lambda: module.Trigger('g/r', sha[:12], 'secret'))
# timeout 不能被无条件伪装成 running。
t = module.Trigger('g/r', sha, 'secret')
t.get = lambda suffix, **kw: [mr] if suffix == '/merge_requests' else [p]
with patch.object(module.subprocess, 'run', side_effect=subprocess.TimeoutExpired('codehub-cli', 1)):
    rejected(t.run)
# 非零退出且错误输出脱敏。
with patch.object(sys, 'argv', ['script','g/r',sha,'secret']), patch.object(module.Trigger, 'run', side_effect=RuntimeError('secret denied')):
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        try:
            module.main()
        except SystemExit as error:
            assert error.code == 1
    assert 'secret' not in stderr.getvalue()

with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp)
    source, output = temp / 'input.json', temp / 'candidate.json'
    original = {'port':8790,'token':'secret', 'mr_create':{'command':['codehub-cli','mr','create','--title','{title}','--target-branch','{target_branch}','--e2e-issues','{dts_no}'],'url':{'json':'web_url'}},'mr_gates':{'command':['keep-me']}}
    source.write_text(json.dumps(original))
    command = ['python3', str(root / 'deploy/adapter-config/prepare-config.py'), '--input',str(source),'--output',str(output),'--repo-dir',str(root)]
    completed = subprocess.run(command, capture_output=True,text=True)
    assert completed.returncode == 0, completed.stderr
    candidate = json.loads(output.read_text())
    assert candidate['mr_gates'] == original['mr_gates']
    assert candidate['port'] == 8790 and candidate['token'] == 'secret'
    assert candidate['mr_create']['command'][:len(original['mr_create']['command'])] == original['mr_create']['command']
    assert candidate['mr_create']['url'] == original['mr_create']['url']
    assert '{mr}' not in candidate['pipeline_trigger']['command']
    assert '{mr}' not in candidate['pipeline_artifacts']['command']
    assert output.stat().st_mode & 0o777 == 0o600
    assert json.loads(source.read_text()) == original
    assert subprocess.run(command, capture_output=True).returncode != 0
    # 重复合并已有降级链仍保留主路，不重复增加 status 脚本。
    original['pipeline_status'] = {'candidates':[{'command':['mcp-main']},candidate['pipeline_status'],{'command':['rest-fallback']}]}
    source.write_text(json.dumps(original))
    output.unlink()
    assert subprocess.run(command, capture_output=True).returncode == 0
    specs=json.loads(output.read_text())['pipeline_status']['candidates']
    assert specs[0]['command'] == ['mcp-main'] and len(specs) == 3
print('trigger and config regression checks passed')
`], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
