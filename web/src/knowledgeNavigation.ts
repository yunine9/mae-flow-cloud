export type KnowledgeAssetFocus =
  | { kind: "business"; moduleId: string; assetId: string;
      version: number; digest: string }
  | { kind: "engineering"; candidateId: string; digest: string }
  | { kind: "skill"; directory: string; digest: string;
      packageDigest: string };

function clean(value: string | null): string {
  return value?.trim() ?? "";
}

function digest(value: string | null): string {
  const normalized = clean(value).toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

/**
 * 团队资产使用根路径查询参数做深链：服务端无需新增 SPA 路由，刷新、
 * 前进后退和把链接发给同事仍能回到同一份全文。
 */
export function knowledgeAssetPath(target: KnowledgeAssetFocus): string {
  const query = new URLSearchParams();
  query.set("knowledge", target.kind);
  if (target.kind === "business") {
    query.set("module", target.moduleId);
    query.set("asset", target.assetId);
    query.set("version", String(target.version));
    query.set("digest", target.digest);
  } else if (target.kind === "engineering") {
    query.set("asset", target.candidateId);
    query.set("digest", target.digest);
  } else {
    query.set("asset", target.directory);
    query.set("digest", target.digest);
    query.set("package_digest", target.packageDigest);
  }
  return `/?${query.toString()}`;
}

export function readKnowledgeAssetFocus(
  search?: string,
): KnowledgeAssetFocus | undefined {
  const browserSearch = (globalThis as { location?: { search?: string } })
    .location?.search ?? "";
  const query = new URLSearchParams(search ?? browserSearch);
  const kind = clean(query.get("knowledge"));
  const asset = clean(query.get("asset"));
  const contentDigest = digest(query.get("digest"));
  if (!asset || !contentDigest) return undefined;
  if (kind === "business") {
    const moduleId = clean(query.get("module"));
    const version = Number(clean(query.get("version")));
    return moduleId && Number.isInteger(version) && version >= 1
      ? { kind, moduleId, assetId: asset, version, digest: contentDigest }
      : undefined;
  }
  if (kind === "engineering") {
    return { kind, candidateId: asset, digest: contentDigest };
  }
  if (kind === "skill") {
    const packageDigest = digest(query.get("package_digest"));
    return packageDigest
      ? { kind, directory: asset, digest: contentDigest, packageDigest }
      : undefined;
  }
  return undefined;
}

export function knowledgeAssetElementId(
  kind: KnowledgeAssetFocus["kind"],
  ...parts: string[]
): string {
  return `knowledge-${kind}-${parts.map(encodeURIComponent).join("-")}`;
}

/** An explicit subpage wins over remembered task IDs in the same URL. */
export function knowledgeLibraryPage(search: string): "documents" | "component" | "domain" {
  const query = new URLSearchParams(search), page = query.get("knowledgePage");
  if (page === "documents" || page === "component" || page === "domain") return page;
  return query.has("domainExtraction") ? "domain" : query.has("componentResearch") ? "component" : "documents";
}

/** 旧链接仍可打开；新链接明确区分工具、执行过程和知识成果。 */
export function knowledgeStudioView(search: string): "skills" | "workbench" | "knowledge" {
  const query = new URLSearchParams(search), view = query.get("knowledgeView");
  if (view === "skills" || view === "workbench" || view === "knowledge") return view;
  if (query.has("platformSkill")) return "skills";
  const page = knowledgeLibraryPage(search);
  if (page === "domain") return query.get("domainExtraction") ? "knowledge" : "workbench";
  if (page === "component" && ["new", "history"].includes(query.get("componentResearch") ?? "")) return "workbench";
  return "knowledge";
}

/** 从研究页进入萃取方法时清除任务定位，刷新后仍停留在同一方法。 */
export function extractionSkillSearch(search: string, kind: "component" | "domain"): string {
  const query = new URLSearchParams(search);
  for (const key of ["kbPage", "kbKind", "kbModule", "kbTask", "kbReview", "domainExtraction", "componentResearch", "knowledgeDocument", "knowledgeDocuments", "researchDocument", "component", "knowledgeProbe", "knowledgeConsolidation"]) query.delete(key);
  query.set("knowledgePage", "documents");
  query.set("knowledgeView", "skills");
  query.set("platformSkill", kind);
  return `?${query.toString()}`;
}
