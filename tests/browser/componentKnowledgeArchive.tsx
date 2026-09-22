import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ComponentKnowledgeArchive } from "../../web/src/ComponentKnowledgeArchive";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
const pause = () => new Promise(r => setTimeout(r, 90));
const errors: string[] = [], requests: any[] = [];
window.addEventListener("error", e => errors.push(e.message)); window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const record = { id: "cr-browser", status: "done", language: "cpp", topic: "组件指南", draft: "新组件规则" } as ComponentResearchRecord;
let archive: DomainKnowledgeJob | undefined;
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined;
  let value: unknown; requests.push({ path, input });
  if (!input) value = { archive: archive ?? null, defaults: { repository: "https://example.test/default-component.git", branch: "main", directory: "docs/components", filename: "component-guide.md" } };
  else if (path.endsWith("/archive")) {
    archive = { id: "dkx-component", component_research_id: record.id, title: "组件指南", issue_no: input.issue_no, scope: "组件归档", operator: "用户", created_at: "now", repositories: [], knowledge_target: { ...input.target, id: "domain", path: "" }, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "待确认", revisions: {}, turns: [], evidence: [], publications: archive?.publications ?? [], documents: [{ id: "guide", title: "组件指南", target_id: "domain", layer: "domain", path: `${input.target.docs_path}/${input.filename}`, content: "# 新组件指南\n新组件规则\n", sources: "源码", selected: true, revision: (archive?.documents[0].revision ?? 0) + 1, base_content: null, base_revision: "", history: [], remote_review: { id: "snapshot", target_content: "# 仓内原文\n人工项目规范\n", target_revision: "a".repeat(40), reviewed: false } }] };
    value = archive;
  } else if (path.endsWith("/reconcile")) { archive!.documents[0] = { ...archive!.documents[0], ...input.document, revision: archive!.documents[0].revision + 1, remote_review: { ...archive!.documents[0].remote_review!, reviewed: true } }; value = archive; }
  else if (path.endsWith("/cleanup-template")) value = { content: "# 当前新规范\n读取 docs/components/guide.md\n" };
  else if (path.endsWith("/cleanup-preview")) {
    archive!.cleanup_plans = [{ id: "clean-1", target_id: "domain", directories: input.paths, target_revision: "a".repeat(40), target_entries: [{ path: "docs/old/obsolete.md", mode: "100644", oid: "old" }, { path: "AGENTS.md", mode: "100644", oid: "agent" }], agent: { ...input.agent, target_content: "旧项目规范\n" }, document_versions: archive!.documents.map(d => `${d.id}:${d.revision}:${d.path}`), confirmed: false }]; value = archive;
  } else if (path.endsWith("/cleanup-confirm")) { archive!.cleanup_plans![0].confirmed = input.confirmed; if (input.preserve_paths) archive!.cleanup_plans![0].preserve_paths = input.preserve_paths; value = archive; }
  else if (path.endsWith("/publish")) { const doc = archive!.documents[0]; archive!.publications = [{ target_id: "domain", state: doc.content === doc.remote_review?.target_content ? "unchanged" : "opened", branch: "codex/component", documents: [], ...(archive!.cleanup_plans?.[0].confirmed ? { cleanup_id: "clean-1", url: "https://example.test/mr/1" } : {}) }]; value = archive; }
  else throw new Error(`Unexpected ${path}`);
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
};
createRoot(document.getElementById("app")!).render(<ComponentKnowledgeArchive record={record} title="组件指南" content="新组件规则" />);
const check = (v: unknown, message: string) => { if (!v) throw new Error(message); };
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
async function click(text: string) { const b = button(text); check(b && !b.disabled, `unavailable button ${text}`); b.click(); await pause(); }
async function fill(label: string, text: string) {
  const parent = [...document.querySelectorAll("label")].find(l => l.textContent?.startsWith(label))!;
  const field = parent?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!; check(field, `missing ${label}`);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function toggle(label: string) { const field = [...document.querySelectorAll("label")].find(l => l.textContent?.includes(label))?.querySelector<HTMLInputElement>('input[type="checkbox"]'); check(field && !field.disabled, `missing ${label}`); field!.click(); await pause(); }
async function run() {
  await pause();
  check([...document.querySelectorAll<HTMLInputElement>("input")].some(i => i.value === "https://example.test/default-component.git"), "archive receives repository default");
  for (const [label, text] of [["目标仓地址", "https://example.test/knowledge.git"], ["关联单号", "REQ-component"], ["Markdown 文件名", "guide.md"]]) await fill(label, text);
  await click("准备提交并检查已有文档");
  check(document.body.textContent?.includes("人工项目规范"), "existing file shown"); check(button("创建或更新 MR").disabled, "existing file requires review");
  check([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(c => !c.checked), "unified cleanup defaults off");
  await click("使用目标分支原文作为合并稿"); await click("保存提交稿并确认远端版本"); await click("创建或更新 MR");
  check(document.body.textContent?.includes("内容相同，无需创建 MR"), "unchanged content has no MR");
  await click("重新载入最新萃取结果并比较"); await click("保存提交稿并确认远端版本");
  await toggle("提交前清理旧知识"); await fill("待删除路径", "docs/old\nAGENTS.md");
  check(button("创建或更新 MR").disabled, "unconfirmed cleanup blocks publish");
  const additions = [...document.querySelectorAll("summary")].find(s => s.textContent?.includes("本次新增内容"))!; additions.click(); await pause();
  await click("按当前知识生成新规范草稿"); await click("预览统一提交清单");
  check(document.body.textContent?.includes("删除 · docs/old/obsolete.md"), "concrete deletion preview"); check(document.body.textContent?.includes("旧项目规范"), "old and new rules visible");
  check(button("创建或更新 MR").disabled, "preview alone does not authorize cleanup");
  await toggle("确认以上删除和新增内容统一提交"); await click("创建或更新 MR");
  check(document.body.textContent?.includes("MR 已创建，本次提交完成"), "success ends at MR creation");
  check([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(c => !c.checked), "applied cleanup resets optional toggles");
  check(requests.filter(r => r.path.endsWith("/publish")).length === 2, "no automatic repair loop");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop has no horizontal overflow"); check(!errors.length, errors.join(";"));
  return { passed: true, width: innerWidth };
}
run().then(value => document.getElementById("result")!.textContent = JSON.stringify(value)).catch(e => document.getElementById("result")!.textContent = JSON.stringify({ error: String(e) }));
