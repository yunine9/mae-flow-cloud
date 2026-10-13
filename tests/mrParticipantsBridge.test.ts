import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("人员桥只使用显式字段映射，合并完整名单并回读验证，异常不泄露凭据", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import contextlib, importlib.util, io, json, os, subprocess, urllib.error
from unittest.mock import patch, MagicMock
spec = importlib.util.spec_from_file_location('participants', 'deploy/adapter-tools/mr-participants.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
token = 'never-print-this-token'
fields = dict(reviewers='people.reviewers', approval_approvers='people.approvers')
requested = dict(reviewers=['alice'], approval_approvers=['bob'])
before = dict(iid=7, state='opened', people=dict(reviewers=[dict(username='human')], approvers=['existing']))
after = dict(iid=7, state='opened', people=dict(reviewers=['human', 'alice'], approvers=['existing', 'bob']))

def invoke(people=requested, details=None, mapping=fields, rc=0, cli_error=None, http_error=None):
    opener = MagicMock()
    responses = [MagicMock() for _ in (details if details is not None else [before, after])]
    for response, detail in zip(responses, details if details is not None else [before, after]):
        response.__enter__.return_value = io.StringIO(json.dumps(detail))
    opener.open.side_effect = http_error if http_error else responses
    completed = subprocess.CompletedProcess([], rc, token, token)
    stdout = io.StringIO()
    env = dict(os.environ)
    env['MFC_CODEHUB_CLI_HOST'] = 'yellow'
    env['MFC_CODEHUB_API'] = 'https://codehub.test/api/v4'
    env.pop('MFC_CODEHUB_MR_PARTICIPANT_FIELDS', None)
    if mapping is not None: env['MFC_CODEHUB_MR_PARTICIPANT_FIELDS'] = json.dumps(mapping)
    with patch.dict(os.environ, env, clear=True), patch.object(bridge.urllib.request, 'build_opener', return_value=opener), patch.object(bridge.subprocess, 'run', return_value=completed, side_effect=cli_error) as cli, contextlib.redirect_stdout(stdout):
        bridge.main(['script','group%2Frepo','7',json.dumps(people),token])
    output = stdout.getvalue()
    assert token not in output, output
    return json.loads(output), cli, opener

out, cli, opener = invoke(mapping=None)
assert out['status'] == 'failed' and '尚未配置' in out['message']
assert not cli.called and not opener.open.called
for detail in [dict(iid=7,state='opened'), dict(iid=7,state='opened',people=dict(reviewers=None,approvers=[])), dict(iid=7,state='opened',people=dict(reviewers=[dict(id=2)],approvers=[]))]:
    out, cli, _ = invoke(details=[detail])
    assert out['status'] == 'failed' and not cli.called, out
for people in [dict(reviewers=['a,b']), dict(reviewers=['--bad']), dict(assignees=['alice']), dict(reviewers='alice')]:
    out, cli, opener = invoke(people=people)
    assert out['status'] == 'failed' and not cli.called and not opener.open.called, out
out, cli, opener = invoke()
assert out == dict(status='applied',requested=requested), out
args, kwargs = cli.call_args
assert args[0] == ['codehub-cli','mr','update','--host','yellow','--project','group/repo','7','--reviewers','human,alice','--approval-approvers','existing,bob','--format','json','-k'], args
assert kwargs['env']['CODEHUB_TOKEN'] == token and token not in args[0]
assert 0 < kwargs['timeout'] <= 12 and opener.open.call_count == 2
assert opener.open.call_args.args[0].full_url.endswith('/projects/group%2Frepo/merge_requests/7')
out, cli, _ = invoke(details=[after])
assert out['status'] == 'applied' and not cli.called
out, cli, _ = invoke(details=[before,before])
assert out['status'] == 'failed' and '回读' in out['message']
one_role = dict(reviewers=['alice'])
out, cli, _ = invoke(people=one_role, mapping=dict(reviewers='people.reviewers'))
assert out['status'] == 'applied'
assert '--approval-approvers' not in cli.call_args.args[0]
out, cli, _ = invoke(people=dict(reviewers=[],approval_approvers=[]), mapping=None)
assert out['status'] == 'skipped' and not cli.called
for options in [dict(rc=2), dict(cli_error=subprocess.TimeoutExpired(token,12)), dict(http_error=urllib.error.HTTPError('https://invalid',403,token,None,None))]:
    out, cli, _ = invoke(**options)
    assert out['status'] == 'failed', out
out, cli, _ = invoke(mapping=dict(reviewers='people.reviewers',approval_approvers='people.reviewers'))
assert out['status'] == 'failed' and not cli.called
out, cli, _ = invoke(details=[dict(before,state='merged')])
assert out['status'] == 'failed' and not cli.called
print('strict participant bridge checks passed')
`], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /strict participant bridge checks passed/);
});
