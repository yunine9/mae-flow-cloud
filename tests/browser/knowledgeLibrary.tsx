import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const job: DomainKnowledgeJob = { id: "dkx-browser", issue_no: "REQ-knowledge-fixture", title: "交易履约领域", scope: "订单状态、取消与库存回补", operator: "领域维护人", created_at: "2026-09-22T01:00:00Z", repositories: [{ id: "repo-1", name: "订单服务", repository: "https://example.test/orders.git", branch: "main", path: "src", docs_path: "docs/business" }], knowledge_target: { id: "domain", name: "交易领域知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains/trade" }, material_ids: [], use_wxdoubao: true, ar_codes: ["AR-FIXTURE"], status: "done", stage: "草稿待审查", revisions: {}, skill: { name: "domain-knowledge-extraction", digest: "abcd1234" }, turns: [], publications: [], evidence: [],
  documents: [{ id: "states", title: "订单状态与取消规则", target_id: "domain", path: "domains/trade/states.md", layer: "domain", content: "# 订单状态与取消规则\n\n订单从待支付进入已支付，随后由履约服务创建发货任务。\n\n## 取消边界\n\n仅未发货订单允许取消，库存回补需要与支付退款分别核对。\n\n> 此处为浏览器验收夹具，不代表真实业务规则。", sources: "上传资料：交易规格 v2 / 第 3 章\n\n源码：订单服务 / src/order.ts @ fixture\n\n无线豆包：查询“取消订单的边界”，来源版本未知。", revision: 1, selected: true, base_content: null, base_revision: "a".repeat(40), history: [] }, { id: "integration", title: "订单服务的跨仓职责", target_id: "repo-1", path: "docs/business/integration.md", layer: "repository", content: "# 跨仓职责\n\n订单仓记录业务状态，履约仓维护物流处理。", sources: "订单仓与履约仓的接口定义（测试夹具）", revision: 1, selected: true, base_content: null, base_revision: "a".repeat(40), history: [] }] };
