/** Read-only analytics; never used to authorize delivery. */
export type CodeOrigin = "first" | "pipeline" | "review" | "other";
export type OriginCounts = Record<CodeOrigin, number>;
export interface DeliveryCommitMetric {
  sha: string;
  subject: string;
  at: string;
  origin: CodeOrigin;
  origin_evidence?: string[];
  additions: number;
  deletions: number;
}
export interface DeliveryCodeMetric {
  version: 1;
  head: string;
  published_head?: string;
  base: string;
  first: string;
  initial_implementation?: { end?: string; basis: "repair_record" | "commit_message" | "no_repair_found" };
  collected_at: string;
  retained: OriginCounts;
  rework: OriginCounts;
  deleted: number;
  excluded_files: number;
  commits: DeliveryCommitMetric[];
}
export interface DeliveryAnalysisRow {
  id: string;
  title: string;
  parent_id?: string;
  parent_title?: string;
  repo: string;
  modules: string[];
  business_module?: { id: string; name: string };
  merged: boolean;
  at: string;
  mr_url?: string;
  metric?: DeliveryCodeMetric;
  unavailable?: string;
}
export interface DeliveryAnalysisReport {
  generated_at: string;
  rows: DeliveryAnalysisRow[];
}
export const emptyOrigins = (): OriginCounts => ({ first: 0, pipeline: 0, review: 0, other: 0 });
