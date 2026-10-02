import type { DomainArchiveBatch, DomainDocument, DomainKnowledgeJob, DomainPublication } from "./domainKnowledgeTypes.ts";
import type { ResearchRecord } from "./componentResearch.ts";
import type { ExtractionJobRecord } from "./knowledgeExtraction.ts";
import type { SkillSubmissionRecord } from "./hostSkillLibrary.ts";
import type { KnowledgeTaskGroup } from "./knowledgeTaskCenterTypes.ts";
import { knowledgeFailureDisposition } from "./knowledgeProductionErrors.ts";

import type { KnowledgeProductionAction, KnowledgeDocumentState, KnowledgePublicationState, KnowledgeProductionView } from "./knowledgeProductionTypes.ts";
export type { KnowledgeProductionAction, KnowledgeDocumentState, KnowledgePublicationState, KnowledgeProductionView } from "./knowledgeProductionTypes.ts";
type Input = { kind: "domain"; record: DomainKnowledgeJob }
  | { kind: "component"; record: ResearchRecord; archive?: DomainKnowledgeJob }
  | { kind: "skill-extraction"; record: ExtractionJobRecord }
  | { kind: "skill-submission"; record: SkillSubmissionRecord };

export function currentKnowledgeArchiveBatches(job: DomainKnowledgeJob) {
  return (job.archive_batches ?? []).filter(batch => batch.state !== "superseded" && (!batch.documents.length || batch.documents.some(document =>
    job.documents.some(current => current.id === document.id && current.published_revision === document.published_revision))));
}
/** 状态动作与执行入口共用继续条件；执行入口还会排除已删除或已被新版替换的正式知识。 */
export function knowledgeArchiveCanContinue(job: DomainKnowledgeJob, batch: DomainArchiveBatch, documents = batch.documents) {
  if (batch.state === "superseded" || ["pending", "running"].includes(batch.state) || !documents.length) return false;
  const publications = batch.publications.map(saved => job.publications.find(current => current.target_id === saved.target_id && current.branch === saved.branch) ?? saved);
  const diverged = publications.filter(publication => publication.state === "merged" && publication.sync_state === "diverged");
  for (const publication of diverged) {
    const target = batch.targets.find(target => target.id === publication.target_id);
    const targetIds = new Set(batch.targets.filter(candidate => candidate.repository === target?.repository && candidate.branch === target?.branch).map(candidate => candidate.id));
    const affected = documents.filter(doc => targetIds.has(doc.target_id)
      && (!publication.diverged_paths?.length || publication.diverged_paths.includes(doc.path) || publication.diverged_paths.includes(doc.archive_path ?? doc.path)));
    if (!affected.length || affected.some(doc => {
      const current = job.documents.find(current => current.id === doc.id);
      return !current?.remote_review?.reviewed || current.content !== doc.content || current.component_metadata !== doc.component_metadata;
    })) return false;
  }
  return batch.state === "failed" || publications.some(publication => ["failed", "closed"].includes(publication.state) || publication.sync_state === "failed") || diverged.length > 0;
}
function documentState(job: DomainKnowledgeJob, document: DomainDocument): KnowledgeDocumentState {
  const pending = [...job.turns].reverse().flatMap(turn => turn.proposals.map(proposal => ({ turn, proposal })))
    .find(({ proposal }) => proposal.document.id === document.id && proposal.status === "pending");
  const changed = !!pending || document.published_document_revision !== document.revision;
  const name = document.path || document.title;
  const proposal_problem = !pending ? undefined : pending.turn.status !== "done" ? `${name} 的修改尚未完成，完成后才能确认发布。`
    : pending.proposal.base_revision !== document.revision ? `${name} 的正文已变化，请重新修改或放弃这份修改结果后再发布。` : undefined;
  const remote = document.remote_review;
  const exists = remote?.target_content != null || remote?.branch_content != null;
  const needs_remote_review = !!remote && exists && !remote.reviewed && (document.content !== remote.target_content || remote.branch_content != null && document.content !== remote.branch_content);
  return { id: document.id, changed, published_revision: document.published_document_revision, knowledge_document_id: document.knowledge_document_id,
    needs_remote_review, remote_review_message: remote ? remote.reviewed ? "已核对远端" : exists ? "仓内已有文档，请核对差异" : "目标路径为新文档" : "尚未比较目标文档",
    status_label: changed ? "待审查" : "已入库", proposal_problem };
}
function publicationState(job: DomainKnowledgeJob, publication: DomainPublication): KnowledgePublicationState {
  const target = [job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id)?.name ?? publication.target_id;
  const status_label = publication.sync_state === "failed" ? "同步失败" : publication.sync_state === "diverged" ? "远端待核对"
    : { pending: "归档准备中", opened: "MR 待合入", merged: "MR 已合入", failed: "归档失败", closed: "MR 已关闭", unchanged: "目标仓无变化" }[publication.state];
  return { key: `${publication.target_id}:${publication.branch}`, target, status_label, url: publication.url,
    error: publication.sync_error || publication.error,
    comparisons: publication.sync_state !== "diverged" ? [] : job.documents.filter(document => {
      const target = [job.knowledge_target, ...job.repositories].find(target => target.id === document.target_id);
      const publishedTarget = [job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id);
      const sameTarget = document.target_id === publication.target_id || !!target && !!publishedTarget && target.repository === publishedTarget.repository && target.branch === publishedTarget.branch;
      return sameTarget && (!publication.diverged_paths?.length || publication.diverged_paths.includes(document.path));
    }).map(document => ({ id: "compare", label: `核对 ${document.path.split("/").at(-1)} 的远端差异`, view: "review" as const, document_id: document.id })) };
}