const skill = { name: "domain-knowledge-extraction", digest: "first", can_manage: true, files: { "SKILL.md": "---\nname: domain-knowledge-extraction\ndescription: 领域知识方法\n---\n读取本包引用。", "references/domain.md": "研究领域规则。" }, versions: [] };
const calls: any[] = [], errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message)); window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined; let result: unknown;
  if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/domain-extraction") result = { records: [job], knowledge_target: null };
  else if (path === "/domain-extraction/dkx-browser/run") {
    calls.push({ action: "run", ...input });
    job.turns.push({ id: `turn-${calls.length}`, mode: input.mode, document_ids: input.document_ids, message: input.message, operator: "领域维护人", status: "done", created_at: new Date().toISOString(), reply: "已核对资料，保留未选文档。", proposals: input.mode === "discuss" ? [] : [{ document: { ...job.documents[0], content: job.documents[0].content + "\n\n取消前需要校验发货状态，并保留幂等处理依据。" }, base_revision: job.documents[0].revision, status: "pending" }] }); result = job;
  } else if (path.endsWith("/edit")) { const doc = job.documents.find(d => d.id === input.document.id)!; doc.history.push({ revision: doc.revision, title: doc.title, content: doc.content, sources: doc.sources, operator: "人工", at: new Date().toISOString() }); Object.assign(doc, { content: input.document.content, revision: doc.revision + 1 }); result = job; }
  else if (path.endsWith("/proposal")) { const proposal = job.turns.find(t => t.id === input.turn_id)!.proposals[0]; if (input.decision === "accept") Object.assign(job.documents[0], { content: proposal.document.content, revision: job.documents[0].revision + 1 }); proposal.status = input.decision === "accept" ? "accepted" : "discarded"; result = job; }
  else if (path.endsWith("/remote")) { job.documents[0].remote_review = { id: "remote-1", target_content: "目标分支新增的人工规则", target_revision: "b".repeat(40), branch: "codex/knowledge-fixture", branch_revision: "c".repeat(40), branch_content: "MR 中的人工补充", reviewed: false }; result = job; }
  else if (path.endsWith("/reconcile")) { Object.assign(job.documents[0], { content: input.document.content, revision: job.documents[0].revision + 1 }); job.documents[0].remote_review!.reviewed = true; result = job; }
  else if (path === "/domain-extraction/dkx-browser") result = job;
  else if (path === "/knowledge-extraction/skills/domain") { if (input) { calls.push({ action: "skill", ...input }); skill.files = input.files; skill.digest = "second"; } result = skill; }
  else if (path === "/component-research") result = { records: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/business-modules") result = { modules: [], warnings: [], operations: [] };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
createRoot(document.getElementById("app")!).render(<KnowledgeLibrary category="documents" onCategoryChange={() => {}} uploadRequest={0} onOpenTask={() => {}} onManage={() => {}} />);
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === label && b.getClientRects().length)!;
async function click(label: string) { check(button(label), `missing ${label}`); button(label).click(); await pause(); }
async function type(label: string, value: string) {
  const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  check(field, `missing field ${label}`); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function run() {
  for (let i = 0; i < 60 && !button("仅讨论"); i++) await pause();
  const primary = document.querySelector('[aria-label="知识库子页面"]')!;
  check(primary.textContent?.includes("知识文档") && primary.textContent?.includes("知识萃取"), "knowledge library separates documents and extraction");
  check(!primary.textContent?.includes("基础组件萃取") && !primary.textContent?.includes("领域知识萃取"), "extraction types must not share the documents navigation level");
  check(document.querySelector('[aria-label="知识萃取类型"]')?.textContent?.includes("领域知识萃取"), "extraction type navigation nested below extraction");
  const outline = document.querySelector('[aria-label="知识主题与章节"]')!;
  check(outline.textContent?.includes("取消边界"), "knowledge headings visible");
  check(!/domains\/trade|docs\/business|仓外|仓内/.test(outline.textContent ?? ""), "outline organizes knowledge without repository paths");
  [...outline.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "取消边界")!.click(); await pause();
  check(document.activeElement?.textContent === "取消边界", "chapter navigation focuses rendered Markdown heading");
  const original = job.documents[0].content;
  await type("领域知识修订意见", "取消为什么需要校验发货状态？"); await click("仅讨论"); check(job.documents[0].content === original, "discussion is read-only");
  await type("领域知识修订意见", "补充取消时的前置校验"); await click("生成建议"); check(job.documents[0].content === original, "proposal cannot auto-apply");
  await click("差异"); check(button("采纳建议") && !button("采纳建议").disabled, "proposal can be reviewed");
  await click("编辑"); await type("编辑领域文档", original + "\n\n人工补充的边界条件。");
  await click("订单服务的跨仓职责修订 1"); await click("订单状态与取消规则修订 1");
  check(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑领域文档"]')?.value.includes("人工补充"), "switching knowledge topics preserves unsaved edits");
  await click("知识文档");
  check(!document.querySelector('[aria-label="知识萃取类型"]'), "document page has no extraction type tabs");
  await click("知识萃取");
  check(document.querySelector('[aria-label="知识萃取类型"] button[aria-pressed="true"]')?.textContent === "领域知识萃取", "return to last extraction type");
  check(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑领域文档"]')?.value.includes("人工补充"), "switching primary pages preserves unsaved edits");
  await click("基础组件萃取"); await click("领域知识萃取");
  check(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑领域文档"]')?.value.includes("人工补充"), "switching pages preserves unsaved edits");
  await click("保存人工版本"); await click("差异"); check(button("采纳建议").disabled, "stale proposal cannot overwrite manual revision"); await click("放弃");
  await type("领域知识修订意见", "在人工版本上补充校验依据"); await click("生成建议"); await click("差异"); await click("采纳建议"); check(job.documents[0].content.includes("人工补充"), "accepted revision preserves manual content");
  await click("远端合并"); await click("读取远端版本并比较"); check(document.body.textContent?.includes("目标分支新增的人工规则"), "remote text visible for review");
  await type("远端合并稿", job.documents[0].content + "\n目标分支新增的人工规则"); await click("保存合并稿并确认远端版本"); check(job.documents[0].remote_review?.reviewed, "manual reconciliation submitted");
  await click("维护萃取 Skill"); await click("references/domain.md"); await type("Skill 文件内容", "新版方法：核对取消与退款的不同状态。"); await click("发布前差异"); check(document.querySelector('[aria-label="Skill 文件差异"]')?.textContent?.includes("新版方法"), "skill diff previews change"); await click("编辑文件");
  const newFile = document.querySelector<HTMLInputElement>('input[aria-label="新 Skill 文件路径"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(newFile, "references/extra.md"); newFile.dispatchEvent(new Event("input", { bubbles: true })); await pause(); await click("添加引用文件"); await type("Skill 文件内容", "补充引用方法"); await click("发布此 Skill 新版本");
  check(calls.find(c => c.action === "skill")?.files["SKILL.md"] === skill.files["SKILL.md"], "saving a reference preserves the complete package");
  const dialog = document.querySelector('[role="dialog"]')!; const close = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(b => /close|关闭/i.test(b.textContent ?? "") || /close|关闭/i.test(b.getAttribute("aria-label") ?? ""));
  if (close) close.click(); else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause(); await click("正文");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop horizontal overflow");
  const workspace = document.querySelector('[aria-label="领域知识审查工作区"]')!; check(workspace.scrollWidth <= workspace.clientWidth + 2, "review horizontal overflow");
  check(!errors.length, errors.join(";")); return { passed: true, width: innerWidth, revision: job.documents[0].revision, skill: skill.digest };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
