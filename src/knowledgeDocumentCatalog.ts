/** One shelf over existing sources; no copies of adopted experiences or module assets. */
import { createHash } from "node:crypto";
import { collectSearchableKnowledge } from "./knowledgeSearch.ts";
import { listKnowledgeDocuments, type KnowledgeDocument } from "./knowledgeDocuments.ts";
export function knowledgeDocumentCatalog(dir: string) {
  const catalog = collectSearchableKnowledge(dir, { repo: "", repositories: [], moduleIds: [] }, true);
  const manuals = listKnowledgeDocuments(dir);
  const manualIds = new Set(manuals.map(d => d.id));
  const external = catalog.assets.filter(a => !manualIds.has(a.id)).map(asset => {
    const digest = createHash("sha256").update(asset.content).digest("hex");
    const [origin, first, second] = asset.id.split(":");
    const focus = origin === "module" ? { kind: "business", moduleId: first, assetId: second, version: Number(asset.revision), digest }
      : origin === "skill" ? { kind: "skill", directory: asset.id.slice(6).split("/")[0], digest, packageDigest: asset.revision }
      : origin === "team" ? { kind: "engineering", candidateId: first, digest: asset.revision } : undefined;
    return { id: asset.id, title: asset.title, content: asset.content, revision: asset.revision,
      scope: (asset.scope.startsWith("业务模块") ? "module" : asset.scope.startsWith("代码仓") ? "repository" : "platform") as KnowledgeDocument["scope"],
      scope_label: asset.scope, module_ids: [], repositories: [], technologies: [], product_versions: asset.productVersions,
      when_to_use: asset.whenToUse, active: true, history: [], form: asset.kind, external: true, focus };
  });
  return { assets: catalog.assets, documents: [...manuals.map(d => ({ ...d, form: "document", external: false, focus: undefined, scope_label: undefined })), ...external] };
}
