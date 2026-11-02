import type { PipelineCheck } from "./pipelineContract.ts";

export interface RepairMr {
  url: string;
  iid: string;
  title: string;
  repo: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  state: "opened" | "closed" | "merged";
}

export type PipelineRepairStatus = "queued" | "preparing" | "repairing" | "verifying"
  | "stopping" | "stopped" | "passed" | "needs_attention";

export interface PipelineRepairRecord {
  id: string;
  account: string;
  mr_url: string;
  mr?: RepairMr;
  status: PipelineRepairStatus;
  message: string;
  round: number;
  created_at: string;
  updated_at: string;
  checks?: PipelineCheck[];
  logs: Array<{ at: string; text: string }>;
}

export interface PipelineRepairList {
  enabled: boolean;
  reason?: string;
  records: PipelineRepairRecord[];
}

export function normalizeRepairMrUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("请填写有效的 MR 链接");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("请填写完整的 MR 链接"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !/^\/.+\/(?:-\/)?merge_requests\/[1-9]\d*\/?$/.test(url.pathname)) {
    throw new Error("请填写不含凭据的 CodeHub MR 链接");
  }
  url.search = ""; url.hash = ""; url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

/** 仓库地址必须来自平台详情，不从 MR 链接拼接克隆地址。 */
export function parseRepairMr(raw: unknown, requestedUrl: string): RepairMr {
  const row = raw as Partial<RepairMr> | null;
  if (!row || normalizeRepairMrUrl(row.url) !== normalizeRepairMrUrl(requestedUrl)
    || !/^[1-9]\d*$/.test(String(row.iid))
    || !new URL(requestedUrl).pathname.endsWith(`/merge_requests/${row.iid}`)
    || !["opened", "closed", "merged"].includes(String(row.state))
    || typeof row.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(row.sha)
    || typeof row.source_branch !== "string" || !row.source_branch || row.source_branch.includes("\0")
    || typeof row.target_branch !== "string" || !row.target_branch || row.target_branch.includes("\0")
    || typeof row.repo !== "string" || !row.repo) {
    throw new Error("MR 详情不完整，无法确定仓库、分支和当前提交");
  }
  const repo = new URL(row.repo);
  // 平台返回的 HTTPS 克隆域名可以不同于 MR 网页域名。
  if ((repo.protocol !== "https:" && !(repo.protocol === "http:" && repo.origin === new URL(requestedUrl).origin))
    || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error("MR 仓库地址无效，必须使用平台返回的不含凭据的 HTTPS 地址");
  }
  return { url: normalizeRepairMrUrl(row.url), iid: String(row.iid), title: String(row.title || `MR !${row.iid}`),
    repo: repo.toString(), source_branch: row.source_branch, target_branch: row.target_branch,
    sha: row.sha!, state: row.state! };
}

export function repairIsActive(status: PipelineRepairStatus): boolean {
  return ["queued", "preparing", "repairing", "verifying", "stopping"].includes(status);
}
