import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DomainKnowledgePublicationStatus } from "../../web/src/DomainKnowledgePublicationStatus";
import { KnowledgeSourceCleanup } from "../../web/src/KnowledgeSourceCleanup";
import { projectKnowledgeProduction } from "../../src/knowledgeProductionState";
import type { DomainKnowledgeJob, DomainPublication } from "../../src/domainKnowledgeTypes";
import type { KnowledgeArchivePreview } from "../../src/knowledgeProductionTypes";

const target = { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs" };
const receipt: DomainPublication = { target_id: target.id, state: "opened", branch: "codex/knowledge", url: "https://example.test/mr/479", documents: [],
  mr_participants: { status: "failed", requested: { reviewers: ["reviewer"], approval_approvers: ["approver"] }, message: "人员服务暂时不可用" } };
const job: DomainKnowledgeJob = { id: "dkx-479", title: "订单知识", scope: "订单", module_id: "orders", operator: "owner", created_at: "2026-10-13T08:00:00Z",
  status: "done", stage: "已入库", material_ids: [], revisions: {}, knowledge_target: target, repositories: [], turns: [], evidence: [], publications: [receipt],
  documents: [{ id: "doc", title: "订单规则", target_id: target.id, path: "docs/rules.md", layer: "domain", content: "已发布知识", sources: "", revision: 1,
    selected: true, base_content: null, base_revision: "", history: [], knowledge_document_id: "kd-1", published_revision: "r1", published_document_revision: 1 }] };
job.archive_batches = [{ id: "batch-479", created_at: job.created_at, operator: job.operator, issue_no: "REQ479", state: "done",
  documents: structuredClone(job.documents), targets: [target], publications: [receipt] }];
job.production = projectKnowledgeProduction({ kind: "domain", record: job });
let preview: KnowledgeArchivePreview = { job_id: job.id, title: "知识归档", status_label: "已归档", message: "MR 已创建，后续合入由人处理。", issue_no: "REQ479",
  expected_revisions: { "kd-1": "r1" }, actions: [], targets: [{ ...target, configured: true, status_label: "已归档", message: "", url: receipt.url,
    mr_participants: receipt.mr_participants, files: [], actions: [{ id: "retry-archive", label: "重试设置人员", view: "archive", batch_id: "batch-479", target_id: target.id }] }] };
const cleanup = structuredClone(job);
cleanup.source_cleanup = { repositories: [target], plans: [{ id: "plan-479", target_id: target.id, target_revision: "a", paths: ["docs"],
  entries: [{ path: "docs/old.md", mode: "100644", oid: "b" }], selected_paths: ["docs/old.md"] }],
  publications: [{ ...receipt, cleanup_plan_id: "plan-479", removed_paths: ["docs/old.md"] }] };
let release: (() => void) | undefined, retryFailed = true;
const requests: Array<{ path: string; body: any }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (input, init) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, body });
  if (path.endsWith("/archive/preview")) return new Response(JSON.stringify(preview));
  await new Promise<void>(resolve => { release = resolve; });
  if (path.endsWith("/archive/retry")) {
    if (retryFailed) { retryFailed = false; return new Response(JSON.stringify({ error: "人员接口暂时不可用" }), { status: 503 }); }
    preview = { ...preview, targets: preview.targets.map(row => ({ ...row, mr_participants: { ...receipt.mr_participants!, status: "applied" }, actions: [] })) };
    return new Response(JSON.stringify(preview));
  }
  if (path.endsWith("/source-cleanup/publish")) {
    cleanup.source_cleanup!.publications[0].mr_participants = { ...receipt.mr_participants!, status: "applied" };
    return new Response(JSON.stringify(cleanup));
  }
  throw new Error(`不应请求 ${path}`);
};
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent?.trim() === text);
async function until(test: () => unknown, message: string) {
  for (let i = 0; i < 80 && !test(); i++) await pause();
  check(test(), message);
}
const root = createRoot(document.getElementById("app")!);
async function run() {
  root.render(<DomainKnowledgePublicationStatus job={job} disabled />);
  await until(() => button("重试设置人员"), "人员失败缺少明确入口");
  check(button("重试设置人员")!.disabled, "禁用状态仍可重试");
  check(document.body.textContent?.includes("已归档") && document.querySelector(`a[href="${receipt.url}"]`), "人员失败丢失归档状态或MR链接");
  root.render(<DomainKnowledgePublicationStatus job={job} />); await pause();
  button("重试设置人员")!.click();
  await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes("人员服务暂时不可用"), "预览没有人员结果");
  const dialog = () => document.querySelector('[role="dialog"]')!;
  root.render(<DomainKnowledgePublicationStatus job={job} disabled />); await pause();
  check(button("重试设置人员", dialog())!.disabled, "弹窗已打开时未遵循外部禁用状态");
  root.render(<DomainKnowledgePublicationStatus job={job} />); await pause();
  button("重试设置人员", dialog())!.click();
  await until(() => !!release, "未调用已有归档重试");
  check(button("重试设置人员", dialog())!.disabled, "重试进行中按钮未禁用");
  check(dialog().querySelector(`a[href="${receipt.url}"]`), "重试期间丢失MR链接");
  check(requests.at(-1)?.path.endsWith("/archive/retry") && requests.at(-1)?.body.batch_id === "batch-479" && requests.at(-1)?.body.target_id === target.id, "人员重试没有指定原批次和仓");
  release!(); release = undefined;
  await until(() => dialog().textContent?.includes("人员接口暂时不可用") && !button("重试设置人员", dialog())!.disabled, "失败后不能继续重试");
  button("重试设置人员", dialog())!.click(); await until(() => !!release, "第二次重试未调用");
  release!(); release = undefined;
  await until(() => dialog().textContent?.includes("已按模块配置设置 MR 人员。"), "成功结果未显示");
  check(!button("重试设置人员", dialog()), "成功后仍显示重试");
  check(!requests.some(request => request.path.endsWith("/archive/create")), "补人错误地创建归档");
  root.render(<KnowledgeSourceCleanup task={cleanup} onChange={next => root.render(<KnowledgeSourceCleanup task={next} onChange={() => {}} />)} />);
  await until(() => document.querySelector('[aria-label="萃取前清理旧知识"]'), "清理界面未显示");
  check(button("开始萃取") && !button("开始萃取")!.disabled, "人员失败阻塞后续萃取");
  button("重试设置人员")!.click(); await until(() => !!release, "清理人员重试没有请求");
  check(button("重试设置人员")!.disabled, "清理重试进行中仍可重复点击");
  check(requests.at(-1)?.path.endsWith("/source-cleanup/publish") && requests.at(-1)?.body.target_id === target.id, "清理补人没有限定目标仓");
  check(requests.at(-1)?.body.selected_paths_by_target.domain.join() === "docs/old.md", "人员重试丢失原清理范围");
  release!(); release = undefined;
  await until(() => document.body.textContent?.includes("已按模块配置设置 MR 人员。") && !button("重试设置人员"), "清理人员结果未更新");
  check(button("开始萃取") && document.querySelector(`a[href="${receipt.url}"]`), "补人后丢失原MR或开始萃取操作");
  check(!errors.length, errors.join("; "));
  check(document.documentElement.scrollWidth <= innerWidth, "桌面界面横向溢出");
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); })
  .finally(() => root.unmount());
