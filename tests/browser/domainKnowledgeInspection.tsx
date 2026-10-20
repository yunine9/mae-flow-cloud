import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeInlineReviewNotes } from "../../web/src/KnowledgeInlineReviewNotes";
import { KnowledgeMarkdown } from "../../web/src/KnowledgeMarkdown";
import { DomainKnowledgeExtraction } from "../../web/src/DomainKnowledgeExtraction";
import { DomainKnowledgeInspectionBar, DomainKnowledgeInspectionStart, useDomainKnowledgeInspection, type DomainKnowledgeInspection } from "../../web/src/DomainKnowledgeInspection";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import type { KnowledgeReviewNote } from "../../src/knowledgeReviewNoteTypes";

const job = (window as unknown as { __INSPECTION__: DomainKnowledgeJob }).__INSPECTION__;
const params = new URLSearchParams(location.search), recovery = params.get("scenario") === "recovery";
let readError = recovery ? "首次读取失败：服务暂不可用" : "", holdRead = false;
let releaseRead: (() => void) | undefined;
if (recovery) sessionStorage.setItem(`mfc:domain-inspection:${job.id}`, JSON.stringify({ started: false, drafts: [{ documentId: "stock", scope: "document", message: "未提交的库存检视草稿" }] }));
const notes: KnowledgeReviewNote[] = [{ id: "old-note", kind: "domain", job_id: job.id, document_id: "stock", document_title: "库存规则", scope: "document", note: "之前保存的库存意见", status: "open", operator: "alice", created_at: "2026-10-12T00:00:00Z" }];
const calls: Array<{ path: string; body?: any }> = [], errors: string[] = [];
const submissions: Record<string, { working: boolean; status_label: string }> = {};
let attempts = 0, serial = 0;
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (input, init) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
  let value: unknown;
  if (path === `/domain-extraction/${job.id}/reader`) value = job;
  else if (path === `/knowledge-review/domain/${job.id}`) {
    if (!body) {
      if (holdRead) { holdRead = false; await new Promise<void>(resolve => { releaseRead = resolve; }); }
      if (readError === "__timeout__") throw new DOMException("signal timed out", "TimeoutError");
      if (readError) return new Response(JSON.stringify({ error: readError }), { status: 503 });
    }
    if (body) notes.push({ ...body, id: `new-${++serial}`, kind: "domain", job_id: job.id, document_title: body.document_id, status: "open", operator: "alice", created_at: "2026-10-16T00:00:00Z" });
    value = { notes, submissions };
  } else if (path === `/knowledge-review/domain/${job.id}/apply`) {
    attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ error: "网络暂时中断，请重试" }), { status: 503 });
    for (const note of notes) if (body.note_ids.includes(note.id)) { note.status = "submitted"; note.turn_id = "revise-1"; }
    submissions["revise-1"] = { working: true, status_label: "Agent 正在修改文稿" };
    value = { notes, submissions, turn_id: "revise-1" };
  } else if (path === `/domain-extraction/${job.id}/inspection/finish`) {
    job.status = "done"; job.stage = "检视完成，无需修改";
    job.inspection_source!.finished_at = "2026-10-20T00:10:00Z";
    value = job;
  } else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!); let generation = 0;
function mount() { root.render(<div key={generation++} className="tw-root knowledge-hub is-focused" style={{ height: "100vh" }}><DomainKnowledgeExtraction focusId={job.id} surface="knowledge" focused /></div>); }
mount();
const pause = () => new Promise(resolve => setTimeout(resolve, 65));
const visible = (node: Element) => !!node.getClientRects().length;
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function until(test: () => unknown, message: string) { for (let i = 0; i < 80 && !test(); i++) await pause(); check(test(), message); }
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === text); }
async function click(text: string) { const target = button(text); check(target && !target.disabled, `missing enabled ${text}`); target!.click(); await pause(); }
async function fill(selector: string, value: string) { await until(() => !!document.querySelector(selector), `field did not appear ${selector}`); const field = document.querySelector<HTMLTextAreaElement>(selector); check(field, `missing ${selector}`); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field!.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
async function openDocNotes() { const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.startsWith("提意见")); check(target, "missing doc feedback"); target!.click(); await pause(); }
async function navigate(title: string) { const target = document.querySelector<HTMLButtonElement>(`[aria-label="知识仓库与文件"] button[title="${title}"]`); check(target, `missing file ${title}`); target!.click(); await pause(); }
async function hoverLine() { const row = document.querySelector<HTMLElement>('.knowledge-markdown [data-l="3"]'); check(row, "missing annotatable line"); row!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: row!.getBoundingClientRect().left + 30, clientY: row!.getBoundingClientRect().top + 8 })); await pause(); const add = document.querySelector<HTMLButtonElement>('[aria-label="给第 3 行添加批注"]'); check(add, "missing line annotation action"); add!.click(); await pause(); }
let latestInspection: DomainKnowledgeInspection | undefined;
function InspectionRaceHarness({ id, refresh }: { id: string; refresh: number }) {
  const inspection = useDomainKnowledgeInspection({ jobId: id, refreshToken: refresh, working: false, onSubmitted: () => {} });
  latestInspection = inspection;
  return <div className="tw-root" style={{ padding: 24 }}><DomainKnowledgeInspectionStart inspection={inspection} /><DomainKnowledgeInspectionBar inspection={inspection} onOverall={() => {}} onProgress={() => {}} /></div>;
}
async function checkRequestIsolation() {
  let releaseOldRead!: (response: Response) => void, releaseOldSave!: (response: Response) => void;
  const note = (id: string): KnowledgeReviewNote => ({ ...notes[0], id, job_id: id, note: id });
  const response = (id: string) => new Response(JSON.stringify({ notes: [note(id)], submissions: {} }), { headers: { "content-type": "application/json" } });
  let delayed = true, failRefresh = false, delayBackground = false;
  let releaseBackground!: (response: Response) => void;
  const readCounts = new Map<string, number>(), readSignals: AbortSignal[] = [];
  window.fetch = async (input, init) => {
    const path = String(input), id = path.split("/").at(-1)!;
    if (init?.body) return new Promise<Response>(resolve => { releaseOldSave = resolve; });
    readCounts.set(id, (readCounts.get(id) ?? 0) + 1);
    if (init?.signal) readSignals.push(init.signal);
    if (id === "race-a" && delayed) { delayed = false; return new Promise<Response>(resolve => { releaseOldRead = resolve; }); }
    if (delayBackground) { delayBackground = false; return new Promise<Response>(resolve => { releaseBackground = resolve; }); }
    if (failRefresh) return new Response(JSON.stringify({ error: "后台刷新暂时失败" }), { status: 503 });
    return response(id);
  };
  const mountRace = (id: string, refresh = 0) => root.render(<InspectionRaceHarness id={id} refresh={refresh} />);
  mountRace("race-a"); await until(() => releaseOldRead, "旧任务读取已发出");
  for (let refresh = 1; refresh <= 3; refresh++) { mountRace("race-a", refresh); await pause(); }
  check(readCounts.get("race-a") === 1 && !readSignals[0]?.aborted && latestInspection?.loading, "频繁任务轮询复用慢请求，不重发、不取消");
  mountRace("race-b"); await until(() => latestInspection?.jobId === "race-b" && latestInspection.loaded, "切换任务读取成功");
  check(readSignals[0]?.aborted, "切换任务取消旧读取");
  releaseOldRead(new Response(JSON.stringify({ error: "旧任务的迟到错误" }), { status: 503 })); await pause();
  check(latestInspection?.jobId === "race-b" && latestInspection.loaded && !latestInspection.loadError && latestInspection.result.notes[0]?.id === "race-b", "旧读取错误不得写入新任务");
  mountRace("race-a", 1); await until(() => latestInspection?.jobId === "race-a" && latestInspection.loaded, "返回原任务取得新状态");
  const oldSave = latestInspection!.save({ document_id: "orders", scope: "document", note: "旧任务正在保存" });
  await until(() => releaseOldSave, "旧任务保存已发出");
  mountRace("race-b", 1); await until(() => latestInspection?.jobId === "race-b" && latestInspection.loaded, "保存期间切到新任务");
  latestInspection!.updateDraft("stock", "document", "新任务草稿"); await pause();
  releaseOldSave(response("old-save")); await oldSave; await pause();
  check(latestInspection?.result.notes[0]?.id === "race-b" && latestInspection.drafts[0]?.message === "新任务草稿", "旧保存不能覆盖新任务意见或草稿");
  delayBackground = true; mountRace("race-b", 2);
  await until(() => releaseBackground && latestInspection?.loading, "后台刷新等待慢请求");
  check(latestInspection!.loaded && button("开始检视1") && !button("开始检视1")!.disabled, "成功读取后后台刷新不禁用开始检视");
  await click("开始检视1");
  check(button("结束检视并修改") && !button("结束检视并修改")!.disabled, "后台刷新不禁用结束检视");
  const readsBeforeRefresh = readCounts.get("race-b");
  for (let refresh = 3; refresh <= 5; refresh++) { mountRace("race-b", refresh); await pause(); }
  check(readCounts.get("race-b") === readsBeforeRefresh, "后台慢请求同样不被轮询重发");
  releaseBackground(response("race-b")); await until(() => !latestInspection?.loading, "慢请求最终正常完成");
  failRefresh = true; mountRace("race-b", 6);
  await until(() => latestInspection?.loadError, "开始后刷新失败可见");
  check(latestInspection!.result.notes[0]?.id === "race-b" && latestInspection!.drafts[0]?.message === "新任务草稿", "后台读取失败保留已经加载的意见与本地草稿");
  check(button("结束检视并修改")?.disabled && button("重试读取"), "开始后的失败禁用提交并提供读取重试");
  failRefresh = false; await click("重试读取"); await until(() => latestInspection?.loaded && !latestInspection.loading && !latestInspection.loadError, "开始后的读取重试恢复");
  check(latestInspection!.drafts[0]?.message === "新任务草稿" && !button("结束检视并修改")?.disabled, "读取恢复后保留草稿并恢复结束入口");
}
async function runRecovery() {
  await until(() => document.querySelector(".domain-inspection-entry [role=alert]")?.textContent?.includes("首次读取失败"), "首次失败须在开始前显示原因");
  check(button("开始检视")?.disabled && button("重试读取"), "首次失败保留明确读取重试入口");
  check(!document.querySelector(".domain-inspection-bar"), "读取失败不擅自开始检视");
  const snapshot = (visual: string) => {
    check(document.documentElement.scrollWidth <= innerWidth + 2, "读取失败提示不应造成横向溢出");
    document.getElementById("result")!.textContent = JSON.stringify({ passed: true, visual });
  };
  if (params.get("visual") === "initial-error") { snapshot("initial-error"); return; }
  readError = "重试仍失败：服务暂不可用"; holdRead = true;
  await click("重试读取");
  check(document.querySelector(".domain-inspection-read-status[role=status]")?.textContent?.includes("正在读取检视意见"), "重试显示加载过程");
  check(button("开始检视")?.disabled && !button("重试读取"), "读取中禁止重复重试或开始检视");
  releaseRead!(); await until(() => document.querySelector(".domain-inspection-entry [role=alert]")?.textContent?.includes("重试仍失败"), "再次失败仍可重试");
  check(JSON.parse(sessionStorage.getItem(`mfc:domain-inspection:${job.id}`)!).drafts[0]?.message === "未提交的库存检视草稿", "连续读取失败不丢本地草稿");
  check(notes.length === 1 && !calls.some(call => call.body), "读取重试不改写已保存意见或启动研究");
  readError = "__timeout__"; await click("重试读取");
  await until(() => document.querySelector(".domain-inspection-entry [role=alert]")?.textContent?.includes("读取超时，请重试。"), "读取超时有明确中文说明及重试入口");
  check(button("重试读取") && button("开始检视")?.disabled, "超时后仍可重试，不永久禁用");
  readError = ""; await click("重试读取");
  await until(() => button("开始检视1") && !button("开始检视1")!.disabled, "恢复后重新启用开始检视");
  check(!document.querySelector(".domain-inspection-read-status"), "成功读取清除加载错误");
  await click("开始检视1"); await until(() => document.querySelector(".knowledge-reader-dialog[data-open] .domain-inspection-bar"), "恢复后仍按原流程进入全屏");
  check(document.querySelector(".domain-inspection-label")?.textContent?.includes("1 条待保存"), "草稿随开始检视保留");
  await navigate("docs/业务知识/stock.md · 库存规则"); await openDocNotes();
  check(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="整体修改意见"]')?.value === "未提交的库存检视草稿", "检视弹窗恢复完整草稿内容");
  await click("完成");
  Object.assign(job, { id: "dkx-independent-load-retry", task_kind: "inspection", status: "idle", stage: "检视中", inspection_source: { document_id: "orders", started_at: "2026-10-20T00:00:00Z" } });
  sessionStorage.setItem(`mfc:domain-inspection:${job.id}`, JSON.stringify({ started: false, drafts: [{ documentId: "stock", scope: "document", message: "独立检视本地草稿" }] }));
  readError = "独立检视读取失败：服务暂不可用"; mount();
  await until(() => document.querySelector(".knowledge-reader-dialog[data-open] .domain-inspection-bar [role=alert]")?.textContent?.includes("独立检视读取失败"), "自动全屏的独立检视也可看到失败原因");
  check(button("结束检视并修改")?.disabled && button("重试读取"), "独立检视失败禁止提交并提供读取重试");
  if (params.get("visual") === "started-error") { snapshot("started-error"); return; }
  readError = ""; await click("重试读取");
  await until(() => button("结束检视并修改") && !button("结束检视并修改")!.disabled, "自动全屏读取恢复后可以结束检视");
  check(document.querySelector(".domain-inspection-label")?.textContent?.includes("1 条待保存") && !document.querySelector(".domain-inspection-read-status"), "读取恢复只清除加载错误，保留本地草稿");
  check(!calls.some(call => call.body || /\/(?:run|apply)$/.test(call.path)), "读取重试绝不能触发提交或重新研究");
  await checkRequestIsolation();
  check(!errors.length, errors.join("; ")); root.unmount();
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, recovery: true, requestIsolation: true });
}
(async () => {
  if (recovery) { await runRecovery(); return; }
  await until(() => !!button("开始检视1"), "initial inspection entrance did not load saved feedback");
  check(!document.querySelector(".domain-inspection-bar"), "idle reading has no inspection strip");
  await click("开始检视1");
  await until(() => !!document.querySelector('.knowledge-reader-dialog[data-open] .domain-inspection-bar'), "start should enter fullscreen inspection");
  const popup = document.querySelector<HTMLElement>('.knowledge-reader-dialog[data-open]')!, rect = popup.getBoundingClientRect();
  check(rect.width >= innerWidth - 2 && rect.height >= innerHeight - 2, `inspection not fullscreen ${rect.width}x${rect.height}`);
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop horizontal overflow");
  await hoverLine(); await fill('.annot-editor textarea', "补充重复回调的处理");
  check(button("结束检视并修改")?.disabled, "unsaved inline annotation must block finish");
  await navigate("docs/业务知识/stock.md · 库存规则");
  check(document.querySelector('.knowledge-markdown')?.textContent?.includes("取消订单"), "unsaved line annotation must block document navigation");
  await click("记下");
  check(notes.some(note => note.scope === "line" && note.quote?.includes("取消订单")), "line comment should save its original text");
  await until(() => !!document.querySelector('.knowledge-inline-review-note[data-note-id="new-1"]'), "saved line feedback stays below its source block");
  check(document.querySelector('.knowledge-inline-review-host')?.previousElementSibling?.textContent?.includes("取消订单"), "line feedback uses a sibling after matching original text");
  await openDocNotes(); await fill('textarea[aria-label="整体修改意见"]', "整篇补齐取消订单边界"); await click("保存意见"); await click("完成");
  await navigate("docs/业务知识/stock.md · 库存规则");
  await openDocNotes(); await fill('textarea[aria-label="整体修改意见"]', "库存整篇意见还没有点保存"); await click("完成");
  check(!calls.some(item => item.path.endsWith("/apply")), "adding comments must not launch Agent");
  root.render(<div />); await until(() => !document.querySelector('[role="dialog"]'), "old reader unmounts before reload"); mount();
  await until(() => !!document.querySelector('.knowledge-reader-dialog[data-open] .domain-inspection-bar'), "refresh should restore inspection and fullscreen");
  await until(() => document.querySelector('.domain-inspection-label')?.textContent?.includes("3 条已保存"), "refresh should reload saved notes");
  check(document.querySelector('.domain-inspection-label')?.textContent?.includes("1 条待保存"), "unsaved overall/document text survives remount");
  await click("整体意见"); await fill('textarea[aria-label="整体修改意见"]', "全局统一术语，并纠正共享仓范围"); await click("完成");
  if (new URLSearchParams(location.search).has("visual")) { document.getElementById("result")!.textContent = JSON.stringify({ passed: true, visual: true }); return; }
  await click("结束检视并修改");
  await until(() => document.querySelector('.domain-inspection-bar [role="alert"]')?.textContent?.includes("网络暂时中断"), "failed submit remains retryable");
  check(!!document.querySelector('.knowledge-reader-dialog[data-open] .domain-inspection-bar'), "failed submit preserves inspection fullscreen");
  check(notes.length === 5 && notes.every(note => note.status === "open"), "finish saves both unsaved drafts and keeps all pending on failure");
  const allIds = notes.map(note => note.id);
  await click("结束检视并修改");
  await until(() => !!document.querySelector('[aria-label="研究过程记录"]'), "successful finish opens existing research progress");
  check(!document.querySelector('.knowledge-reader-dialog[data-open]'), "successful finish exits fullscreen");
  check(notes.length === 5, "retry must not duplicate saved notes");
  const applied = calls.filter(item => item.path.endsWith("/apply"));
  check(applied.length === 2 && applied.every(item => item.body.note_ids.length === allIds.length && allIds.every(id => item.body.note_ids.includes(id))), "each finish submits all task open comments, including previous saved comments");
  check(!calls.some(item => item.path.endsWith("/run")), "UI should reuse batch review endpoint");
  check(!errors.length, errors.join("; "));
  const line = notes.find(note => note.scope === "line")!;
  const movedNotes = [{ ...line, id: "moved" }, { ...line, id: "same-line", note: "同一行的第二条意见" }, { ...line, id: "cross-line", line_end: 5, quote: "取消订单之前先核对发货状态。 支付回调只处理一次。", note: "跨行意见" }, { ...line, id: "missing", quote: "已经删除的旧规则", note: "不能贴在旧行号" }];
  root.render(<div className="tw-root knowledge-review-notes"><KnowledgeInlineReviewNotes notes={movedNotes}><KnowledgeMarkdown text={"# 新增引言\n\n新的一段内容。\n\n取消订单之前先核对发货状态。\n\n支付回调只处理一次。"} /></KnowledgeInlineReviewNotes></div>);
  await until(() => document.querySelectorAll(".knowledge-inline-review-note").length === 3, "moved and cross-line notes locate by original text; missing text remains unplaced");
  check(document.querySelector('[data-note-id="moved"]')?.closest('.knowledge-inline-review-host')?.previousElementSibling?.getAttribute("data-l") === "5", "historical line 3 must not misplace moved original text");
  check(document.querySelector('[data-note-id="cross-line"]')?.closest('.knowledge-inline-review-host')?.previousElementSibling?.getAttribute("data-l") === "7", "cross-line note follows the final quoted block");
  check(document.querySelector('[data-l="5"]')?.textContent === "取消订单之前先核对发货状态。", "inline notes must not alter original text or source row textContent");
  root.render(<KnowledgeInlineReviewNotes notes={[line]}><KnowledgeMarkdown text={"# 重复规则\n\n取消订单之前先核对发货状态。\n\n取消订单之前先核对发货状态。"} /></KnowledgeInlineReviewNotes>);
  await pause(); check(!document.querySelector(".knowledge-inline-review-note"), "ambiguous quote with mismatching context must not guess the old line");
  const reviewedCount = notes.length;
  notes.splice(0); for (const key of Object.keys(submissions)) delete submissions[key];
  Object.assign(job, { id: "dkx-independent-empty-inspection", task_kind: "inspection", status: "idle", stage: "检视中", inspection_source: { document_id: "orders", started_at: "2026-10-20T00:00:00Z" } });
  mount();
  await until(() => !!document.querySelector('.knowledge-reader-dialog[data-open] .domain-inspection-bar'), "new independent inspection enters fullscreen automatically");
  await until(() => !!button("结束检视") && !button("结束检视")?.disabled, "independent empty inspection can finish after notes load");
  await click("结束检视");
  await until(() => calls.some(item => item.path === `/domain-extraction/${job.id}/inspection/finish`), "empty inspection must call the registered domain-extraction finish route");
  await until(() => !document.querySelector('.knowledge-reader-dialog[data-open]') && !!document.querySelector('[aria-label="研究过程记录"]'), "empty inspection finishes without remaining in fullscreen");
  check(!calls.some(item => item.path.includes(job.id) && /\/(?:apply|run)$/.test(item.path)), "empty inspection must not launch model revision");
  check(!errors.length, errors.join("; "));
  root.unmount();
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, notes: reviewedCount, attempts, independentFinished: true });
})().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), stack: error.stack, calls }); });
