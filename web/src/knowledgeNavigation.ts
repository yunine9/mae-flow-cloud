export type KnowledgeAssetFocus =
  | { kind: "business"; moduleId: string; assetId: string }
  | { kind: "engineering"; candidateId: string }
  | { kind: "skill"; directory: string };

function clean(value: string | null): string {
  return value?.trim() ?? "";
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
  } else if (target.kind === "engineering") {
    query.set("asset", target.candidateId);
  } else {
    query.set("asset", target.directory);
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
  if (!asset) return undefined;
  if (kind === "business") {
    const moduleId = clean(query.get("module"));
    return moduleId ? { kind, moduleId, assetId: asset } : undefined;
  }
  if (kind === "engineering") return { kind, candidateId: asset };
  if (kind === "skill") return { kind, directory: asset };
  return undefined;
}

export function knowledgeAssetElementId(
  kind: KnowledgeAssetFocus["kind"],
  ...parts: string[]
): string {
  return `knowledge-${kind}-${parts.map(encodeURIComponent).join("-")}`;
}
