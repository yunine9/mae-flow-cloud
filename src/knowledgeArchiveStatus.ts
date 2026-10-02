import type { DomainKnowledgeJob } from "./domainKnowledgeTypes";

/** 顶部只提示当前正式版本的归档情况，历史失败仍保留在发布记录里。 */
export function currentKnowledgeArchiveBatches(job: DomainKnowledgeJob) {
  return (job.archive_batches ?? []).filter(batch => batch.state !== "superseded" && (!batch.documents.length || batch.documents.some(document =>
    job.documents.some(current => current.id === document.id && current.published_revision === document.published_revision))));
}

export function knowledgeArchiveState(job: DomainKnowledgeJob): "failed" | "running" | "opened" | "done" {
  const current = currentKnowledgeArchiveBatches(job);
  if (current.some(batch => batch.state === "failed")) return "failed";
  if (current.some(batch => batch.state === "pending" || batch.state === "running")) return "running";
  const publications = job.archive_batches?.length ? current.flatMap(batch => batch.publications) : job.publications;
  if (publications.some(publication => publication.state === "failed" || publication.state === "closed")) return "failed";
  if (publications.some(publication => publication.state === "opened")) return "opened";
  return "done";
}
