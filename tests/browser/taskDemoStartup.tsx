import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import TaskDemoWorkspace from "../../web/src/TaskDemoWorkspace";
import { createTaskDemoPreviewInput } from "../../web/src/TaskDemoPreview";
import kernelFlow from "../../kernel/flow/flow.json";

// 复用资料夹具，但通过正式 sourceTaskId 入口和真实组件读取快照。
// 缺卡时补充服务永远不返回，确保进入、阶段切换和主子任务导航均不依赖模型。
const fixture = createTaskDemoPreviewInput();
const snapshots = [fixture.snapshot, ...(fixture.relatedSnapshots ?? [])];
const titles = Object.fromEntries(Object.entries(kernelFlow.steps).map(([id, step]) => [id, step.title]));
const phaseNames = fixture.snapshot.task.progress!.phases;
const missingPhase = "写设计";
const requests: Array<{ method: string; path: string }> = [];
const generationRequests: string[] = [];
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

for (const snapshot of snapshots) {
  const missingSteps = new Set([
    ...(snapshot.phase_steps?.[missingPhase] ?? []),
    ...(snapshot.task.parent_task_id ? snapshot.phase_steps?.[phaseNames[0]] ?? [] : []),
  ]);
  snapshot.conversation.items = snapshot.conversation.items.filter(item => item.kind !== "card" || !missingSteps.has(item.step));
  snapshot.step_titles = titles;
  snapshot.card_contexts = {};
  for (const [index, item] of snapshot.conversation.items.entries()) {
    if (item.kind !== "card") continue;
    item.step = item.step === "requirement_analysis" ? "" : titles[item.step] ?? item.step;
    const previous = snapshot.conversation.items[index - 1];
    snapshot.card_contexts[item.waiting_id] = {
      context: `历史确认背景：${item.step || "需求拆分"}`,
      preface: previous?.kind === "turn" ? previous.texts.map(row => row.text).join("\n\n") : undefined,
    };
  }
  if (snapshot.task.waiting) {
    snapshot.task.waiting.step = snapshot.task.waiting.step === "requirement_analysis"
      ? "" : titles[snapshot.task.waiting.step ?? ""] ?? snapshot.task.waiting.step;
  }
}
const originals = snapshots.map(snapshot => JSON.stringify(snapshot));
window.fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  requests.push({ method, path });
  if (path.endsWith("/demo-card")) {
    generationRequests.push(path);
    return new Promise<Response>(() => {});
  }
  if (!["GET", "HEAD"].includes(method)) throw new Error(`正式演示访问了源写接口：${method} ${path}`);
  return fixture.fetchRead(input, init);
};

const root = createRoot(document.getElementById("app")!);
const pause = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const visible = (element: Element) => Boolean(element.getClientRects().length);
async function until(condition: () => unknown, message: string) {
  for (let index = 0; index < 90 && !condition(); index++) await pause();
  check(condition(), message);
}
function assertReady() {
  check(!document.querySelector(".task-demo-loading"), "切换后仍停留在准备演示副本");
  check(!document.body.textContent?.includes("无法打开演示副本"), "缺卡阻止了演示打开");
  check(!document.body.textContent?.includes("正在根据原任务资料补充"), "阶段切换仍等待补充卡片");
  check(generationRequests.length === 0, "进入或切换演示调用了模型补卡接口");
}
async function selectPhase(phase: string, mainTask: boolean) {
  const label = phase === "定规格" ? "写规格" : mainTask && phase === "澄清需求" ? "需求拆分" : phase;
  const control = [...document.querySelectorAll<HTMLElement>('.task-phase[role="button"]')]
    .find(element => visible(element) && element.textContent?.trim() === label);
  check(control, `缺少阶段入口：${label}`);
  control!.click();
  await until(() => document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === phase,
    `无法切换到${label}`);
  assertReady();
}

async function run() {
  check(snapshots.every(snapshot => !snapshot.conversation.items.some(item => item.kind === "card"
    && (snapshot.phase_steps?.[missingPhase] ?? []).map(step => titles[step] ?? step).includes(item.step))),
  "测试资料未移除设计阶段确认卡");
  root.render(<TaskDemoWorkspace sourceTaskId={fixture.snapshot.source_task_id} />);
  await until(() => document.querySelector(".task-demo-guide"), "正式演示入口被缺卡或模型调用阻塞");
  assertReady();
  check(requests.some(row => row.path === "/auth/me"), "未经过正式管理员校验入口");
  check(requests.some(row => row.path === `/tasks/${fixture.snapshot.source_task_id}/demo-snapshot`), "未读取源任务快照");
  for (const phase of phaseNames) await selectPhase(phase, true);
  await selectPhase("澄清需求", true);
  await until(() => document.querySelector('[aria-label="需求拆分关系"]'), "主任务拆分图没有恢复");
  const childButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="需求拆分关系"] button')]
    .find(element => visible(element) && element.textContent?.trim() === "查看子任务");
  check(childButton && !childButton.disabled, "缺少进入子任务的操作");
  childButton!.click();
  const child = snapshots.find(snapshot => snapshot.source_task_id === fixture.snapshot.task.requirement_graph!.repositories[0].task_id)!;
  await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(child.task.title!),
    "缺少启动卡导致子任务无法打开");
  assertReady();
  check(requests.some(row => row.path === `/tasks/${child.source_task_id}/demo-snapshot`), "子任务未从正式快照接口读取");
  for (const phase of phaseNames) await selectPhase(phase, false);
  await selectPhase(missingPhase, false);
  await until(() => document.querySelector('.ws-doc[data-artifact="DEMO-001/story.md"]')?.textContent?.includes("模块职责"),
    "缺少设计卡时没有展示已有设计文档");
  const returnButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => visible(element) && element.textContent?.includes("返回主任务"));
  check(returnButton, "子任务缺少返回主任务操作");
  returnButton!.click();
  await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(fixture.snapshot.task.title!),
    "无法返回主任务演示");
  assertReady();
  check(requests.every(row => ["GET", "HEAD"].includes(row.method)), "演示读取期间发生了源任务写入");
  check(snapshots.every((snapshot, index) => JSON.stringify(snapshot) === originals[index]), "演示修改了原始快照");
  check(errors.length === 0, errors.join("\n"));
  return {
    passed: true, formalEntry: true, phases: phaseNames.length, parentChildRoundTrip: true,
    missingCardMaterialVisible: true, generationRequests: generationRequests.length,
    sourceWrites: requests.filter(row => !["GET", "HEAD"].includes(row.method)).length,
    snapshotReads: requests.filter(row => row.path.endsWith("/demo-snapshot")).length,
  };
}
void run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), errors, requests }); })
  .finally(() => root.unmount());
