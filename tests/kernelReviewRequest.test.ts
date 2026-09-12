import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pendingKernelReview } from "../src/kernelReviewRequest.ts";
import { HumanGate } from "../src/humanGate.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { KernelHost } from "../src/kernelHost.ts";

const kernel = resolve(process.env.MAE_FLOW_HOME ?? "kernel");
test("真实 done 拒绝旧审批后，宿主立即举卡；回答回到同一会话且不重复出卡", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-kernel-review-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
  writeFileSync(join(cwd, "a.txt"), "initial\n"); git("add", "."); git("commit", "-qm", "initial");
  execFileSync("python3", ["-c", `import sys,json,os
sys.path.insert(0,sys.argv[1])
from mae_flow_core.cli_commands.approval_subject import build_subject
state={"current":"delivery_review","revision":1,"config":{"分支名":"main","基线分支":"main","单号":"REQ5"},"choices":{},"history":[],"delivery_manifest":{"files":["a.txt"]},"implementation_base_head":sys.argv[2]}
state["approval_subject"]=build_subject(os.getcwd(),state,"delivery_review",{"approval_subject":{"kind":"worktree"}})
with open(".mae-flow.json","w") as f: json.dump(state,f)
`, join(kernel, "scripts"), git("rev-parse", "HEAD")], { cwd });
  writeFileSync(join(cwd, "a.txt"), "changed after approval\n");
  const command = `python3 '${join(kernel, "scripts/mae-flow.py")}' done`;
  const model = new ScriptedModelServer([{ tool: { name: "bash", input: { command } } },
    { tool: { name: "bash", input: { command } } }, { text: "已收到真实决定" }]);
  await model.start(); t.after(() => model.stop());
  const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const gate = new HumanGate(join(cwd, "waiting.json"));
  const host = new KernelHost({ kernelRoot: kernel, workspace: cwd,
    transcriptPath: join(cwd, "transcript.jsonl"), taskId: "T5" });
  const session = await CloudSession.create({ taskId: "T5", workspace: cwd, agentDir,
    provider: "maeflow", model: "scripted-v1", humanGate: gate,
    gate: new GateService(), currentStep: () => "delivery_review",
    hostHooks: { preTool: event => host.preTool(event), postTool: event => host.postTool(event) },
    pendingHumanQuestion: () => pendingKernelReview(cwd, kernel, gate, "T5"),
    eventLog: new EventLog(join(cwd, "events.jsonl")),
    transcript: new TranscriptStore(join(cwd, "transcript.jsonl"), "main"),
  });
  t.after(() => session.dispose());
  const outcome = await session.start("执行已准备的交付检查");
  assert.equal(outcome.status, "waiting_for_human", JSON.stringify(outcome));
  const waiting = outcome.waiting!;
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.current, "delivery_review", "拒绝旧审批不得偷偷推进步骤");
  assert.equal(state.approval_request.subject_id, state.approval_subject.id);
  assert.equal(gate.get(waiting.waiting_id)?.status, "waiting", "实际持久化 Cloud waiting");
  const item = (waiting.question.questions as Array<{ question: string; options: string[] }>)[0];
  const resolved = gate.resolve(waiting.waiting_id, { stateVersion: waiting.state_version,
    decision: item.options[0], answers: { [item.question]: item.options[0] } });
  assert.equal((await session.resumeWithDecision(resolved)).status, "turn_finished");
  const after = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
  assert.equal(after.current, "push", "真实回答经内核 Hook 登记后可完成原步骤");
  assert.equal(after.approval_request, undefined, "完成后清除重确认请求");
  assert.equal(pendingKernelReview(cwd, kernel, gate, "T5"), undefined);
  assert.match(JSON.stringify(model.requests), /交付增量无需调整/);
});
