import type { DomainDocument, DomainKnowledgeJob, DomainPublication } from "./domainKnowledgeTypes.ts";
import type { ResearchRecord } from "./componentResearch.ts";
import type { ExtractionJobRecord } from "./knowledgeExtraction.ts";
import type { SkillSubmissionRecord } from "./hostSkillLibrary.ts";
import type { KnowledgeTaskGroup } from "./knowledgeTaskCenterTypes.ts";

import type { KnowledgeProductionAction, KnowledgeDocumentState, KnowledgePublicationState, KnowledgeProductionView } from "./knowledgeProductionTypes.ts";
export type { KnowledgeProductionAction, KnowledgeDocumentState, KnowledgePublicationState, KnowledgeProductionView } from "./knowledgeProductionTypes.ts";
type Input = { kind: "domain"; record: DomainKnowledgeJob; current_revisions?: Record<string, string> }
  | { kind: "component"; record: ResearchRecord; archive?: DomainKnowledgeJob; current_revisions?: Record<string, string> }
  | { kind: "skill-extraction"; record: ExtractionJobRecord }
  | { kind: "skill-submission"; record: SkillSubmissionRecord };

export function currentKnowledgeArchiveBatches(job: DomainKnowledgeJob, current_revisions?: Record<string, string>, currentDocuments = job.documents) {
  const documents = currentDocuments.filter(document => !!document.knowledge_document_id && (!current_revisions || !!current_revisions[document.knowledge_document_id]));
  const targets = [job.knowledge_target, ...job.repositories].filter(target => documents.some(document => document.target_id === target.id));
  return (job.archive_batches ?? []).filter(batch => !!batch.issue_no && batch.state !== "superseded" && batch.documents.length > 0
    && batch.documents.length === documents.length && documents.every(document => batch.documents.some(old => old.id === document.id
      && old.target_id === document.target_id && (old.archive_path ?? old.path) === (document.archive_path ?? document.path)
      && old.knowledge_document_id === document.knowledge_document_id && old.published_revision === (current_revisions
        ? current_revisions[document.knowledge_document_id!] : document.published_revision)))
    && targets.length === batch.targets.length && targets.every(target => batch.targets.some(old => old.id === target.id
      && old.repository === target.repository && old.branch === target.branch && old.docs_path === target.docs_path)));
}
function documentState(job: DomainKnowledgeJob, document: DomainDocument): KnowledgeDocumentState {
  const pending = [...job.turns].reverse().flatMap(turn => turn.proposals.map(proposal => ({ turn, proposal })))
    .find(({ proposal }) => proposal.document.id === document.id && proposal.status === "pending");
  const changed = !!pending || document.published_document_revision !== document.revision;
  const name = document.path || document.title;
  const proposal_problem = !pending ? undefined : pending.turn.status !== "done" ? `${name} 的修改尚未完成，完成后才能确认发布。`
    : pending.proposal.base_revision !== document.revision ? `${name} 的正文已变化，请重新修改或放弃这份修改结果后再发布。` : undefined;
  return { id: document.id, changed, published_revision: document.published_document_revision, knowledge_document_id: document.knowledge_document_id,
    status_label: changed ? "待审查" : "已入库", proposal_problem };
}
function publicationState(job: DomainKnowledgeJob, publication: DomainPublication): KnowledgePublicationState {
  const target = [job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id)?.name ?? publication.target_id;
  const status_label = { pending: "归档中", opened: "已归档", failed: "归档失败" }[publication.state];
  return { key: `${publication.target_id}:${publication.branch}`, target, status_label, url: publication.url, error: publication.error };
}

