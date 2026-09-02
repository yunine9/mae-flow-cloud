/**
 * 业务知识地图(ADR-0012):问题分析消费的领域事实库,两个来源——
 *
 * 1. 团队资产库:进入 analyze 时按绑定模块定格(state.business_knowledge
 *    台账),只读投影在 .mae-flow-work/business-modules/;
 * 2. 仓内业务知识:已拉仓根目录的 docs/ 目录树,渲染时现扫(地图不是
 *    决策,没有"已拍板"语义,不落台账;补仓后新 docs 自然可见)。
 *
 * 地图只给路径与标题,正文必须由 Agent 按需 Read——与需求侧"轻量索引+
 * 按需读取"同一口径,业务知识不整包注入上下文。它只供领域事实,不定
 * 流程、不是证据门槛;不举卡、不分介入档(它不是等人的人工节点)。
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  issueRepoWorkspaces,
  type IssueSessionState,
} from "./state.ts";

/** docs/ 索引的条数上限(ADR-0012 第一轮拍板 40):地图的使命是导航
 * 不是全文,爆上下文比缺索引更有害。超限按目录折叠。 */
export const REPO_DOCS_INDEX_LIMIT = 40;

/** 仓内 docs/ 的一项:工作区相对路径。 */
export interface RepoDocsEntry {
  path: string;
}

/** 扫描已拉仓根目录的 docs/(一层为主):返回按仓分组的条目清单。
 * 仓没有 docs/ 静默跳过;条目是文件与一级子目录,子目录折叠为
 * `xxx/` 形式(第二层交给 Agent 按需自查)。 */
export function scanRepoDocs(
  state: IssueSessionState,
  workspace: string,
): Array<{ repo: string; entries: RepoDocsEntry[]; folded: boolean }> {
  const groups: Array<{ repo: string; entries: RepoDocsEntry[]; folded: boolean }> = [];
  for (const repo of issueRepoWorkspaces(state, workspace)) {
    const docsRoot = join(repo.dir, "docs");
    if (!existsSync(docsRoot)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(docsRoot).sort();
    } catch {
      continue;
    }
    const entries: RepoDocsEntry[] = [];
    let folded = false;
    for (const name of names) {
      const absolute = join(docsRoot, name);
      let isDir = false;
      try {
        isDir = statSync(absolute).isDirectory();
      } catch {
        continue;
      }
      if (entries.length >= REPO_DOCS_INDEX_LIMIT) {
        folded = true;
        break;
      }
      entries.push({
        path: `${relativeRepoPath(workspace, repo.dir)}/docs/${name}`
          + (isDir ? "/" : ""),
      });
    }
    if (entries.length || folded) {
      groups.push({
        repo: repo.url,
        entries,
        folded,
      });
    }
  }
  return groups;
}

function relativeRepoPath(workspace: string, repoDir: string): string {
  const normalized = repoDir.split("\\").join("/");
  const root = workspace.split("\\").join("/").replace(/\/+$/, "");
  return normalized.startsWith(root)
    ? normalized.slice(root.length + 1)
    : normalized;
}

/** 业务知识地图(analyze 简报注入段,ADR-0012):两个来源分组呈现,
 * 条目=路径+标题+一句何时读。只在 analyze 阶段注入(地图跟着分析
 * 简报走,与 skill 圈选清单同款门控);两源皆空返回空数组(静默缺席)。 */
export function businessKnowledgeLines(
  state: IssueSessionState,
  workspace: string,
): string[] {
  if (state.stage !== "analyze") return [];
  const assets = state.business_knowledge?.entries ?? [];
  const docsGroups = scanRepoDocs(state, workspace);
  if (!assets.length && !docsGroups.length) return [];
  const lines = [
    "业务知识地图(领域事实——先查这里,与当前问题相关才读正文;"
      + "只供业务事实,不定流程;引用业务事实时把文件路径写进证据链):",
  ];
  if (assets.length) {
    lines.push("【团队资产库】(已按绑定模块定格,只读;目录:"
      + " .mae-flow-work/business-modules/INDEX.md)");
    for (const entry of assets) {
      lines.push(`- ${entry.relative_path} — ${entry.title}`
        + `${entry.when_to_use ? `(何时读:${entry.when_to_use})` : ""}`);
    }
  }
  if (docsGroups.length) {
    lines.push("【仓内 docs/】(拉仓落地后可读,子目录以 / 结尾表示按目录自查)");
    for (const group of docsGroups) {
      const repoName = group.repo.replace(/\/+$/, "").split("/").pop()
        ?.replace(/\.git$/i, "") ?? group.repo;
      lines.push(`- 仓 ${repoName}:`);
      for (const entry of group.entries) {
        lines.push(`  - ${entry.path}`);
      }
      if (group.folded) {
        lines.push(`  - (docs/ 条目超过 ${REPO_DOCS_INDEX_LIMIT},已折叠——按目录自查)`);
      }
    }
  }
  return lines;
}
