import { projectKnowledgeProduction } from "../../src/knowledgeProductionState.ts";
import { domainKnowledgeTask } from "../../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes.ts";

/** 外层 Node 测试生成 HTTP 响应；浏览器只接收 JSON，不导入后端模块。 */
export function knowledgeLibraryProductionFixtures() {
  const repository = { id: "orders", name: "订单服务", repository: "https://example.test/orders.git", branch: "master", path: "", docs_path: "docs/business" };
  const job: DomainKnowledgeJob = { id: "dkx-review", module_id: "trade", title: "交易规则更新", scope: "订单取消与回补", issue_no: "REQ-447", issue_description: "核对订单取消与回补规则", operator: "dev", created_at: "2026-09-30T01:00:00Z", repositories: [repository], knowledge_target: { ...repository, id: "domain", name: "领域模块知识", repository: "https://example.test/knowledge.git" }, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "待审查", revisions: {}, turns: [], publications: [], evidence: [], documents: [
    { id: "states", title: "订单状态规则", target_id: "domain", path: "docs/business/states.md", layer: "domain", content: "# 订单状态规则\n\n取消前核对发货状态。", sources: "业务规格（测试夹具）", revision: 2, selected: true, base_content: null, base_revision: "fixture", history: [] },
    { id: "integration", title: "订单服务职责", target_id: "orders", path: "docs/business/integration.md", layer: "repository", content: "# 订单服务职责\n\n库存回补需要幂等。", sources: "订单接口（测试夹具）", revision: 1, selected: true, base_content: null, base_revision: "fixture", history: [] },
    { id: "unchanged", title: "现行交易规则", target_id: "domain", path: "docs/business/current.md", layer: "domain", content: "# 现行交易规则\n\n当前正式知识仍可使用。", sources: "正式基线", revision: 1, selected: true, published_document_revision: 1, published_revision: "formal-1", knowledge_document_id: "kd-current", base_content: null, base_revision: "fixture", history: [] },
  ] };
  const running: DomainKnowledgeJob = { ...structuredClone(job), id: "dkx-running", title: "支付规则研究中", status: "running", stage: "正在核对源码", documents: [], evidence: [{ tool: "research_note", preview: "正在核对退款与取消的边界。", status: "returned" }] };
  const created: DomainKnowledgeJob = { ...structuredClone(running), id: "dkx-created", title: "告警管理研究", module_id: "alarm" };
  const initial = projectKnowledgeProduction({ kind: "domain", record: job });
  const noneJob = structuredClone(job);
  noneJob.documents.filter(document => initial.documents.find(item => item.id === document.id)?.changed).forEach(document => { document.selected = false; });
  const publishedJob = structuredClone(job);
  const changed = publishedJob.documents.filter(document => initial.documents.find(item => item.id === document.id)?.changed);
  for (const document of changed) Object.assign(document, { knowledge_document_id: `kd-${document.id}`, published_document_revision: document.revision, published_revision: `formal-${document.id}` });
  publishedJob.archive_batches = [{ id: "batch-1", created_at: "2026-09-30T02:00:00Z", operator: "dev", state: "pending", documents: structuredClone(changed), targets: [job.knowledge_target, repository], publications: [] }];
  const openedJob = structuredClone(publishedJob);
  openedJob.publications = ["domain", "orders"].map((target_id, index) => ({ target_id, branch: "codex/knowledge-fixture", state: "opened", mr_id: index + 1, url: `https://example.test/mr/${index + 1}`,
    documents: openedJob.archive_batches![0].documents.filter(document => document.target_id === target_id).map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) }));
  openedJob.archive_batches![0].state = "done";
  openedJob.archive_batches![0].publications = structuredClone(openedJob.publications);
  openedJob.production = projectKnowledgeProduction({ kind: "domain", record: openedJob });
  const divergedJob = structuredClone(openedJob);
  Object.assign(divergedJob.publications[0], { state: "merged", sync_state: "diverged", diverged_paths: ["docs/business/states.md"], sync_error: "请核对远端差异后再发布：归档仓中的 docs/business/states.md 在 MR 合入后被直接修改过" });
  job.production = initial;
  running.production = projectKnowledgeProduction({ kind: "domain", record: running });
  created.production = projectKnowledgeProduction({ kind: "domain", record: created });
  return { job, running, created, openedJob, divergedJob, taskRows: Object.fromEntries([job, running, created].map(record => [record.id, domainKnowledgeTask(record)])),
    projections: { initial, none: projectKnowledgeProduction({ kind: "domain", record: noneJob }),
      published: projectKnowledgeProduction({ kind: "domain", record: publishedJob }), opened: openedJob.production, diverged: projectKnowledgeProduction({ kind: "domain", record: divergedJob }) } };
}