/** 唯一的生产状态投影。先看需要人处理的归档事实，再看研究结果；不从旧记录补猜入库版本。 */
export function projectKnowledgeProduction(input: Input): KnowledgeProductionView {
  const record = input.record;
  const job = input.kind === "domain" ? input.record : input.kind === "component" ? input.archive : undefined;
  const ownerKind = input.kind === "domain" && job?.component_research_id ? "component" : input.kind;
  const ownerId = input.kind === "domain" && job?.component_research_id ? job.component_research_id : input.kind === "skill-submission" ? `${input.record.directory}/${input.record.id}` : record.id;
  // 动作已指向别的对象（如制作 Skill 跳到它的提交）时保留原链接。
  const actionLink = (action: KnowledgeProductionAction): KnowledgeProductionAction => ({ ...action,
    href: action.href ?? `?kbPage=task&kbKind=${ownerKind}&kbTask=${encodeURIComponent(ownerId)}${action.view === "progress" ? "" : "&kbReview=1"}${action.view === "archive" ? "&kbStage=publish" : ""}` });
  const documents = input.kind === "domain" ? input.record.documents.map(document => documentState(input.record, document)) : [];
  const working = ["queued", "running"].includes(record.status);
  const modifying = input.kind === "domain" ? ["revise", "update"].includes(input.record.turns.at(-1)?.mode ?? "")
    : input.kind === "component" ? !!input.record.update_document_id || !!input.record.review_turns?.some(turn => ["queued", "running"].includes(turn.status) && turn.mode !== "discuss") : false;
  const formalId = input.kind === "component" ? input.record.document_id ?? input.record.update_document_id ?? job?.documents[0]?.knowledge_document_id
    : input.kind === "domain" ? input.record.documents[0]?.knowledge_document_id : undefined;
  const published = input.kind === "domain" ? input.record.documents.filter(document => !!document.knowledge_document_id && (!input.current_revisions || !!input.current_revisions[document.knowledge_document_id])).length
    : input.kind === "component" ? Number(!!formalId && (!input.current_revisions || !!input.current_revisions[formalId])) : 0;
  const currentBatches = job ? currentKnowledgeArchiveBatches(job, input.kind === "domain" || input.kind === "component" ? input.current_revisions : undefined) : [];
  const current = currentBatches.flatMap(batch => batch.publications);
  const archiveFailed = currentBatches.some(batch => batch.state === "failed") || current.some(publication => publication.state === "failed");
  const archiveRunning = currentBatches.some(batch => batch.state === "running");
  const archiveOpened = currentBatches.some(batch => batch.state === "done" && batch.targets.every(target => batch.publications.some(publication => {
    const archived = batch.targets.find(candidate => candidate.id === publication.target_id);
    return archived?.repository === target.repository && archived.branch === target.branch && publication.state === "opened";
  })));
  const archiveState = archiveRunning ? "running" : archiveFailed ? "failed" : archiveOpened ? "opened" : "done";
  const archiveLabel = archiveRunning ? "归档中" : archiveFailed ? "归档失败" : archiveOpened ? "已归档" : "已发布（未归档）";
  const archiveActions: KnowledgeProductionAction[] = published ? [actionLink({ id: "archive", label: "归档", view: "archive" })] : [];
  let status_label: string, group: KnowledgeTaskGroup, next_action: KnowledgeProductionAction;
  if (archiveFailed) {
    status_label = "归档失败"; group = "attention"; next_action = archiveActions[0] ?? { id: "review", label: "审查成果", view: "review" };
  } else if (archiveRunning) {
    status_label = "归档中"; group = "running"; next_action = archiveActions[0] ?? { id: "progress", label: "查看进展", view: "progress" };
  } else if (record.status === "failed" || record.status === "cancelled" || record.status === "idle") {
    status_label = record.status === "failed" ? "执行失败" : record.status === "cancelled" ? "已停止" : "待开始";
    group = "attention"; next_action = input.kind === "skill-extraction" ? { id: "progress", label: "查看失败原因", view: "progress" } : { id: "resume", label: "继续研究", view: "progress" };
  } else if (working) {
    status_label = record.status === "queued" ? "排队中" : modifying ? "修改中" : "研究中"; group = "running";
    next_action = { id: "progress", label: "查看进展", view: "progress" };
  } else if (input.kind === "skill-extraction" && input.record.submission_id) {
    // 草稿已提交审查：制作任务结束，审查只在提交那一条上做（D9 只审一次）。
    status_label = "已提交审查"; group = "completed";
    const [directory, submission] = input.record.submission_id.split("/");
    next_action = { id: "submission", label: "查看提交", view: "review",
      href: `?kbPage=task&kbKind=skill-submission&kbTask=${encodeURIComponent(`${directory}/${submission}`)}&kbReview=1` };
  } else if (input.kind === "skill-submission") {
    const status = input.record.status;
    status_label = status === "pending" ? "待审查" : status === "approving" ? "审核通过中" : status === "approved" ? "已上架" : "已退回";
    group = status === "pending" || status === "approving" || status === "rejected" ? "attention" : "completed";
    next_action = status === "rejected" ? { id: "resubmit", label: "修改后重新提交", view: "review" }
      : { id: status === "approved" ? "knowledge" : "review", label: status === "approved" ? "查看知识" : "审查成果", view: "review" };
  } else {
    const draft = input.kind === "domain" ? documents.some(document => document.changed)
      : input.kind === "component" ? !!input.record.update_document_id || !published && (!!input.record.document || !!input.record.draft) : input.record.status === "done";
    // 制作 Skill 的草稿由发起人编辑后提交，真正的审查在提交那一条上，这里不叫"待审查"。
    const makingSkill = input.kind === "skill-extraction";
    status_label = draft ? makingSkill ? "待提交" : "待审查" : published ? archiveLabel : "已完成";
    group = draft ? "attention" : "completed";
    next_action = draft ? { id: "review", label: makingSkill ? "编辑并提交" : "审查成果", view: "review" } : { id: "knowledge", label: "查看知识", view: "review" };
  }
  const documentCount = input.kind === "domain" ? input.record.documents.length : input.kind === "component" ? input.record.document?.sections.length ?? Number(!!input.record.draft) : 0;
  const readonly = input.kind === "component" ? !!input.record.document_id : input.kind === "skill-submission" ? input.record.status !== "pending" : false;
  const sections = input.kind === "component" ? input.record.document?.sections ?? [] : [];
  const componentTurns = input.kind === "component" ? input.record.review_turns ?? [] : [];
  const capabilities = input.kind === "domain" ? input.record.turns.at(-1)?.research?.capabilities ?? [] : [];
  const turnLabels = { queued: "等待处理…", running: "正在查阅资料并处理…", cancelled: "本轮已停止，原稿保留", failed: "本轮失败，原稿保留", done: "本轮已完成" };
  const research_actions: KnowledgeProductionAction[] = [];
  if (input.kind === "domain" || input.kind === "component") {
    if (working) research_actions.push({ id: "stop", label: "停止本轮", view: "progress" });
    else if (["failed", "cancelled", "idle"].includes(record.status)) research_actions.push({ id: "resume", label: "继续研究", view: "progress" });
    else if (documentCount) research_actions.push(published && !documents.some(document => document.changed) && !(input.kind === "component" && input.record.update_document_id)
      ? { id: "update", label: "更新知识", view: "review" } : { id: "publish", label: "确认并发布", view: "review" });
  }
  if (input.kind === "skill-submission" && input.record.status === "pending") research_actions.push(
    { id: "reject", label: "需要调整", view: "review" }, { id: "publish", label: "发布 Skill", view: "review" });
  if (input.kind === "skill-submission" && input.record.status === "rejected") research_actions.push({ id: "resubmit", label: "修改后重新提交", view: "review" });
  if (input.kind === "skill-extraction" && input.record.status === "done" && input.record.draft && !input.record.submission_id) research_actions.push({ id: "review", label: "编辑并提交", view: "review" });
  const view: KnowledgeProductionView = { status_label, group, next_action, working, modifying, documents,
    research_actions,
    review: { readonly,
      selection_message: sections.length ? `${sections.length} 项能力 · ${readonly ? "已入库" : "已选"} ${sections.filter(section => section.selected).length} 项 · 合成 1 篇知识` : undefined,
      active_message: working ? "本轮正在执行，可先填写下一条意见；完成或停止后继续发送。" : undefined,
      sections: sections.map(section => {
        const pending = [...componentTurns].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending");
        const proposal_problem = !pending ? undefined : pending.status !== "done" ? "本轮修改尚未完成" : pending.proposal?.base_revision !== section.revision ? "修改与当前文稿冲突，请查看差异" : undefined;
        return { id: section.id, status_label: !section.revision ? "正在萃取" : `${readonly ? section.selected ? "已入库" : "未入库 · 原稿保留" : section.selected ? "已选择" : "未选择"} · 修订 ${section.revision}`,
          proposal_problem, proposal_message: pending && !proposal_problem && !readonly ? "修改后文稿 · 确认并发布后生效" : undefined };
      }),
      turns: (input.kind === "domain" ? input.record.turns : componentTurns).map(turn => ({ id: turn.id, status_label: turnLabels[turn.status],
        proposal_status_label: "proposal" in turn && turn.proposal ? { pending: "修改待确认", accepted: "修改已确认", discarded: "修改已放弃" }[turn.proposal.status] : undefined })),
      capabilities: capabilities.map(capability => ({ id: capability.id, status_label: { pending: "待研究", researched: "已研究", blocked: "受阻" }[capability.state] })),
      progress_message: capabilities.length ? `业务知识研究 · ${capabilities.filter(capability => capability.state === "researched").length} / ${capabilities.length} 项已研究` : undefined },
    knowledge_document_id: formalId,
    platform_message: published && (working || documents.some(document => document.changed) || input.kind === "component" && !!input.record.update_document_id) ? "修改期间继续使用已入库知识，确认发布后再更新。" : undefined,
    navigation: { working_label: working ? status_label : undefined,
      ready_message: !working && documentCount ? next_action.view === "archive" ? `${status_label}；请打开归档查看记录。` : group === "attention" ? "请审查文稿：勾选要发布的文稿，点「确认并发布」后平台上立即可读；要交付到代码仓时，再点「归档」填写单号创建 MR。" : "知识已入库，可继续阅读文稿；要交付到代码仓时点「归档」填写单号创建 MR。" : undefined,
      ready_action_label: !working && documentCount ? next_action.view === "review" && next_action.id === "review" ? "审查成果" : "查看文稿" : undefined },
    archive: { visible: !!published, state: archiveState, group: archiveFailed ? "attention" : archiveRunning ? "running" : "completed",
      status_label: archiveLabel, title: published ? `${published} 份知识已发布，平台立即可读` : "Git 归档记录",
      message: currentBatches.find(batch => batch.state === "failed")?.error || current.find(publication => publication.state === "failed")?.error
        || (archiveRunning ? "正在创建人工归档 MR" : archiveOpened ? "MR 已创建，后续合入由人处理。" : "平台知识已发布；如需 Git 归档，请手动填写关联单号并创建 MR。"),
      actions: archiveActions, publications: job ? [...job.publications, ...job.publication_history ?? []].map(publication => publicationState(job, publication)) : [],
      batches: (job?.archive_batches ?? []).filter(batch => !!batch.issue_no).map((batch, index) => ({ id: batch.id, title: `第 ${index + 1} 批 · ${batch.issue_no} · ${batch.documents.length} 份`,
        status_label: { pending: "归档中", running: "归档中", done: "已归档", failed: "归档失败", superseded: "已发布（未归档）" }[batch.state],
        publications: job ? batch.publications.map(publication => publicationState(job, publication)) : [], superseded: [] })),
    } };
  if (input.kind === "component" && input.archive?.production) {
    view.archive = { ...input.archive.production.archive, actions: archiveActions };
    if (!working && view.archive.visible && !input.record.update_document_id && !["failed", "cancelled", "idle"].includes(record.status)) {
      view.status_label = view.archive.status_label; view.group = view.archive.group;
      if (view.archive.state === "failed" || view.archive.state === "running") view.next_action = archiveActions[0];
    }
  }
  // HTTP 与管理器读取必须返回相同的只读契约，缺少的可选字段不伪造为显式 undefined。
  view.next_action = actionLink(view.next_action);
  return JSON.parse(JSON.stringify(view)) as KnowledgeProductionView;
}