/** 唯一的生产状态投影。先看需要人处理的归档事实，再看研究结果；不从旧记录补猜入库版本。 */
export function projectKnowledgeProduction(input: Input): KnowledgeProductionView {
  const record = input.record;
  const job = input.kind === "domain" ? input.record : input.kind === "component" ? input.archive : undefined;
  const ownerKind = input.kind === "domain" && job?.component_research_id ? "component" : input.kind;
  const ownerId = input.kind === "domain" && job?.component_research_id ? job.component_research_id : input.kind === "skill-submission" ? `${input.record.directory}/${input.record.id}` : record.id;
  const actionLink = (action: KnowledgeProductionAction): KnowledgeProductionAction => ({ ...action,
    href: `?kbPage=task&kbKind=${ownerKind}&kbTask=${encodeURIComponent(ownerId)}${action.view === "progress" ? "" : "&kbReview=1"}${action.id === "compare" ? `&kbStage=remote&knowledgeDocument=${encodeURIComponent(action.document_id ?? "")}` : action.view === "archive" ? "&kbStage=publish" : ""}` });
  const documents = input.kind === "domain" ? input.record.documents.map(document => documentState(input.record, document)) : [];
  const working = ["queued", "running"].includes(record.status);
  const modifying = input.kind === "domain" ? ["revise", "update"].includes(input.record.turns.at(-1)?.mode ?? "")
    : input.kind === "component" ? !!input.record.update_document_id || !!input.record.review_turns?.some(turn => ["queued", "running"].includes(turn.status) && turn.mode !== "discuss") : false;
  const formalId = input.kind === "component" ? input.record.document_id ?? input.record.update_document_id ?? job?.documents[0]?.knowledge_document_id
    : input.kind === "domain" ? input.record.documents[0]?.knowledge_document_id : undefined;
  const published = input.kind === "domain" ? input.record.documents.filter(document => !!document.knowledge_document_id).length
    : input.kind === "component" ? Number(!!formalId) : 0;
  const currentBatches = job ? currentKnowledgeArchiveBatches(job) : [];
  // publications 是当前远端事实，批次是每次交付的记录；合并同一分支时以当前事实为准。
  const publications = new Map<string, DomainPublication>();
  for (const publication of [...currentBatches.flatMap(batch => batch.publications), ...job?.publications ?? []]) publications.set(`${publication.target_id}:${publication.branch}`, publication);
  const current = [...publications.values()];
  const failedSync = current.find(publication => publication.sync_state === "failed");
  const diverged = current.find(publication => publication.sync_state === "diverged");
  const closed = current.find(publication => publication.state === "closed");
  const archiveFailed = currentBatches.some(batch => batch.state === "failed") || current.some(publication => publication.state === "failed");
  const archiveRunning = currentBatches.some(batch => ["pending", "running"].includes(batch.state)) || current.some(publication => publication.state === "pending");
  const archiveOpened = current.some(publication => publication.state === "opened");
  const unconfigured = !!job && (job.archive_configured === false || job.documents.some(document => {
    const target = [job.knowledge_target, ...job.repositories].find(target => target.id === document.target_id);
    return !target?.repository.trim();
  }));
  const missingArchive = published > 0 && ownerKind === "component" && !unconfigured && !currentBatches.length && !current.length;
  const archiveProblem = failedSync ? "同步失败" : diverged ? "远端待核对" : closed ? "MR 已关闭" : archiveFailed ? "归档待处理" : undefined;
  const archiveState = archiveProblem ? "failed" : archiveRunning ? "running" : archiveOpened ? "opened" : "done";
  const settings: KnowledgeProductionAction = actionLink({ id: "configure", label: "Git 归档设置", view: "archive" });
  const archiveActions: KnowledgeProductionAction[] = [];
  if (job && current.length) archiveActions.push({ id: "refresh", label: "刷新 MR 状态", view: "archive" });
  const failureReason = failedSync?.sync_error || currentBatches.find(batch => batch.state === "failed")?.error || current.find(publication => publication.state === "failed")?.error;
  const deterministic = !!failureReason && knowledgeFailureDisposition(failureReason) === "stall";
  const reviewedCanContinue = !!job && currentBatches.some(batch => knowledgeArchiveCanContinue(job, batch));
  if (archiveProblem && (!diverged || reviewedCanContinue) && !deterministic) archiveActions.push({ id: "archive-retry", label: "重试归档", view: "archive" });
  if (diverged && job) archiveActions.push(...publicationState(job, diverged).comparisons);
  if (unconfigured) archiveActions.push(settings);
  if (missingArchive) archiveActions.push({ id: "build-archive", label: "补建归档", view: "archive" });
  if (job && !unconfigured) archiveActions.push(settings);
  let status_label: string, group: KnowledgeTaskGroup, next_action: KnowledgeProductionAction;
  if (archiveProblem) {
    status_label = `${published ? "已入库 · " : ""}${archiveProblem}`; group = "attention";
    next_action = archiveActions.find(action => action.id !== "refresh" && action.id !== "configure") ?? { id: "configure", label: "查看失败原因", view: "archive" };
  } else if (record.status === "failed" || record.status === "cancelled" || record.status === "idle") {
    status_label = record.status === "failed" ? "执行失败" : record.status === "cancelled" ? "已停止" : "待开始";
    group = "attention"; next_action = input.kind === "skill-extraction" ? { id: "progress", label: "查看失败原因", view: "progress" } : { id: "resume", label: "继续研究", view: "progress" };
  } else if (working) {
    status_label = record.status === "queued" ? "排队中" : modifying ? "修改中" : "研究中"; group = "running";
    next_action = { id: "progress", label: "查看进展", view: "progress" };
  } else if (input.kind === "skill-submission") {
    const status = input.record.status;
    status_label = status === "pending" ? "待审查" : status === "approving" ? "审核通过中" : status === "approved" ? "已上架" : "已退回";
    group = status === "pending" || status === "approving" || status === "rejected" ? "attention" : "completed";
    next_action = { id: status === "approved" ? "knowledge" : "review", label: status === "approved" ? "查看知识" : "审查成果", view: "review" };
  } else {
    const draft = input.kind === "domain" ? documents.some(document => document.changed)
      : input.kind === "component" ? !!input.record.update_document_id || !published && (!!input.record.document || !!input.record.draft) : input.record.status === "done";
    status_label = draft ? "待审查" : missingArchive ? "已入库 · 未归档" : unconfigured && published ? "已入库 · 未配置 Git 归档"
      : archiveRunning && published ? "已入库 · 归档中" : archiveOpened && published ? "已入库 · MR 待合入" : published ? "已入库" : "已完成";
    group = draft || missingArchive || !!unconfigured && !!published ? "attention" : "completed";
    next_action = draft ? { id: "review", label: "审查成果", view: "review" } : missingArchive ? archiveActions[0] : unconfigured && published ? settings
      : { id: "knowledge", label: "查看知识", view: "review" };
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
  if (input.kind === "skill-extraction" && input.record.status === "done" && input.record.draft) research_actions.push({ id: "review", label: "审查文稿", view: "review" });
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
      ready_message: !working && documentCount ? next_action.view === "archive" ? `${status_label}；请打开 Git 归档设置处理。` : group === "attention" ? "请审查文稿，确认后发布到知识库。" : "知识已入库，可继续阅读文稿和查看研究记录。" : undefined,
      ready_action_label: !working && documentCount ? next_action.view === "review" && next_action.id === "review" ? "审查成果" : "查看文稿" : undefined },
    archive: { visible: !!published || !!job?.archive_batches?.length || !!current.length, state: archiveState,
      group: archiveProblem || unconfigured || missingArchive ? "attention" : "completed",
      status_label: archiveProblem ? `已入库 · ${archiveProblem}` : missingArchive ? "已入库 · 未归档" : unconfigured ? "已入库 · 未配置 Git 归档" : archiveRunning ? "已入库 · 归档中" : archiveOpened ? "已入库 · MR 待合入" : "已入库",
      title: published ? `${published} 份知识已入库，平台立即可读` : "Git 归档记录",
      message: failedSync?.sync_error || diverged?.sync_error || closed?.error || currentBatches.find(batch => batch.state === "failed")?.error || current.find(publication => publication.state === "failed")?.error
        || (unconfigured ? "未配置 Git 归档仓，请打开 Git 归档设置。" : missingArchive ? "知识已入库，请补建 Git 归档批次。" : archiveRunning ? "Git 正在后台归档" : archiveOpened ? "Git MR 待合入" : "可查看 Git 归档记录"),
      target_locked: !!job?.publications.length,
      locked_target_ids: [...new Set([...job?.publications ?? [], ...job?.publication_history ?? []].map(publication => publication.target_id))],
      issue_description_required: !job?.documents.filter(document => document.selected).length || !job.documents.filter(document => document.selected).every(document => current.some(publication => publication.target_id === document.target_id && !["closed", "merged"].includes(publication.state) && (publication.url || publication.mr_id))),
      actions: archiveActions.map(actionLink), publications: job ? [...job.publications, ...job.publication_history ?? []].map(publication => publicationState(job, publication)) : [],
      batches: (job?.archive_batches ?? []).map((batch, index) => ({ id: batch.id, title: `第 ${index + 1} 批 · ${batch.documents.length} 份`,
        status_label: { pending: "等待归档", running: "归档中", done: "归档已提交", failed: "归档失败", superseded: "无需归档" }[batch.state],
        publications: job ? batch.publications.map(publication => publicationState(job, publication)) : [],
        superseded: (batch.superseded_documents ?? []).map(document => ({ id: document.document_id,
          label: `${batch.documents.find(old => old.id === document.document_id)?.path ?? document.document_id} · ${document.reason === "deleted" ? "正式知识已删除，本版不再归档" : "已有新版正式知识，本版不再归档"}` })) })),
    } };
  // HTTP 与管理器读取必须返回相同的只读契约，缺少的可选字段不伪造为显式 undefined。
  view.next_action = actionLink(view.next_action);
  return JSON.parse(JSON.stringify(view)) as KnowledgeProductionView;
}
