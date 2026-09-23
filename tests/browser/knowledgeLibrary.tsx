import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const job: DomainKnowledgeJob = { id: "dkx-browser", issue_no: "REQ-knowledge-fixture", title: "交易履约领域", scope: "订单状态、取消与库存回补", operator: "领域维护人", created_at: "2026-09-22T01:00:00Z", repositories: [{ id: "repo-1", name: "订单服务", repository: "https://example.test/orders.git", branch: "main", path: "src", docs_path: "docs/business" }], knowledge_target: { id: "domain", name: "交易领域知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains/trade" }, material_ids: [], use_wxdoubao: true, ar_codes: ["AR-FIXTURE"], status: "done", stage: "草稿待审查", revisions: {}, skill: { name: "domain-knowledge-extraction", digest: "abcd1234" }, turns: [], publications: [], evidence: [],
  documents: [{ id: "states", title: "订单状态与取消规则", target_id: "domain", path: "domains/trade/states.md", layer: "domain", content: "# 订单状态与取消规则\n\n订单从待支付进入已支付，随后由履约服务创建发货任务。\n\n## 取消边界\n\n仅未发货订单允许取消，库存回补需要与支付退款分别核对。\n\n> 此处为浏览器验收夹具，不代表真实业务规则。", sources: "上传资料：交易规格 v2 / 第 3 章\n\n源码：订单服务 / src/order.ts @ fixture\n\n无线豆包：查询“取消订单的边界”，来源版本未知。", revision: 1, selected: true, base_content: null, base_revision: "a".repeat(40), history: [] }, { id: "integration", title: "订单服务的跨仓职责", target_id: "repo-1", path: "docs/business/integration.md", layer: "repository", content: "# 跨仓职责\n\n订单仓记录业务状态，履约仓维护物流处理。", sources: "订单仓与履约仓的接口定义（测试夹具）", revision: 1, selected: true, base_content: null, base_revision: "a".repeat(40), history: [] }] };
job.evidence = [
  ...Array.from({ length: 55 }, (_, index) => ({ tool: "component_source", action: "list", path: `src/business/module-${index}`, preview: "目录结果\n" + "src/business/a.ts\n".repeat(80), at: new Date(Date.parse("2026-09-22T01:00:00Z") + index * 1000).toISOString(), status: "returned" })),
  { tool: "component_source", action: "read", path: "src/orders.ts", status: "failed", error: "文件读取失败，请核对版本" },
  { tool: "research_note", preview: "## 阶段结论\n正在核对取消订单的边界。" },
  { tool: "business_knowledge", action: "knowledge_search", status: "available", query: { question: "订单取消规则" }, result: { source: "业务规格", content: "检索依据正文" } },
];
job.documents.push({ ...job.documents[1], id: "agents", title: "模型生成的规范主题", path: "docs/business/AGENTS.md", content: "# 仓库规范\n遵守业务规则。" });
const skill = { name: "domain-knowledge-extraction", digest: "first", can_manage: true, files: { "SKILL.md": "---\nname: domain-knowledge-extraction\ndescription: 领域知识方法\n---\n读取本包引用。", "references/domain.md": "研究领域规则。" }, versions: [] };
const calls: any[] = [], errors: string[] = [];
let taskDeleted = false;
window.addEventListener("error", e => errors.push(e.message)); window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined; let result: unknown;
  if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/knowledge-materials") { calls.push({ action: "upload", ...input }); result = { id: "material-zip", name: input.name, version: input.version, scope: "本次萃取任务", state: "ready", sections: 2, images: [{ path: "images/state.png" }], warnings: ["未解析附件：图.svg"] }; }
  else if (path === "/domain-extraction") {
    if (input) { calls.push({ action: "create", ...input }); result = job; }
    else result = { records: taskDeleted ? [] : [job], knowledge_target: null };
  }
  else if (path.endsWith("/archive-targets")) {
    for (const target of input.targets) {
      const old = [job.knowledge_target, ...job.repositories].find(t => t.id === target.id)!;
      for (const doc of job.documents.filter(d => d.target_id === old.id)) { doc.path = target.docs_path + doc.path.slice(old.docs_path.length); delete doc.remote_review; }
      Object.assign(old, target);
    }
    for (const entry of input.documents ?? []) { const doc = job.documents.find(d => d.id === entry.id)!; doc.path = entry.path; doc.archive_path = entry.path; delete doc.remote_review; }
    job.archive_configured = true; job.archive_revision = (job.archive_revision ?? 0) + 1; result = job;
  }
  else if (path === "/domain-extraction/dkx-browser/delete") { calls.push({ action: "delete" }); taskDeleted = true; result = { deleted: true }; }
  else if (path === "/domain-extraction/dkx-browser/run") {
    calls.push({ action: "run", ...input });
    job.turns.push({ id: `turn-${calls.length}`, mode: input.mode, document_ids: input.document_ids, message: input.message, operator: "领域维护人", status: "done", created_at: new Date().toISOString(), reply: "已核对资料，保留未选文档。", proposals: input.mode === "discuss" ? [] : [{ document: { ...job.documents[0], content: job.documents[0].content + "\n\n取消前需要校验发货状态，并保留幂等处理依据。" }, base_revision: job.documents[0].revision, status: "pending" }] }); result = job;
  } else if (path.endsWith("/edit")) { const doc = job.documents.find(d => d.id === input.document.id)!; doc.history.push({ revision: doc.revision, title: doc.title, content: doc.content, sources: doc.sources, operator: "人工", at: new Date().toISOString() }); Object.assign(doc, { content: input.document.content, revision: doc.revision + 1 }); result = job; }
  else if (path.endsWith("/proposal")) { const proposal = job.turns.find(t => t.id === input.turn_id)!.proposals[0]; if (input.decision === "accept") Object.assign(job.documents[0], { content: proposal.document.content, revision: job.documents[0].revision + 1 }); proposal.status = input.decision === "accept" ? "accepted" : "discarded"; result = job; }
  else if (path.endsWith("/remote")) { job.documents.find(d => d.id === input.document_id)!.remote_review = { id: "remote-1", target_content: "目标分支新增的人工规则", target_revision: "b".repeat(40), branch: "codex/knowledge-fixture", branch_revision: "c".repeat(40), branch_content: "MR 中的人工补充", reviewed: false }; result = job; }
  else if (path.endsWith("/reconcile")) { Object.assign(job.documents[0], { content: input.document.content, revision: job.documents[0].revision + 1 }); job.documents[0].remote_review!.reviewed = true; result = job; }
  else if (path === "/domain-extraction/dkx-browser") result = job;
  else if (path === "/knowledge-extraction/skills/domain") { if (input) { calls.push({ action: "skill", ...input }); skill.files = input.files; skill.digest = "second"; } result = skill; }
  else if (path === "/component-research") result = { records: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/business-modules") result = { modules: [{ id: "trade", name: "交易业务", description: "交易规则", status: "active", repositories: ["https://example.test/source.git"] }], warnings: [], operations: [] };
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
  await click("研究过程");
  const progress = document.querySelector<HTMLElement>('[aria-label="研究过程记录"]')!;
  check(!progress.querySelector('.knowledge-progress-heading') && !progress.querySelector('input[type="checkbox"]'), "timeline has no activity groups or type filters");
  check(progress.querySelectorAll('.knowledge-progress-entry').length === 40, "timeline initially shows latest 40 summaries");
  check(progress.textContent?.includes("1 条异常"), "timeline keeps failures visible");
  check(progress.querySelector('.knowledge-progress-summary')?.textContent === "订单取消规则", "latest activity appears first");
  await click("查看更早的 18 条动态");
  check(progress.querySelectorAll('.knowledge-progress-entry').length === 58, "can load earlier history into same timeline");
  check([...progress.querySelectorAll('.knowledge-progress-summary')].at(-1)?.textContent === "src/business/module-0", "earlier history is appended at the bottom");
  const summaries = [...progress.querySelectorAll('.knowledge-progress-entry > summary')];
  check(summaries[0]?.textContent?.includes("检索业务知识") && summaries[1]?.textContent?.includes("分析与整理"), "different activities stay in reverse chronological order");
  const record = progress.querySelectorAll<HTMLDetailsElement>('.knowledge-progress-entry')[3]!;
  check(!record.open && !record.querySelector('pre')!.getClientRects().length, "source listing stays folded until explicitly opened");
  record.querySelector('summary')!.click(); await pause();
  check(record.open && record.querySelector('pre')!.getClientRects().length, "record expands to actual source output");
  await click("全部折叠"); check(!progress.querySelector('details[open]'), "collapse all closes detail while retaining summaries");
  await click("审查与修订");
  const outline = document.querySelector('[aria-label="知识仓库与文件"]')!;
  check(outline.textContent?.includes("交易领域知识仓") && outline.textContent?.includes("订单服务"), "files grouped by repository");
  check(outline.textContent?.includes("states.md") && outline.textContent?.includes("integration.md"), "tree displays filenames");
  check(!outline.textContent?.includes("取消边界") && !outline.textContent?.includes("订单状态与取消规则"), "tree has no generated topic or heading hierarchy");
  const original = job.documents[0].content;
  await type("领域知识修订意见", "取消为什么需要校验发货状态？"); await click("仅讨论"); check(job.documents[0].content === original, "discussion is read-only");
  await type("领域知识修订意见", "补充取消时的前置校验"); await click("生成建议"); check(job.documents[0].content === original, "proposal cannot auto-apply");
  await click("差异"); check(button("采纳建议") && !button("采纳建议").disabled, "proposal can be reviewed");
  await click("编辑"); await type("编辑领域文档", original + "\n\n人工补充的边界条件。");
  await click("integration.md"); await click("states.md");
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
  await click("入库与更新");
  const fillInput = async (label: string, value: string) => {
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    check(field, `missing input ${label}`); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  };
  check(document.querySelector<HTMLInputElement>('input[aria-label="domain 归档文档目录"]')?.value === "domains/trade", "archive shows default directory");
  await fillInput("domain 归档文档目录", "archive/trade");
  await fillInput("repo-1 归档文档目录", "docs/new");
  const archive = document.querySelector('[aria-label="领域知识归档位置"]')!;
  archive.querySelectorAll<HTMLDetailsElement>('details').forEach(node => { node.open = true; }); await pause();
  check(archive.textContent?.includes("AGENTS.md") && !archive.textContent?.includes("docs/new/AGENTS.md"), "AGENTS defaults to root while ordinary documents move together");
  check(!archive.querySelector('input[aria-label="integration 文件归档路径"]'), "per-file editing is hidden by default");
  archive.querySelector<HTMLButtonElement>('[aria-label="调整 integration.md 归档路径"]')!.click(); await pause();
  await fillInput("integration 文件归档路径", "docs/interfaces/integration.md");
  check(button("一键创建或更新 MR").disabled, "unsaved archive location blocks publication");
  await click("保存归档位置并检查已有文档");
  check(job.documents[0].path === "archive/trade/states.md", "archive choice maps knowledge to target path");
  check(job.documents.find(d => d.id === "agents")?.path === "AGENTS.md", "root rules saved without filling a file path");
  check(job.documents.find(d => d.id === "integration")?.path === "docs/interfaces/integration.md", "one-off file path saved independently");
  check(!!job.documents[0].remote_review, "new location is compared with existing documents");
  await click("＋ 新建萃取任务");
  const createDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => d.getClientRects().length && d.textContent?.includes("新建领域知识萃取"))!;
  check(!createDialog.textContent?.includes("本次研究范围") && !createDialog.textContent?.includes("业务域名称") && !createDialog.textContent?.includes("业务代码仓地址") && !createDialog.textContent?.includes("归档文档目录"), "creation only asks module and common branch, not topic or repository and archive setup");
  check(document.querySelector<HTMLInputElement>('input[aria-label="统一基准分支"]')?.value === "master", "default baseline is master");
  check(!createDialog.textContent?.includes("无线豆包") && !createDialog.textContent?.includes("适用范围"), "no tool switch or redundant scope field");
  const upload = createDialog.querySelector<HTMLInputElement>('input[aria-label="上传业务资料"]')!;
  check(upload.accept.includes(".zip"), "upload accepts ZIP");
  const chooseFile = [...createDialog.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "选择文件")!;
  check(chooseFile?.getClientRects().length && !chooseFile.disabled, "choose-file button is visible and enabled");
  let pickerOpened = false;
  upload.addEventListener("click", event => { event.preventDefault(); pickerOpened = true; }, { once: true });
  chooseFile.click(); check(pickerOpened, "choose-file button opens its file picker");
  const transfer = new DataTransfer(); transfer.items.add(new File(["ZIP fixture; binary parser verified separately"], "业务资料.zip", { type: "application/zip" }));
  upload.files = transfer.files; upload.dispatchEvent(new Event("change", { bubbles: true }));
  for (let attempt = 0; attempt < 40 && !calls.some(c => c.action === "upload"); attempt++) await pause();
  await pause();
  check(calls.some(c => c.action === "upload" && c.name === "业务资料.zip" && c.version === "" && !("scope" in c)), "ZIP upload requires no metadata");
  check(createDialog.textContent?.includes("1 张图片") && createDialog.textContent?.includes("1 个附件未解析"), "upload shows images and partial parsing warning");
  const module = document.querySelector<HTMLSelectElement>('select[aria-label="萃取业务模块"]')!;
  module.value = "trade"; module.dispatchEvent(new Event("change", { bubbles: true })); await pause();
  await fillInput("统一基准分支", "release/current");
  await fillInput("领域萃取关联单号", "REQ-new");
  await click("创建任务，先清理旧知识");
  const created = calls.find(c => c.action === "create");
  check(created?.module_id === "trade" && created.baseline_branch === "release/current", "creation sends module and one common branch");
  check(!("scope" in created) && !("title" in created) && !("repositories" in created) && !("knowledge_target" in created) && !("use_wxdoubao" in created), "server derives scope and repositories from module maintenance");
  check(created.material_ids.includes("material-zip"), "uploaded bundle associated with new task");
  await click("研究过程");
  await click("删除任务");
  const deletion = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.getClientRects().length && dialog.textContent?.includes("删除领域萃取任务"))!;
  check(deletion.textContent?.includes("已创建的 MR") && deletion.textContent?.includes("来源记录"), "deletion explains preserved publications and provenance");
  await click("取消"); check(!taskDeleted, "cancel leaves task intact");
  await click("删除任务"); await click("确认删除");
  check(taskDeleted && !document.querySelector('[aria-label="萃取任务列表"]')?.textContent?.includes(job.title), "confirmed deletion removes task from list");
  check(!new URL(location.href).searchParams.has("domainExtraction"), "deletion clears stale task URL");
  check(!button("删除任务") && !document.querySelector('[aria-label="研究过程记录"]'), "deletion clears task detail");
  check(!errors.length, errors.join(";")); return { passed: true, width: innerWidth, revision: job.documents[0].revision, skill: skill.digest };
}
if (!new URLSearchParams(location.search).has("scrollCheck")) run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
