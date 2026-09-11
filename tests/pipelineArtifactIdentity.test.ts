import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("采集器拒绝 MR 残留旧 SHA，按提交取证；缺少版本不猜测", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import sys
sys.path.insert(0, 'deploy/adapter-tools')
import pipeline_log as p

new, old = 'b' * 40, 'a' * 40
data = p.PipelineData('group/repo', new, 'task', 'https://codehub/group/repo/merge_requests/7')
data.project_id, data.mr_iid = 42, 7
class Context:
    def __init__(self): self.writes = {}; self.queries = []; self.info = {}
    def mcp_call(self, *args, **kwargs): return {'sha': old, 'id': 99, 'status': 'failed'}
    def fetch_json(self, url):
        self.queries.append(url)
        if '/pipelines?' in url:
            return [{'sha': old, 'id': 99, 'status': 'failed'}, {'sha': new, 'id': 100, 'status': 'running'}]
        assert url.endswith('/pipelines/100/jobs'), url
        return []
    def write_json(self, name, value): self.writes[name] = value
    def log(self, message): pass
    def sse_client(self): return self
    def get_mr_pipeline_info(self, url): return self.info
ctx = Context()
p.strategy_pipeline_detail(data, ctx)
assert data.pipeline_id == 100 and data.commit_id == new
assert ctx.writes['pipeline_detail.json']['pipeline']['sha'] == new
for info in ({'sha': old, 'pipeline_id': 100}, {'defects': [{'toolName': 'old'}]}, {'sha': new, 'is_valid': False}):
    ctx.info = info
    try:
        p.strategy_pipeline_info(data, ctx)
        raise AssertionError('stale or unbound material accepted')
    except p.StrategySkipped: pass
    assert 'pipeline_info.json' not in ctx.writes
ctx.info = {'pipeline_id': 100, 'defects': []}
p.strategy_pipeline_info(data, ctx)
assert ctx.writes['pipeline_info.json'] == ctx.info
`], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
