import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { KnowledgeAnswerRecord } from "../../src/knowledgeAnswerTypes";

const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const materialPreview = new URLSearchParams(location.search).get("preview") === "materials";
const errors: string[] = [], calls: Array<{ path: string; method: string; input?: any }> = [];
let account = "alice", serial = 0, rejectStart = false, materialSerial = 0, holdUpload = false, releaseUpload: (() => void) | undefined;
let holdHistory = false, releaseHistory: (() => void) | undefined;
const timestamp = (increment = 0) => new Date(Date.parse("2026-10-10T08:00:00Z") + increment).toISOString();
const quotedText = String.raw`thread_local <Task> & Pool.submit() \path [literal](#evidence-other)`;
const evidence = { id: "ev-fixed", kind: "code" as const, title: "任务池重试实现", content: `// 本次固定版本原文\nretryLimit = 3;\n${quotedText}\n`, digest: "fixed-digest", retrieved_at: timestamp(), revision: "a".repeat(40), repository: "https://example.test/tasks.git", path: "src/retry.ts", start_line: 42, end_line: 45 };
const escapedQuote = String.raw`thread\_local &lt;Task&gt; &amp; Pool\.submit\(\) \\path \[literal\]\(\#evidence\-other\)`;
const completedAnswer = (body: string) => ({ markdown: `${body} 当前读取提交中的任务池重试实现；集成环境配置尚未确认。\n\n${"`".repeat(4)}ts\nretryLimit = 3;\n${"`".repeat(5)}\n\n**来源原句：**\n\n> retryLimit = 3;\n> ${escapedQuote}\n\n[实现依据 C\\+\\+ \\[固定版\\]](#evidence-ev-fixed)`, evidence_ids: [evidence.id], unknowns: ["集成环境是否覆盖该配置仍需确认。"] });
const records: KnowledgeAnswerRecord[] = [{ id: "qa-existing", owner: account, question: "任务失败怎么重试？", context: { module_ids: ["trade"] }, status: "done", stage: "done", created_at: timestamp(), updated_at: timestamp(), evidence: [evidence], activity: [{ at: timestamp(), stage: "checking", message: "已检查回答结构、引用编号和原文片段" }], warnings: [], answer: completedAnswer("该提交中的重试次数上限为三次。") }];

window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (url, options) => {
  const path = String(url), method = options?.method || "GET", input = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, method, input }); let result: unknown;
  if (path === "/auth/me") result = { username: account, role: "developer" };
  else if (path === "/knowledge-tasks") result = { summary: { running: 0, attention: 0, total: 0 }, module_activity: [] };
  else if (path === "/memory-insights") result = { memories: [] };
  else if (path === "/knowledge-answers/catalog") result = {
    modules: [{ id: "trade", name: "交易业务" }], repositories: [{ id: "tasks", name: "任务服务", repository: evidence.repository }],
    documents: [{ id: "kd-pool", title: "任务池组件指南", module_ids: [], revision: "pool-v1" }],
    sources: [{ kind: "knowledge", label: "知识文档", available: true, detail: "正式知识与组件指南" }, { kind: "everycode", label: "Every Code", available: true, detail: "已配置，实际可用性以查询为准" }],
  };
  else if (path === "/knowledge-answers" && method === "GET") {
    const snapshot = structuredClone(records.filter(item => item.owner === account));
    if (holdHistory) await new Promise<void>(resolve => { releaseHistory = resolve; });
    result = { answers: snapshot };
  }
  else if (path === "/knowledge-materials" && method === "POST") {
    if (holdUpload) await new Promise<void>(resolve => { releaseUpload = resolve; });
    materialSerial += 1;
    result = { id: `material-00000000-0000-0000-0000-${String(materialSerial).padStart(12, "0")}`, name: input.name, version: input.version, scope: input.scope, state: "ready", sections: 2, images: [{ path: "figure.png" }], warnings: ["图片仅保留，尚未核验图中文字。"] };
  }
  else if (path === "/knowledge-answers" && method === "POST") {
    if (rejectStart) return new Response(JSON.stringify({ error: "服务暂时不可用" }), { status: 503 });
    serial += 1;
    const record: KnowledgeAnswerRecord = { id: `qa-${serial}`, owner: account, question: input.question, context: input.context, status: "running", stage: "checking", created_at: timestamp(serial * 1000), updated_at: timestamp(serial * 1000), evidence: [evidence], warnings: [], activity: [{ at: timestamp(), stage: "checking", message: "正在检查回答结构、引用编号和原文片段" }], answer: { markdown: "尚未完成的中间回答不能展示", evidence_ids: [evidence.id], unknowns: [] } };
    records.push(record); result = record;
  }
  else if (path.startsWith("/knowledge-answers/")) {
    const [id, action] = path.slice("/knowledge-answers/".length).split("/");
    const record = records.find(item => item.id === id && item.owner === account);
    check(record, "only the current account can read its answers");
    if (action === "cancel") { record!.status = "cancelled"; record!.updated_at = timestamp(20000); }
    if (action === "feedback") record!.feedback = { useful: input.useful, comment: input.comment, at: timestamp(21000) };
    result = record;
  }
  else if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/business-modules") result = { modules: [], operations: [], warnings: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/skills") result = { skills: [], operations: [], warnings: [] };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { status: method === "POST" && path === "/knowledge-answers" ? 202 : 200, headers: { "content-type": "application/json" } });
};

