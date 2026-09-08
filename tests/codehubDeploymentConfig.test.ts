import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PlatformAdapter } from "../src/platformAdapter.ts";

const directory = resolve("deploy/adapter-config");
const config = JSON.parse(readFileSync(join(directory, "adapter.codehub.json"), "utf8"));
const sha = "a".repeat(40);

async function fixture(section: string, output: unknown, operation: (adapter: PlatformAdapter) => Promise<void>) {
  const temp = mkdtempSync(join(tmpdir(), "mr-config-test-"));
  try {
    const settings = structuredClone(config);
    settings.token = "fixture-token";
    const cli = join(temp, "cli.cjs");
    writeFileSync(cli, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    settings[section].command = [process.execPath, cli];
    if (section === "mr_create") delete settings.mr_lookup;
    const file = join(temp, "adapter.json");
    writeFileSync(file, JSON.stringify(settings));
    await operation(new PlatformAdapter(file, () => {}));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const query = new URLSearchParams({ repo: "https://codehub-y.huawei.com/g/r.git", mr: "2931" });

test("deployment gate lifecycle, SHA and failed gate stay independent", async () => {
  for (const state of ["opened", "merged", "closed"]) {
    await fixture("mr_gates", { mr_state: state, sha,
      gates: { state: false, merge_status: "cannot_be_merged", ci_state_passed: false,
        reason: { ci_state_passed: "compile failed" } } }, async (adapter) => {
      const result = await adapter.handle("GET", "/mr/gates", query, {}, {});
      assert.deepEqual(result.payload, { mr_state: state, sha,
        gates: [{ name: "ci_state_passed", passed: false, detail: "compile failed" }] });
    });
  }
  await fixture("mr_gates", {mr_state: "merged", gates: {}}, async (adapter) => {
    await assert.rejects(adapter.handle("GET", "/mr/gates", query, {}, {}), /SHA/);
  });
});

test("trigger only enters polling, including empty list and historical failed run", async () => {
  assert(!config.pipeline_trigger.command.includes("rerun"));
  assert(!config.pipeline_trigger.command.includes("{mr}"));
  assert(config.pipeline_trigger.command.includes("--fail"));
  assert(config.pipeline_trigger.command.at(-1).includes("?sha={sha}"));
  for (const output of [[], [{sha, id: 1, status: "failed"}], [{sha, id: 1, status: "success"}]]) {
    await fixture("pipeline_trigger", output, async (adapter) => {
      const result = await adapter.handle("POST", "/pipeline/trigger", query,
        {sha, repo: "https://codehub-y.huawei.com/g/r.git"}, {});
      assert.equal((result.payload as {status: string}).status, "running");
    });
  }
});

test("MR creation and lookup return the same iid, not global id", async () => {
  const mr = {web_url: "https://codehub-y.huawei.com/g/r/merge_requests/2931", iid:2931, id:888888};
  for (const endpoint of ["mr_create", "mr_lookup"]) {
    await fixture(endpoint, endpoint === "mr_lookup" ? [mr] : mr, async (adapter) => {
      const result = await adapter.handle("POST", "/mr", query, {}, {});
      assert.deepEqual(result.payload, {url:mr.web_url, id:"2931"});
    });
  }
});

test("portable patch matches full configuration and every script is in this repo", () => {
  const patch = JSON.parse(readFileSync(join(directory, "mr-pipeline.patch.json"), "utf8"));
  const { port, ...endpoints } = config;
  assert.equal(port, 8790);
  assert.deepEqual(JSON.parse(JSON.stringify(patch).replaceAll("@REPO_DIR@", "/data/mae-flow-cloud/repo")), endpoints);
  for (const name of ["pipeline_status", "pipeline_artifacts", "mr_gates"]) {
    const script = config[name].command[1].replace("/data/mae-flow-cloud/repo/", "");
    assert(readFileSync(script).length > 0);
  }
});

test("real MR gate bridge validates lifecycle and fails closed on upstream errors", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import contextlib, io, json, pathlib, runpy, subprocess, sys, urllib.error
from unittest.mock import patch, MagicMock
script = pathlib.Path('deploy/adapter-tools/mr-gates.py')
sha = 'a' * 40

def invoke(detail, gates=None, rc=0, http_error=False, mr="2931", timeout=False):
    stdout, stderr = io.StringIO(), io.StringIO()
    opener = MagicMock()
    opener.open.return_value.__enter__.return_value = io.StringIO(json.dumps(detail))
    if http_error:
        opener.open.side_effect = urllib.error.HTTPError('https://example.invalid',401,'fixture-token',None,None)
    completed = subprocess.CompletedProcess([], rc, json.dumps(gates if gates is not None else dict(state=False,ci_state_passed=False)), 'fixture-token')
    exitcode = 0
    with patch.object(sys,'argv',[str(script),'group%2Frepo',mr,'fixture-token']), patch('urllib.request.build_opener',return_value=opener), patch('subprocess.run',return_value=completed,side_effect=subprocess.TimeoutExpired('codehub-cli',4) if timeout else None) as cli, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            runpy.run_path(str(script),run_name='__main__')
        except SystemExit as error:
            exitcode = error.code
    assert 'fixture-token' not in stdout.getvalue() + stderr.getvalue()
    if cli.called:
        args, kwargs = cli.call_args
        assert '--token' not in args[0]
        assert kwargs['env']['CODEHUB_TOKEN'] == 'fixture-token'
        assert args[0][args[0].index('--project')+1] == 'group/repo'
    return exitcode, stdout.getvalue(), cli

for state in ['opened','merged','closed','locked']:
    rc, output, cli = invoke(dict(iid=2931,state=state,sha=sha))
    assert rc == 0, output
    data = json.loads(output)
    assert data['mr_state'] == state and data['sha'] == sha
    assert cli.called == (state in ['opened','locked'])
for detail in [dict(iid=2931,state=False,sha=sha),dict(iid=2931,sha=sha),dict(iid=99,state='opened',sha=sha),dict(iid=2931,state='merged')]:
    assert invoke(detail)[0] == 1
for gates in [[],{},dict(state=True),dict(ci_state_passed='false')]:
    assert invoke(dict(iid=2931,state='opened',sha=sha),gates=gates)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),rc=1)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),http_error=True)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),timeout=True)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),mr='https://example.org/g/r/merge_requests/2931')[0] == 0
print('gate bridge tests passed')
`], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("existing tasks recover project iid from MR URL instead of saved global id", async () => {
  const { fetchMrGates } = await import("../src/mrGateClient.ts");
  const previous = globalThis.fetch;
  let request = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    request = String(input);
    return new Response(JSON.stringify({mr_state:"opened",sha,gates:[]}), {status:200});
  }) as typeof fetch;
  try {
    const view = await fetchMrGates({platformUrl:"http://adapter",repo:"https://codehub-y.huawei.com/g/r.git",
      headers:{},requireExisting:true,delivery:{mr_id:888888,mr_url:"https://codehub-y.huawei.com/g/r/merge_requests/2931"}});
    assert.equal(new URL(request).searchParams.get("mr"),"2931");
    assert.equal(view?.mrState,"opened");
    assert.equal(view?.sourceSha,sha);
  } finally { globalThis.fetch=previous; }
});
