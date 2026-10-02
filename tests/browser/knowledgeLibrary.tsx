import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";
import type { ComponentGovernanceSnapshot } from "../../src/componentKnowledgeTypes";

const pause = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const repository = { id: "orders", name: "订单服务", repository: "https://example.test/orders.git", branch: "master", path: "", docs_path: "docs/business" };
const job: DomainKnowledgeJob = { id: "dkx-review", module_id: "trade", title: "交易规则更新", scope: "订单取消与回补", issue_no: "REQ-447", issue_description: "核对订单取消与回补规则", operator: "dev", created_at: "2026-09-30T01:00:00Z", repositories: [repository], knowledge_target: { ...repository, id: "domain", name: "领域模块知识", repository: "https://example.test/knowledge.git" }, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "待审查", revisions: {}, turns: [], publications: [], evidence: [], documents: [
  { id: "states", title: "订单状态规则", target_id: "domain", path: "docs/business/states.md", layer: "domain", content: "# 订单状态规则\n\n取消前核对发货状态。", sources: "业务规格（测试夹具）", revision: 2, selected: true, base_content: null, base_revision: "fixture", history: [] },
  { id: "integration", title: "订单服务职责", target_id: "orders", path: "docs/business/integration.md", layer: "repository", content: "# 订单服务职责\n\n库存回补需要幂等。", sources: "订单接口（测试夹具）", revision: 1, selected: true, base_content: null, base_revision: "fixture", history: [] },
  { id: "unchanged", title: "现行交易规则", target_id: "domain", path: "docs/business/current.md", layer: "domain", content: "# 现行交易规则\n\n当前正式知识仍可使用。", sources: "正式基线", revision: 1, selected: true, published_document_revision: 1, published_revision: "formal-1", knowledge_document_id: "kd-current", base_content: null, base_revision: "fixture", history: [] },
] };
const running: DomainKnowledgeJob = { ...structuredClone(job), id: "dkx-running", title: "支付规则研究中", status: "running", stage: "正在核对源码", documents: [], evidence: [{ tool: "research_note", preview: "正在核对退款与取消的边界。", status: "returned" }] };
// 萃取滚轮测试(knowledgeExtractionScrollBrowser)复用本夹具:?scrollCheck=1 时不跑下面的整链脚本,
// 并给进行中任务补足一屏放不下的研究动态,让时间线真的需要滚动。
const scrollCheck = new URLSearchParams(location.search).has("scrollCheck");
if (scrollCheck) running.evidence = Array.from({ length: 55 }, (_, index) => ({ tool: "component_source", action: "list", path: `src/business/module-${index}`, preview: "目录结果\n" + "src/business/a.ts\n".repeat(80), at: new Date(Date.parse("2026-09-30T01:00:00Z") + index * 1000).toISOString(), status: "returned" }));
const jobs: DomainKnowledgeJob[] = [job, running];
const documents: KnowledgeDocument[] = [{ id: "kd-current", title: "现行交易规则", content: job.documents[2].content, scope: "module", module_ids: ["trade"], repositories: [], technologies: [], product_versions: [], when_to_use: "订单业务", active: true, revision: "formal-1", history: [], source: { repository: job.knowledge_target.repository, branch: "master", path: "docs/current.md", revision: "fixture" }, research_source: { job_id: job.id, repository: repository.repository, branch: "master", path: "docs/current.md" } }];
// 工程语言 → 基础组件:文件组件的正式指南(按组件仓地址归到组件)及其一条派生规则。
documents.push({ id: "kd-file-guide", title: "文件组件指南", content: "---\nschema: mfc.component-guide/v1\n---\n# 文件组件指南\n\n打开文件后必须关闭句柄。", scope: "component", module_ids: [], repositories: ["https://example.test/file.git"], technologies: ["cpp"], product_versions: [], when_to_use: "C++ 文件读写", active: true, revision: "file-1", history: [], source: { repository: "https://example.test/knowledge.git", branch: "master", path: "docs/file-guide.md", revision: "fixture" } });
const governance: ComponentGovernanceSnapshot = { revision: 3, warnings: [], challenges: [], retention: "按当前版本与去重样本统计。", items: [{ id: "rule-fopen", kind: "rule", original: "fopen", source_digest: "digest-file",
  policy: { level: "shadow", source_digest: "digest-file", owner: "", scope: [], reason: "新候选，尚未人工启用", operator: "", updated_at: "" },
  paradigm: { component: "文件组件", title: "用文件组件打开文件", language: "cpp", need: "读写文件", api: ["File::Open"], applicability: "已链接文件组件", replaces: { identifiers: ["fopen"], imports: [], patterns: [] }, document_id: "kd-file-guide", start_line: 4,
    evidence: [{ repository_id: "file", path: "src/file.cpp", revision: "a".repeat(40), start: 1, end: 9 }], usage_evidence: [] },
  samples: [], stats: { observed: 2, reviewed: 0, exempt: 0, exemption_rate: null }, feedback: [], needs_review: false }] };