let root = createRoot(document.getElementById("app")!);
const render = () => root.render(<KnowledgeLibrary onOpenTask={() => {}} />);
render();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
async function click(label: string) { const item = button(label); check(item, `missing button: ${label}`); item!.click(); await pause(); }
async function openReadEvidence() {
  const item = document.querySelector<HTMLButtonElement>('[aria-label="本次已查阅资料"] button');
  check(item, "already-read source has an original snapshot entry"); item!.click(); await pause();
}
async function waitFor(selector: string) {
  for (let index = 0; index < 35; index += 1) { if (document.querySelector(selector)) return; await pause(); }
  throw new Error(`missing selector: ${selector}`);
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  check(input, `missing field ${label}`);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input!.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function choose(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
async function pick(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="上传问答资料"]')!;
  check(input, "question attachment upload input is available");
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
async function remount() { root.unmount(); await pause(); root = createRoot(document.getElementById("app")!); render(); await waitFor('[aria-label="知识问答工作区"]'); await pause(); }
function navigateAnswer(id = "") {
  const url = new URL(location.href); url.search = new URLSearchParams({ kbPage: "ask", ...(id ? { kbAsk: id } : {}) }).toString();
  history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate"));
}

async function run() {
  await waitFor('[aria-label="知识问答问题"]'); await pause();
  check(button("知识问答")?.getAttribute("aria-pressed") === "true", "top level Q&A entry is active");
  check(document.body.textContent?.includes("根据实际查阅的资料回答") && !document.body.textContent?.includes("核对依据后"), "composer describes source-based answering without claiming semantic approval");
  await fill("知识问答问题", "异步任务重试的 UT 怎么写？");
  await click("补充范围与参考文档（可选）"); await choose("问答相关模块", "trade"); await choose("问答参考文档", "kd-pool");
  await click("补充原始资料（可选）");
  const submitBox = button("提问")!.getBoundingClientRect(), mainBox = document.querySelector(".ka-main")!.getBoundingClientRect();
  check(submitBox.top >= mainBox.top && submitBox.bottom <= mainBox.bottom, "question action remains visible when attachments expand on desktop");
  check(document.body.textContent?.includes("尚未核验图片内容") && !document.querySelector('[aria-label="知识问答资料上传"]')?.textContent?.includes("自动用于本次萃取"), "question attachment copy states text-only reading without extraction claims");
  const versionDetails = document.querySelector('[aria-label="知识问答资料上传"] details') as HTMLDetailsElement;
  versionDetails.open = true; await fill("资料版本（可选）", "v2.1");
  holdUpload = true;
  await pick([new File(["条件成立时才重试"], "规则说明.md", { type: "text/markdown" }), new File(["不需要的参考资料"], "旧规则.txt", { type: "text/plain" })]);
  check(button("提问")?.disabled, "question cannot start before material parsing finishes");
  for (let index = 0; index < 35 && !releaseUpload; index += 1) await pause();
  check(releaseUpload, "attachment request reaches upload endpoint"); holdUpload = false; releaseUpload!();
  await waitFor('[aria-label="移除 旧规则.txt"]');
  check(document.querySelector('[aria-label="知识问答资料上传"]')?.textContent?.includes("1 条解析提醒"), "parser warnings are described as reminders rather than unparsed attachment counts");
  const uploaded = calls.find(call => call.path === "/knowledge-materials")!;
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(uploaded.input.content_base64), character => character.charCodeAt(0)));
  check(uploaded.input.scope === "本次知识问答" && uploaded.input.version === "v2.1" && decoded === "条件成立时才重试", "upload preserves UTF-8 content, version, and question-specific scope");
  const uploadCount = calls.filter(call => call.path === "/knowledge-materials").length;
  await pick(Array.from({ length: 9 }, (_, index) => new File(["extra"], `extra-${index}.txt`)));
  check(calls.filter(call => call.path === "/knowledge-materials").length === uploadCount && document.querySelector('[aria-label="知识问答资料上传"] [role="alert"]')?.textContent?.includes("最多关联 10"), "more than ten selected attachments are rejected before uploading");
  await click("移除 旧规则.txt");
  check(!calls.some(call => call.method === "DELETE" || call.path.includes("/knowledge-materials/")), "removing an attachment only detaches it from the draft");
  await click("知识库"); await waitFor('[aria-label="知识目录"]'); navigateAnswer(); await waitFor('[aria-label="移除 规则说明.md"]');
  await remount();
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "异步任务重试的 UT 怎么写？", "question draft survives page remount");
  if (!document.querySelector('[aria-label="问答相关模块"]')) await click("补充范围与参考文档（已补充）");
  check(document.querySelector<HTMLSelectElement>('[aria-label="问答相关模块"]')?.value === "trade", "draft scope survives remount");
  check(document.querySelector('[aria-label="知识问答资料上传"]')?.textContent?.includes("规则说明.md · v2.1 · 2 个文本片段") && !document.querySelector('[aria-label="移除 旧规则.txt"]'), "material identifiers and summaries survive navigation and refresh without reattaching a removed file");
  await click("提问"); await waitFor('[aria-label="回答进度"]');
  const creation = calls.find(call => call.path === "/knowledge-answers" && call.method === "POST")!;
  check(creation.input.context.module_ids[0] === "trade" && creation.input.context.document_id === "kd-pool", "request preserves optional module and reference document");
  check(creation.input.context.material_ids.length === 1 && creation.input.context.material_ids[0] === "material-00000000-0000-0000-0000-000000000001" && !creation.input.materials, "question request sends only associated material IDs, without browser summaries or file bodies");
  check(new URLSearchParams(location.search).get("kbAsk") === "qa-1", "created record has a refreshable URL");
  check(document.body.textContent?.includes("检查引用") && !document.body.textContent?.includes("尚未完成的中间回答不能展示"), "checking stage shows real progress and hides draft answers");
  check(document.querySelector('[aria-label="本次已等待时长"]')?.textContent?.startsWith("已等待 "), "running answer reports elapsed time without promising a completion estimate");
  await waitFor('[aria-label="本次已查阅资料"]'); await openReadEvidence();
  check(document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文") && !document.querySelector('[aria-label="知识回答"]'), "running answers expose only already-read source snapshots, without an unfinished answer");
  await click("知识库"); await waitFor('[aria-label="知识目录"]');
  check(!calls.some(call => call.path.endsWith("/cancel")), "leaving Q&A does not cancel server execution");
  navigateAnswer("qa-1"); await waitFor('[aria-label="回答进度"]');
  await remount(); await waitFor('[aria-label="回答进度"]');
  check(document.body.textContent?.includes("异步任务重试的 UT 怎么写？"), "refresh restores selected record");
  const first = records.find(item => item.id === "qa-1")!;
  Object.assign(first, { status: "done", stage: "done", updated_at: timestamp(10000), answer: completedAnswer("使用任务池的可控时钟测试重试边界。") });
  await waitFor('[aria-label="知识回答"]');
  check(!document.querySelector('[aria-label="回答进度"]'), "polling automatically reaches the completed response");
  check(!document.querySelector('[aria-label="本次已查阅资料"]') && document.querySelector('[aria-label="回答依据"]'), "completed answers show their actual citations rather than all research materials");
  const renderedAnswer = document.querySelector('[aria-label="知识回答"]')!;
  check(renderedAnswer.textContent?.includes("当前读取提交中的任务池重试实现；集成环境配置尚未确认"), "completed answer retains its specific conditions in the body");
  check(renderedAnswer.querySelector("blockquote")?.textContent?.includes("retryLimit = 3;") && renderedAnswer.querySelector("button")?.textContent === "实现依据 C++ [固定版]", "host-rendered original quote and source link remain visible with the answer");
  check(renderedAnswer.querySelectorAll("blockquote p")[1]?.textContent === quotedText, "actual original quote text is preserved without visible escapes or entity changes");
  check(renderedAnswer.querySelectorAll("button").length === 1 && !renderedAnswer.querySelector("blockquote button"), "literal source links do not become buttons; the actual source link stays outside the code and quote");
  await click("实现依据 C++ [固定版]"); await waitFor('[aria-label="本次引用原文"]');
  check(document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文") && document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("a".repeat(40)), "citation opens the actual preserved snapshot and version");
  check(!calls.some(call => call.path.startsWith("/knowledge-documents/")), "citation does not substitute a current source document");
  const workspace = document.querySelector<HTMLElement>('[aria-label="知识问答工作区"]')!;
  check(workspace.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 2, "desktop layout has no horizontal overflow");
  check(workspace.querySelector(".ka-main")!.getBoundingClientRect().width > 290, "answer remains readable with citation pane open");
  await click("有问题"); await fill("回答反馈说明", "还需要确认时间推进的测试工具"); await click("提交反馈");
  check(first.feedback?.useful === false && first.feedback.comment.includes("测试工具"), "feedback is saved for the answer");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "不能丢掉的新问题");
  check(!document.querySelector('[aria-label="移除 规则说明.md"]'), "starting a new question does not silently inherit attachments from a submitted answer");
  rejectStart = true; await click("提问"); await pause();
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "不能丢掉的新问题" && document.querySelector('[role="alert"]')?.textContent?.includes("服务暂时不可用"), "failed submission preserves draft and reports error");
  rejectStart = false; await click("提问"); await waitFor('[aria-label="回答进度"]'); await click("停止"); await waitFor('[aria-label="问答未完成"]');
  check(records.find(item => item.id === "qa-2")?.status === "cancelled", "explicit stop cancels selected execution");
  await openReadEvidence();
  check(document.querySelector('[aria-label="本次已查阅资料"]') && document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文") && !document.querySelector('[aria-label="知识回答"]'), "stopped answers keep the original source snapshot accessible and hide drafts");
  await click("重新提问"); await waitFor('[aria-label="回答进度"]');
  check(records.find(item => item.id === "qa-3")?.question === "不能丢掉的新问题", "retry creates a new execution for the original question");
  Object.assign(records.find(item => item.id === "qa-3")!, { status: "failed", error: "来源查询超时，未生成完整回答", updated_at: timestamp(30000) });
  await remount(); await waitFor('[aria-label="问答未完成"]');
  check(document.body.textContent?.includes("来源查询超时") && !document.querySelector('[aria-label="知识回答"]'), "failed execution preserves the cause without showing an unfinished draft");
  await openReadEvidence();
  check(document.querySelector('[aria-label="本次已查阅资料"]') && document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文"), "failed answers preserve access to already-read original evidence after refresh");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "还没提交的另一份问题");
  if (!document.querySelector('[aria-label="上传问答资料"]')) await click("补充原始资料（可选）");
  await pick([new File(["另一份问题的参考资料"], "未提交资料.md")]); await waitFor('[aria-label="移除 未提交资料.md"]');
  navigateAnswer("qa-3"); await waitFor('[aria-label="问答未完成"]');
  await click("重新提问"); await waitFor('[aria-label="回答进度"]');
  check(records.find(item => item.id === "qa-4")?.question === "不能丢掉的新问题", "failed execution can be retried as a new answer");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await remount(); await waitFor('[aria-label="移除 未提交资料.md"]');
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "还没提交的另一份问题", "retrying an older answer preserves a separate unsent question and its attachments across refresh");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "Alice 的私人草稿");
  if (!document.querySelector('[aria-label="上传问答资料"]')) await click("补充原始资料（可选）");
  await pick([new File(["Alice 的资料"], "私人参考.md")]); await waitFor('[aria-label="移除 私人参考.md"]');
  account = "bob"; await remount();
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "", "draft storage is isolated by logged-in account");
  check(!document.querySelector(".ka-history-item"), "history only contains the current account's records");
  check(!document.querySelector('[aria-label="移除 私人参考.md"]'), "attachments are not restored into another account's question draft");
  account = "alice"; await remount(); await waitFor('[aria-label="移除 私人参考.md"]');
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "Alice 的私人草稿", "returning to the original account restores its question and attachments");
  const existing = records.find(item => item.id === "qa-existing")!, completed = structuredClone(existing);
  Object.assign(existing, { status: "running", stage: "researching", updated_at: timestamp(40000), answer: undefined });
  holdHistory = true; releaseHistory = undefined;
  navigateAnswer(existing.id); await remount(); await waitFor('[aria-label="回答进度"]');
  check(releaseHistory, "initial history response can be held after taking its running snapshot");
  Object.assign(existing, completed, { updated_at: timestamp(40000) });
  await waitFor('[aria-label="知识回答"]');
  const selectedHistory = () => document.querySelector('.ka-history-item[aria-current="page"]')?.textContent;
  check(selectedHistory()?.includes("回答完成"), "selected answer updates history to completed even when timestamps are equal");
  holdHistory = false; releaseHistory!(); await pause();
  check(selectedHistory()?.includes("回答完成") && !selectedHistory()?.includes("查阅资料"), "late history snapshot cannot replace a completed answer with its previous running status");
  account = "alice"; navigateAnswer("qa-existing"); await remount(); await waitFor('[aria-label="知识回答"]'); await click("实现依据 C++ [固定版]");
  if (materialPreview) { navigateAnswer(); await waitFor('[aria-label="移除 私人参考.md"]'); }
  check(!errors.length, errors.join("; "));
  return { passed: true, width: innerWidth, created: serial, references: records[0].answer?.evidence_ids.length };
}

run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });
