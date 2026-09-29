import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeDocuments } from "../../web/src/KnowledgeDocuments";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";

const paragraph = "退款申请必须关联原订单。核对支付结果后，再按订单当前状态处理；失败时保留记录，避免重复提交。";
const source = { repository: "https://example.test/team/knowledge.git", branch: "main", revision: "a".repeat(40), path: "domains/trade/refunds.md" };
const base = { form: "document", scope: "platform", module_ids: [], repositories: [], technologies: [], product_versions: [], active: true, revision: "v1", history: [], when_to_use: "退款处理", indexing: { state: "ready" } };
const documents = [
  { ...base, id: "refund", title: "退款处理说明", source, content: `# 退款处理说明\n\n${paragraph}\n\n[订单状态](states.md#状态核对)\n\n## 处理步骤\n\n1. 核对订单。\n2. 确认退款结果。\n\n| 状态 | 处理方式 |\n| --- | --- |\n| 已支付 | 允许申请 |\n| 已发货 | 先退货 |\n\n\`\`\`ts\n${"const longExample = '" + "example/".repeat(35) + "';"}\n\`\`\`\n\n` + Array.from({ length: 24 }, (_, i) => `## 业务场景 ${i + 1}\n\n${paragraph}\n\n${paragraph}`).join("\n\n") },
  { ...base, id: "states", title: "订单状态说明", source: { ...source, path: "domains/trade/states.md" }, content: `# 订单状态说明\n\n${paragraph}\n\n## 状态核对\n\n核对完成后更新订单。` },
  { ...base, id: "failure", title: "失败处理说明", source: { ...source, path: "domains/errors/retry.md" }, content: "# 失败处理说明\n\n恢复后可以继续读取。" },
] as KnowledgeDocument[];
let failures = 0;
window.fetch = async input => {
  const path = String(input);
  if (path === "/business-modules") return Response.json({ modules: [] });
  if (path === "/knowledge-documents") return Response.json({ documents: documents.map(({ content, ...row }) => row) });
  const doc = documents.find(doc => path === `/knowledge-documents/${doc.id}`);
  if (!doc) throw Error(`Unexpected request ${path}`);
  await new Promise(resolve => setTimeout(resolve, 70));
  if (doc.id === "failure" && failures++ === 0) return Response.json({ error: "文件暂时不可用" }, { status: 503 });
  return Response.json(doc);
};
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const layout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => (b.textContent?.trim() === text || b.getAttribute('aria-label') === text) && b.getClientRects().length);
async function click(text: string) { const b = button(text); check(b, `Missing button ${text}`); b.click(); await pause(); await layout(); }
const paper = () => document.querySelector<HTMLElement>('.component-reader-content')!;
async function run() {
  const root = createRoot(document.getElementById("app")!);
  root.render(<div className="tw-root knowledge-studio" style={{ height: "100vh", padding: 20 }}><KnowledgeDocuments studio category="documents" onCategoryChange={() => {}} onManage={() => {}} onOpenTask={() => {}} /></div>);
  for (let i = 0; i < 40 && !paper()?.querySelector('.md'); i++) await pause();
  check(paper()?.textContent?.includes("退款处理说明"), "Initial document loads");
  const originalReader = document.querySelector('.component-document-reader');
  check(document.querySelector('[aria-label="知识文件目录"] [aria-current="page"]'), "Selected file is marked in directory");
  check(!document.querySelector('[aria-label="知识文件目录"]')?.textContent?.includes('业务场景'), "Tree contains files, not document headings");
  check(parseFloat(getComputedStyle(paper().querySelector('.md-p')!).fontSize) >= 17, "Readable paragraph font");
  check(paper().scrollWidth <= paper().clientWidth + 1, "Long code scrolls inside code block instead of stretching paper");
  paper().scrollTop = 500; paper().dispatchEvent(new Event('scroll')); await pause();
  await click('全屏阅读');
  check(document.querySelector('.component-document-reader') === originalReader, "Fullscreen preserves the same reader");
  check(paper().scrollTop >= 490, "Fullscreen preserves reading position");
  const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
  check(dialog.width >= innerWidth - 4 && dialog.height >= innerHeight - 4, "Reader fills desktop window");
  await click('errors');
  check(button('errors')?.getAttribute('aria-expanded') === 'false', "Folder collapses");
  await click('退出全屏'); await click('全屏阅读');
  check(button('errors')?.getAttribute('aria-expanded') === 'false', "Collapsed folder survives leaving and reopening fullscreen");
  check(paper().scrollTop >= 490, "Repeated fullscreen preserves position");
  const link = [...paper().querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "订单状态");
  check(link, "Relative document link exists"); link.click(); await pause(250);
  check(paper().textContent?.includes('订单状态说明'), "Relative link loads another document");
  check(!paper().textContent?.includes('未找到'), "Anchor waits for asynchronously loaded file");
  check(document.querySelector('[role="dialog"]'), "Selecting a file keeps reader fullscreen");
  await click('errors'); await click('retry.md'); await pause();
  check(paper().textContent?.includes('文件暂时不可用'), "Read failure is visible inside fullscreen reader");
  await click('重试读取'); await pause();
  check(paper().textContent?.includes('恢复后可以继续读取'), "Retry replaces the error with content");
  await click('退出全屏');
  check(document.querySelector('.kd-doc-header h2')?.textContent === '失败处理说明', "Return keeps the selected file");
  await click('refunds.md'); await pause();
  // The app also lives in a narrow desktop side panel. This is not a mobile-device test.
  const studio = document.querySelector<HTMLElement>('.knowledge-studio')!;
  studio.style.width = '560px'; await pause(180); await layout();
  check(document.querySelector('.knowledge-documents')?.classList.contains('library-hidden'), `Narrow desktop panel keeps the paper visible by default (${document.querySelector(".knowledge-documents")?.getBoundingClientRect().width}, ${studio.getBoundingClientRect().width})`);
  check(paper().getBoundingClientRect().width >= 480, "Directory does not squeeze the document");
  check(button('全屏阅读')!.getBoundingClientRect().right <= studio.getBoundingClientRect().right, "Fullscreen remains reachable in narrow panel");
  await click('展开文档列表');
  check(document.querySelector('.kd-library')!.getBoundingClientRect().width >= 250, "Narrow panel can still open directory");
  await click('收起文档列表');
  studio.style.width = ''; await pause();
  document.getElementById('result')!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
run().catch(error => { document.getElementById('result')!.textContent = JSON.stringify({ error: String(error) }); });
