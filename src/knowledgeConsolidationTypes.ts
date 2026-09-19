export interface KnowledgeApplicability {
  modules: string[];
  repositories: string[];
  languages: string[];
  versions: string[];
  localPaths?: string[];
}
export interface TopicSource {
  id: string;
  title: string;
  revision: string;
  full: boolean;
  sections: string[];
}
export interface TopicVersion {
  title: string;
  content: string;
  summary: string;
  rationale?: string;
  sources: TopicSource[];
  conflicts: string[];
  at: string;
  operator: string;
}
export interface KnowledgeTopic {
  id: string;
  key: string;
  group: string;
  scope: string;
  applicability?: KnowledgeApplicability;
  productVersions: string[];
  revision: number;
  published?: TopicVersion;
  pending?: TopicVersion;
  edited?: boolean;
  needs_update?: boolean;
  history: Array<{ at: string; operator: string; action: string }>;
}
export interface ConsolidationJob {
  id: string;
  at: string;
  operator: string;
  trigger?: "manual" | "scheduled";
  state: "running" | "done" | "failed" | "cancelled";
  stage: string;
  error?: string;
  ended_at?: string;
  topics: string[];
  notified?: boolean;
  notification_error?: string;
}
export interface ConsolidationState {
  settings: {
    enabled: boolean;
    time: string;
    timezone: string;
    operator: string;
  };
  settings_history?: Array<{
    at: string;
    operator: string;
    enabled: boolean;
    time: string;
    timezone: string;
  }>;
  lastDay?: string;
  groups: Record<string, string>;
  topics: KnowledgeTopic[];
  jobs: ConsolidationJob[];
}

export interface ConsolidationTrace {
  at: string;
  action: string;
  id?: string;
  query?: string;
  offset?: number;
  returned_ids?: string[];
  characters?: number;
  error?: string;
}
export interface ConsolidationAuditResult {
  key: string;
  version: TopicVersion;
  topic_id?: string;
  disposition: "draft" | "deferred" | "unchanged" | "not_applied";
}
export interface ConsolidationAuditDetail {
  job: ConsolidationJob;
  groups: Array<{
    key: string;
    scope: string;
    sources: Array<{
      id: string;
      title: string;
      revision: string;
      characters: number;
    }>;
    before: KnowledgeTopic[];
    results?: ConsolidationAuditResult[];
    execution?: { provider: string; model: string; instruction: string };
    actions: ConsolidationTrace[];
  }>;
}