const modules = [
  { id: "trade", name: "交易业务", description: "交易规则与团队资产", status: "active", repositories: [repository.repository], assets: [] },
  { id: "alarm", name: "告警管理", description: "告警规则", status: "active", repositories: ["https://example.test/alarm.git"], assets: [] },
];
const calls: Array<{ path: string; input?: any }> = [], errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, input }); let result: unknown;
  if (path === "/knowledge-tasks") {
    const tasks = jobs.map(item => ({ id: item.id, kind: "domain", title: item.title, scope: modules.find(module => module.id === item.module_id)?.name, operator: item.operator, created_at: item.created_at, status: item.status, status_label: item.status === "running" ? "进行中" : "待审查", group: item.status === "running" ? "running" : "attention", stage: item.stage }));
    result = { tasks, warnings: [], summary: { running: tasks.filter(t => t.group === "running").length, attention: tasks.filter(t => t.group === "attention").length, total: tasks.length } };
  } else if (path === "/knowledge-documents") result = { documents };
  else if (path.startsWith("/knowledge-documents/")) { const id = decodeURIComponent(path.split("/")[2]); result = documents.find(item => item.id === id); }
  else if (path === "/skills") result = { skills: [], operations: [], warnings: [] };
  else if (path === "/business-modules") result = { modules, warnings: [], operations: [] };
  else if (path === "/component-repositories") result = { components: [{ id: "file", name: "文件组件", repository: "https://example.test/file.git", branch: "master", path: "", languages: ["cpp"], enabled: true, description: "" }] };
  else if (path === "/component-knowledge") result = governance;
  else if (path === "/component-research" || path === "/domain-extraction/probes") result = { records: [] };
  else if (path.startsWith("/knowledge-review/")) result = { notes: [] };
  else if (path === "/domain-extraction") {
    if (input) { const created = { ...structuredClone(running), id: "dkx-created", title: "告警管理研究", module_id: input.module_id }; jobs.push(created); result = created; }
    else result = { records: jobs, knowledge_target: null };
  } else if (path === `/domain-extraction/${job.id}/selection`) {
    for (const item of job.documents) if (input.ids.includes(item.id)) item.selected = input.selected;
    result = job;
  } else if (path === `/domain-extraction/${job.id}/publish`) {
    for (const item of job.documents.filter(document => input.document_ids.includes(document.id))) {
      check(input.expected_revisions[item.id] === item.revision, "publication submits the reviewed draft revision");
      item.knowledge_document_id = `kd-${item.id}`; item.published_document_revision = item.revision; item.published_revision = `formal-${item.id}`;
      documents.push({ ...documents[0], id: item.knowledge_document_id, title: item.title, content: item.content, revision: item.published_revision, repositories: item.layer === "repository" ? [repository.repository] : [], source: { ...documents[0].source!, path: item.path } });
    }
    job.archive_batches = [{ id: "batch-1", created_at: "2026-09-30T02:00:00Z", operator: "dev", state: "pending", documents: structuredClone(job.documents.filter(d => input.document_ids.includes(d.id))), targets: [job.knowledge_target, repository], publications: [] }]; result = job;
  } else if (/^\/domain-extraction\/dkx-[^/]+$/.test(path)) result = jobs.find(item => item.id === path.split("/")[2]);
  else if (path === "/skills/order-check/submissions") result = { directory: "order-check", id: "submission-1", status: "pending" };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
root.render(<KnowledgeLibrary category="documents" onCategoryChange={() => {}} uploadRequest={0} onOpenTask={() => {}} onManage={() => {}} />);
const visible = (element: Element) => !!element.getClientRects().length;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === text);
async function click(text: string) { const target = button(text); check(target, `missing button ${text}`); for (let i = 0; i < 60 && target!.disabled; i++) await pause(); check(!target!.disabled, `button not ready ${text}`); target!.click(); await pause(); }
async function chooseNew(text: string) {
  await click("新增"); await waitFor('[role="menuitem"]');
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => visible(element) && element.textContent?.trim().startsWith(text));
  check(item, `missing new action ${text}`); item!.click(); await pause();
}
async function clickSelector(selector: string) { const target = document.querySelector<HTMLElement>(selector); check(target && visible(target), `missing visible ${selector}`); target!.click(); await pause(); }
async function waitFor(selector: string) { for (let i = 0; i < 60 && !document.querySelector(selector); i++) await pause(); check(document.querySelector(selector), `not loaded ${selector}; route=${location.search}; error=${document.querySelector('[role="alert"]')?.textContent || "none"}; pending=${button("正在提交…") ? "skill submission" : "none"}`); }
async function fill(selector: string, value: string) { const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector); check(field, `missing field ${selector}`); Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, value); field!.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
async function chooseDestination(query: string, label: string) {
  await clickSelector('[role="combobox"][aria-label="知识归属"]');
  await fill('input[aria-label="搜索模块或语言"]', query);
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter(visible);
  check(options.length === 1 && options[0].textContent?.includes(label), "destination search filters within an in-page popover");
  options[0].click(); await pause();
  check(document.querySelector('[role="combobox"][aria-label="知识归属"]')?.getAttribute("aria-expanded") === "false", "choosing destination closes the popover");
  check(document.querySelector('[role="combobox"][aria-label="知识归属"]')?.textContent?.includes(label), "chosen destination stays visible");
}
async function pick(files: File[]) { const list = new DataTransfer(); files.forEach(file => list.items.add(file)); const field = document.querySelector<HTMLInputElement>('input[type="file"]')!; field.files = list.files; field.dispatchEvent(new Event("change", { bubbles: true })); await pause(); }
function checkFocusedReader(selector: string, name: string) {
  const hub = document.querySelector<HTMLElement>(".knowledge-hub.is-focused");
  check(hub, `${name}: opening a document enters focused reading`);
  const viewport = hub!.getBoundingClientRect();
  check(Math.abs(viewport.left) <= 1 && Math.abs(viewport.top) <= 1 && viewport.width >= innerWidth - 2 && viewport.height >= innerHeight - 2, `${name}: focused surface covers the viewport (${viewport.width}×${viewport.height} at ${viewport.left},${viewport.top})`);
  const header = document.querySelector(".knowledge-hub-header");
  check(!header || !visible(header), `${name}: global library toolbar is hidden`);
  const reader = document.querySelector<HTMLElement>(selector);
  check(reader, `${name}: reader is mounted`);
  const frame = reader!.getBoundingClientRect();
  check(frame.width >= innerWidth - 4 && frame.top <= 160 && frame.height >= innerHeight - frame.top - 4 && Math.abs(frame.bottom - innerHeight) <= 4, `${name}: reader fills the viewport below the compact task controls (${frame.width}×${frame.height}, top ${frame.top}, bottom ${frame.bottom}, viewport ${innerWidth}×${innerHeight})`);
  check(!button("全屏阅读"), `${name}: focused reading needs no second fullscreen action`);
}
function checkLibraryNavigationRestored() {
  check(!document.querySelector(".knowledge-hub.is-focused"), "return leaves focused reading");
  const header = document.querySelector(".knowledge-hub-header");
  check(header && visible(header) && button("新增"), "return restores the library toolbar and new action");
}
async function run() {
  // The initial URL opens a published file without first visiting the module home.
  await waitFor('[aria-label="交易业务知识阅读器"] .knowledge-markdown');
  check(document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("当前正式知识仍可使用"), "module/file deep link loads the formal document");
  checkFocusedReader('[aria-label="交易业务知识阅读器"]', "published module");
  await click("返回知识库"); await waitFor('[aria-label="打开交易业务知识目录"]');
  checkLibraryNavigationRestored();
  check(document.querySelector('[aria-label="业务模块"]') && document.querySelector('[aria-label="工程语言"]'), "home groups modules and languages");
  check(button("新增") && !button("研究知识") && !button("导入 Skill"), "home exposes one new menu without duplicate research or import buttons");
  // 组件规则治理挂在"工程语言 → 基础组件"下:选中组件文档后切到「规则」页签,级别按钮打开同一套设置对话框。
  await clickSelector('[aria-label="打开C++知识目录"]'); await waitFor('[aria-label="模块知识目录"] [aria-label="基础组件"]');
  const componentRow = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="基础组件"] button[aria-expanded]')].find(item => item.textContent?.includes("文件组件"));
  check(componentRow, "language reader lists the enabled component");
  for (let i = 0; i < 60 && !componentRow!.textContent?.includes("1 规则"); i++) await pause();
  check(componentRow!.textContent?.includes("1 规则"), "component node counts its governed rules");
  if (componentRow!.getAttribute("aria-expanded") !== "true") { componentRow!.click(); await pause(); }
  await click("file-guide.md"); await waitFor('[aria-label="文件组件知识"]');
  check(document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("打开文件后必须关闭句柄") && !document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("schema:"), "usage tab shows the guide without its metadata frontmatter");
  const rulesTab = [...document.querySelectorAll<HTMLElement>('[aria-label="文件组件知识"] [role="tab"]')].find(item => item.textContent?.startsWith("规则"));
  check(rulesTab?.textContent?.includes("1"), "rules tab shows the rule count"); rulesTab!.click(); await waitFor('[aria-label="组件规则"] table');
  check(document.querySelector('[aria-label="组件规则"] table')?.textContent?.includes("用文件组件打开文件"), "rules tab lists the component's rules");
  await clickSelector('button[aria-label="设置级别：用文件组件打开文件"]'); await waitFor('[role="dialog"] select[aria-label="使用状态"]');
  const levelDialog = document.querySelector<HTMLElement>('[role="dialog"]')!, levelSelect = levelDialog.querySelector<HTMLSelectElement>('select[aria-label="使用状态"]')!;
  check(levelDialog.textContent?.includes("检查 fopen") && levelSelect.value === "shadow" && [...levelSelect.options].map(o => o.textContent).join("/") === "只记录/提示/关闭", "level button opens the shared policy dialog");
  levelDialog.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click(); await pause();
  check(!calls.some(call => call.path.endsWith("/policy")), "opening the level dialog does not change the policy");
  await click("返回知识库"); await waitFor('[aria-label="打开交易业务知识目录"]');
  await clickSelector('[aria-label="打开交易业务知识目录"]'); await waitFor('[aria-label="模块知识目录"]');
  check(["领域模块知识", "仓内知识", "Skill"].every(label => document.querySelector(`[aria-label="模块知识目录"] [aria-label="${label}"]`)), "business reader has the three agreed groups");
  checkFocusedReader('[aria-label="交易业务知识阅读器"]', "module opened from home");
  await click("返回知识库"); await waitFor('[aria-label="知识目录"]');
  checkLibraryNavigationRestored();
  await clickSelector(".knowledge-task-capsule"); await waitFor('[aria-label="打开领域萃取：支付规则研究中"]');
  await clickSelector('[aria-label="打开领域萃取：支付规则研究中"]'); await waitFor('[aria-label="研究过程记录"]');
  check(new URLSearchParams(location.search).get("kbReview") !== "1", "running task opens execution rather than review");
  check(document.querySelector('[aria-label="研究过程记录"]')?.textContent?.includes("退款与取消"), "task detail reuses recorded research progress");
  await click("返回任务中心"); await waitFor('[aria-label="打开领域萃取：交易规则更新"]');
  await clickSelector('[aria-label="打开领域萃取：交易规则更新"]'); await waitFor('[aria-label="领域知识文件导航"]');
  check(new URLSearchParams(location.search).get("kbReview") === "1", "attention task deep link selects manuscript review");
  checkFocusedReader('[aria-label="领域知识审查工作区"]', "domain manuscript review");
  check(!document.querySelector(".studio-refine-bar"), "review maximizes manuscript space without a persistent refinement form");
  check(!document.querySelector('[aria-label="知识发布与 Git 归档状态"]'), "publication history does not occupy manuscript space before opening it");
  await click("返回任务中心"); await waitFor('[aria-label="打开领域萃取：交易规则更新"]');
  check(new URLSearchParams(location.search).get("kbPage") === "tasks", "review returns to its task center");
  checkLibraryNavigationRestored();
  await clickSelector('[aria-label="打开领域萃取：交易规则更新"]'); await waitFor('[aria-label="领域知识文件导航"]');
  checkFocusedReader('[aria-label="领域知识审查工作区"]', "reopened manuscript review");
  check(button("确认并发布（2）"), "unchanged published file excluded from this batch");
  await clickSelector('input[aria-label="批量选择发布 全部变化文稿"]');
  check(button("确认并发布（0）")?.disabled, "empty selection cannot publish");
  await clickSelector('input[aria-label="批量选择发布 全部变化文稿"]');
  const filename = document.querySelector<HTMLButtonElement>('button[title="docs/business/integration.md · 订单服务职责"]')!; filename.click(); await pause();
  check(job.documents.every(item => item.selected), "opening a file does not change selection");
  await click("确认并发布（2）");
  await clickSelector('[aria-label="发布记录与 Git 归档状态"]');
  await waitFor('[role="dialog"] [aria-label="知识发布与 Git 归档状态"]');
  const published = calls.filter(call => call.path.endsWith("/publish"));
  check(published.length === 1 && JSON.stringify(published[0].input.document_ids) === JSON.stringify(["states", "integration"]), "one POST publishes exactly the two changed manuscripts");
  check(published[0].input.expected_revisions.states === 2 && published[0].input.expected_revisions.integration === 1, "batch carries each draft revision");
  check(new URLSearchParams(location.search).get("kbReview") === "1", "publication stays in review");
  check(document.querySelector('[role="dialog"] [aria-label="知识发布与 Git 归档状态"]')?.textContent?.includes("Git 正在后台归档"), "publication dialog keeps archive progress available");
  const formalLink = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.textContent?.trim() === "查看正式知识");
  check(formalLink && visible(formalLink), "publication dialog offers the formal knowledge link");
  formalLink!.click(); await pause(); await waitFor('[aria-label="交易业务知识阅读器"] .knowledge-markdown');
  check(document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("取消前核对发货状态"), "published file resolves real module from fallback route");
  checkFocusedReader('[aria-label="交易业务知识阅读器"]', "newly published knowledge");
  await click("返回知识库"); await waitFor('[aria-label="知识目录"]');
  checkLibraryNavigationRestored(); await chooseNew("研究知识");
  await chooseDestination("告警", "告警管理");
  await fill('input[placeholder="需求或问题单号"]', "REQ-new");
  check(button("开始研究")?.disabled, "a related issue requires its description before research starts");
  check(!document.body.textContent?.includes("补充业务 AR") && !document.querySelector('[aria-label*="AR"]'), "knowledge research no longer exposes the supplementary AR field");
  await fill('[aria-label="单号描述"]', "修复告警重复通知并核对恢复规则");
  await click("开始研究"); await waitFor('[aria-label="打开领域萃取：告警管理研究"]');
  const created = calls.find(call => call.path === "/domain-extraction" && call.input);
  check(created?.input.module_id === "alarm" && created.input.baseline_branch === "master", "create submits actual module id and baseline branch");
  check(created?.input.issue_description === "修复告警重复通知并核对恢复规则", "research submits the supplied issue description for an accurate MR title");
  check(!Object.prototype.hasOwnProperty.call(created?.input, "ar_codes"), "research does not submit removed supplementary AR data");
  check(new URLSearchParams(location.search).get("kbPage") === "tasks", "creation returns to the knowledge task center");
  await clickSelector('[aria-label="打开领域萃取：告警管理研究"]'); await waitFor('[aria-label="研究过程记录"]');
  await click("返回任务中心"); await waitFor('[aria-label="知识任务中心"]');
  await click("返回知识库"); await waitFor('[aria-label="知识目录"]'); await chooseNew("导入 Skill");
  check(!document.querySelector('textarea'), "import is package-only, with no pasted document input");
  await pick([new File(["ordinary document"], "notes.pdf", { type: "application/pdf" })]);
  check(document.querySelector('[role="alert"]')?.textContent?.includes("SKILL.md") && button("提交并审查")?.disabled, "ordinary document cannot enter Skill import");
  const skill = new File(["---\nname: order-check\ndescription: 核对订单取消条件\n---\n读取 references/rules.md。"], "SKILL.md"), reference = new File(["先校验发货状态。"], "rules.md");
  Object.defineProperty(skill, "webkitRelativePath", { value: "order-check/SKILL.md" }); Object.defineProperty(reference, "webkitRelativePath", { value: "order-check/references/rules.md" });
  await pick([skill, reference]); await chooseDestination("交易", "交易业务"); await click("提交并审查"); await waitFor('[aria-label="知识任务中心"]');
  const submission = calls.find(call => call.path === "/skills/order-check/submissions");
  check(submission?.input.business_module_ids[0] === "trade" && submission.input.files.some((file: any) => file.path === "references/rules.md"), "Skill submission preserves relative attachments and real module ownership");
  check(!calls.some(call => call.path.endsWith("/approve")), "import does not bypass human review");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop shell has no horizontal overflow");
  check(!errors.length, errors.join("; "));
  root.unmount();
  return { passed: true, width: innerWidth, published: published.length, created: created?.input.module_id };
}
if (!scrollCheck) run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });
