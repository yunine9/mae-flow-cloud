import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleReader } from "../../web/src/KnowledgeModuleReader";
import { KnowledgeReviewNotes } from "../../web/src/KnowledgeReviewNotes";
import { KnowledgeMarkdown } from "../../web/src/KnowledgeMarkdown";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";
import type { KnowledgeReviewKind, KnowledgeReviewNote } from "../../src/knowledgeReviewNoteTypes";

const pause = () => new Promise(resolve => setTimeout(resolve, 85));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const documents: KnowledgeDocument[] = [
  { id: "kd-orders", title: "订单规则", content: "# 订单规则\n\n取消订单之前核对发货状态。\n\n支付回调只更新一次。\n\n退款需要通知调用方。", scope: "module", module_ids: ["trade"], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision: "published-v1", history: [], source: { repository: "https://example.test/knowledge.git", branch: "main", path: "docs/orders.md", revision: "v1" } },
  { id: "kd-stock", title: "库存规则", content: "# 库存规则\n\n订单取消后只回补一次库存。", scope: "module", module_ids: ["trade"], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision: "stock-v1", history: [], source: { repository: "https://example.test/knowledge.git", branch: "main", path: "docs/stock.md", revision: "v1" } },
];
const skillFiles = [{ path: "SKILL.md", content: "# 订单核对\n\n先核对关联订单。" }, { path: "references/checks.md", content: "# 核对清单\n\n核对支付与库存。" }];
const submissions: Record<string, { working: boolean; status_label: string }> = {};
const notes = new Map<string, KnowledgeReviewNote[]>(), calls: Array<{ path: string; body?: any }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (url, options) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, body }); let result: unknown;
  if (path === "/knowledge-documents") result = { documents };
  else if (path.startsWith("/knowledge-documents/")) result = documents.find(item => item.id === path.split("/")[2]);
  else if (path === "/business-modules") result = { modules: [{ id: "trade", name: "交易业务", status: "active", description: "", repositories: [], assets: [] }], warnings: [], operations: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/skills") result = { skills: [{ path: "order-check/SKILL.md", name: "订单核对", description: "核对关联业务", loadable: true, digest: "skill-v1", business_module_ids: ["trade"], repositories: [], technologies: [] }], warnings: [], operations: [] };
  else if (path === "/skills/order-check/package") result = { content: skillFiles[0].content, digest: "skill-v1", package_digest: "package-v1", files: skillFiles };
  else if (path.startsWith("/knowledge-review/")) {
    const [,, kind, owner, action] = path.split("/"), key = `${kind}/${decodeURIComponent(owner)}`;
    const saved = notes.get(key) ?? [];
    if (action === "resolve") {
      check(!("revision" in body), "resolve does not bind to a document revision");
      for (const item of saved) if (body.note_ids.includes(item.id)) { item.status = "resolved"; item.resolved_by = "dev"; item.resolved_at = "2026-09-30T10:00:00Z"; }
    } else if (action === "apply") {
      check(!("revision" in body), "Agent revision request does not bind a document revision");
      for (const item of saved) if (body.note_ids.includes(item.id)) { item.status = "submitted"; item.turn_id = `${owner}-turn`; }
      submissions[`${owner}-turn`] = { working: true, status_label: "Agent 正在修改文稿" };
    } else if (body) {
      check(!("revision" in body), "published and Skill comments must not include a revision");
      saved.push({ ...body, id: `note-${calls.length}`, kind: kind as KnowledgeReviewKind, job_id: owner, document_title: body.document_id, operator: "dev", created_at: "2026-09-30T09:00:00Z", status: "open" });
    }
    notes.set(key, saved); result = { notes: saved, submissions };
  } else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
let generation = 0;
function mount() { root.render(<div className="tw-root knowledge-hub is-focused"><KnowledgeModuleReader key={generation++} moduleKey="business:trade" selectedDocumentId="kd-orders" onBack={() => {}} onResearch={() => {}} /></div>); }
mount();
const visible = (element: Element) => !!element.getClientRects().length;
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 70 && !predicate(); i++) await pause(); check(predicate(), message); }
async function click(selector: string, context: ParentNode = document) { const target = context.querySelector<HTMLElement>(selector); check(target && visible(target), `missing visible ${selector}`); target!.click(); await pause(); }
async function clickText(text: string, context: ParentNode = document) { const target = [...context.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === text); check(target && !target.disabled, `missing enabled ${text}`); target!.click(); await pause(); }
async function fill(selector: string, value: string) { const field = document.querySelector<HTMLTextAreaElement>(selector); check(field, `missing ${selector}`); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field!.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
async function hover(line: number) { const row = document.querySelector<HTMLElement>(`.knowledge-markdown [data-l="${line}"]`); check(row, `missing text line ${line}`); row!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); await pause(); }
async function openNotes() { const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && /^提意见(?: · \d+)?$/.test(item.textContent?.trim() || "")); check(target, "module toolbar has a clear feedback entry"); target!.click(); await until(() => document.querySelector('[role="dialog"][data-open] [aria-label="文稿修改意见"]'), "notes dialog opens"); }
async function closeNotes() { await click('[role="dialog"] [data-slot="dialog-close"]'); await until(() => !document.querySelector('[role="dialog"][data-open]'), "notes dialog closes"); }
function submitted(path: string) { return calls.filter(call => call.path === path && call.body); }
async function run() {
  await until(() => document.querySelector('.knowledge-markdown [data-l="3"]'), "module text is available on entry");
  check(!document.querySelector('[role="dialog"]'), "reading starts with the document");
  await hover(3);
  check(!document.querySelector(".annot-fab, .annot-editor"), "hovering text does not expose line annotation UI");
  const from = document.querySelector<HTMLElement>('.knowledge-markdown [data-l="3"]')!, to = document.querySelector<HTMLElement>('.knowledge-markdown [data-l="5"]')!;
  const range = document.createRange(); range.setStart(from.firstChild!, 0); range.setEnd(to.lastChild!, to.lastChild!.textContent!.length);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); await pause();
  check(selection.toString().includes("支付回调") && !document.querySelector(".annot-fab, .annot-editor"), "selecting text remains copyable without selection annotation controls");
  selection.removeAllRanges();
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "请说明已发货订单如何处理取消，并核对重复回调。"); await clickText("保存意见");
  const first = submitted("/knowledge-review/published/kd-orders").at(-1)!;
  check(first?.body.scope === "document" && first.body.document_id === "kd-orders", "overall feedback saves to the selected published document");
  check(!("revision" in first.body) && !("line" in first.body) && !("quote" in first.body), "overall feedback has no revision or line constraints");
  await closeNotes();

  documents[0].revision = "published-v2"; documents[0].content += "\n\n补充了退款通知约定。";
  const readsBefore = calls.filter(call => call.path === "/knowledge-review/published/kd-orders" && !call.body).length;
  mount(); await until(() => calls.filter(call => call.path === "/knowledge-review/published/kd-orders" && !call.body).length > readsBefore, "refresh reloads saved feedback");
  await openNotes();
  const notesPanel = document.querySelector('[role="dialog"][data-open] [aria-label="文稿修改意见"]')!;
  check(notesPanel.textContent?.includes("已发货订单"), "feedback survives reload after the published body changes");
  check(!notesPanel.textContent?.includes("旧版本") && !notesPanel.textContent?.includes("生成修订"), "published feedback uses a simple completion workflow without version gating");
  const firstArticle = [...notesPanel.querySelectorAll("article")].find(item => item.textContent?.includes("已发货订单"))!;
  await clickText("标记已处理", firstArticle);
  check(notes.get("published/kd-orders")![0].status === "resolved" && document.querySelector('[role="dialog"]')?.textContent?.includes("已处理"), "feedback can be marked handled");
  check(calls.some(call => call.path === "/knowledge-review/published/kd-orders/resolve" && call.body.note_ids.length === 1), "completion uses the resolve endpoint");
  await closeNotes();
  await click('button[title="docs/stock.md"]'); await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("只回补一次"), "second module document opens");
  await openNotes(); check(!document.querySelector('[role="dialog"]')?.textContent?.includes("已发货订单"), "other document does not inherit first document's feedback");
  await fill('textarea[aria-label="整体修改意见"]', "说明库存释放与回补的边界。"); await clickText("保存意见");
  check(submitted("/knowledge-review/published/kd-stock").at(-1)?.body.scope === "document", "feedback uses the selected document's endpoint"); await closeNotes();
  await click('button[title="docs/orders.md"]'); await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("补充了退款通知"), "first document reopens");
  await openNotes(); check(document.querySelector('[role="dialog"]')?.textContent?.includes("已处理") && !document.querySelector('[role="dialog"]')?.textContent?.includes("库存释放"), "returning preserves completion and document isolation"); await closeNotes();

  const skill = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="模块知识目录"] button')].find(item => item.textContent?.includes("订单核对") && item.querySelector(".lucide-puzzle"));
  check(skill, "module Skill is available"); skill!.click(); await until(() => document.querySelector('.knowledge-markdown [data-l="3"]')?.textContent?.includes("关联订单"), "Skill markdown opens");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "说明读取哪个订单字段。"); await clickText("保存意见");
  const skillNote = submitted("/knowledge-review/skill/order-check").at(-1)!;
  check(skillNote?.body.document_id === "SKILL.md" && skillNote.body.scope === "document" && !("revision" in skillNote.body), "Skill feedback is scoped by package file without a digest"); await closeNotes();
  const reference = document.querySelector<HTMLButtonElement>('button[title="references/checks.md"]');
  if (!reference) { const folder = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="模块知识目录"] button')].find(item => item.textContent?.trim() === "references"); check(folder, "Skill references folder is available"); folder!.click(); await pause(); }
  await click('button[title="references/checks.md"]'); await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("核对支付与库存"), "Skill reference file opens");
  await openNotes(); check(!document.querySelector('[role="dialog"]')?.textContent?.includes("读取哪个订单字段"), "feedback remains isolated between files in the same Skill package"); await closeNotes();

  const draftView = (token: number) => <div className="tw-root"><KnowledgeReviewNotes refreshToken={token} kind="domain" jobId="dkx-feedback" documentId="domain-rules"><KnowledgeMarkdown text={"# 领域规则\n\n请完善取消与回调的处理。"} /></KnowledgeReviewNotes></div>;
  root.render(draftView(0));
  await until(() => calls.some(call => call.path === "/knowledge-review/domain/dkx-feedback" && !call.body), "draft feedback component loads");
  await hover(3); await click('[aria-label="给第 3 行添加批注"]');
  await fill('.annot-editor textarea', "补充重复回调的处理。"); await clickText("记下");
  check(!calls.some(call => call.path.endsWith("/apply")), "记下一行意见不会立即启动 Agent");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "由 Agent 补齐取消与重复回调的边界，并整理文稿。");
  await clickText("发送并修改");
  const saveIndex = calls.findIndex(call => call.path === "/knowledge-review/domain/dkx-feedback" && call.body);
  const applyIndex = calls.findIndex(call => call.path === "/knowledge-review/domain/dkx-feedback/apply" && call.body);
  check(saveIndex >= 0 && applyIndex > saveIndex, "one click saves the typed feedback before requesting Agent changes");
  const line = calls[saveIndex].body, draft = submitted("/knowledge-review/domain/dkx-feedback").at(-1)!.body, applied = calls[applyIndex].body, saved = notes.get("domain/dkx-feedback")!;
  check(draft.scope === "document" && draft.note.includes("由 Agent") && !("revision" in draft), "draft feedback is overall guidance without revision binding");
  check(line.scope === "line" && line.line === 3 && line.quote.includes("取消"), "逐行意见带上行号及原文");
  check(applied.note_ids.length === 2 && saved.every(note => applied.note_ids.includes(note.id) && note.status === "submitted"), "逐行和整篇意见一次提交");
  await closeNotes();
  check(document.querySelector('[role="status"]')?.textContent?.includes("Agent 正在修改文稿"), "关闭意见弹窗后仍能看见 Agent 正在修改");
  root.render(<div />); await pause(); root.render(draftView(1)); await pause();
  check(document.querySelector('[role="status"]')?.textContent?.includes("Agent 正在修改文稿"), "重新进入文稿仍显示真实修改状态");
  submissions["dkx-feedback-turn"] = { working: false, status_label: "修改完成，请审阅文稿" };
  root.render(draftView(2)); await pause();
  check(document.querySelector('[role="status"]')?.textContent?.includes("修改完成"), "轮询完成后提示审阅");
  check(!document.querySelector('.animate-spin'), "完成后不再显示修改动画");
  root.render(<div className="tw-root"><KnowledgeReviewNotes kind="component" jobId="whole-feedback" documentId="" scope="study" /></div>); await pause();
  await clickText("整体文稿意见"); await fill('textarea[aria-label="整体修改意见"]', "缺少异常处理，概述中有重复。"); await clickText("发送并修改");
  check(submitted("/knowledge-review/component/whole-feedback").at(-1)?.body.scope === "study", "整体意见无需选择具体文档");
  await closeNotes();

  const workingView = (working: boolean) => <div className="tw-root"><KnowledgeReviewNotes kind="domain" jobId="dkx-working-feedback" documentId="active-rules" working={working}><KnowledgeMarkdown text={"# 运行中的研究\n\n当前文稿仍可阅读。"} /></KnowledgeReviewNotes></div>;
  root.render(workingView(true));
  await until(() => calls.some(call => call.path === "/knowledge-review/domain/dkx-working-feedback" && !call.body), "active research feedback loads");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "本轮结束后补充异常分支的说明。");
  const activeSubmit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.textContent?.trim() === "Agent 正在修改…");
  check(activeSubmit?.disabled, "active research cannot start a concurrent Agent revision");
  check(document.querySelector('[role="dialog"]')?.textContent?.includes("本轮正在处理"), "active research explains when feedback can be applied");
  await clickText("保存意见");
  check(submitted("/knowledge-review/domain/dkx-working-feedback").length === 1 && !calls.some(call => call.path === "/knowledge-review/domain/dkx-working-feedback/apply"), "feedback may be saved while research runs without launching an Agent");
  root.render(workingView(false)); await pause();
  await clickText("发送并修改");
  const laterApply = calls.find(call => call.path === "/knowledge-review/domain/dkx-working-feedback/apply");
  check(laterApply?.body.note_ids[0] === notes.get("domain/dkx-working-feedback")?.[0].id && submitted("/knowledge-review/domain/dkx-working-feedback").length === 1, "after execution completes the saved feedback can be submitted without retyping or duplicate save");
  check(!errors.length, errors.join("; "));
  root.unmount(); return { passed: true, width: innerWidth, publishedNotes: notes.get("published/kd-orders")?.length, skillNotes: notes.get("skill/order-check")?.length, agentRequests: 3 };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });
