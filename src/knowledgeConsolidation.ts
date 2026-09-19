import { saveConsolidationEvidence } from "./knowledgeConsolidationAudit.ts";
import type { ConsolidationAuditResult } from "./knowledgeConsolidationTypes.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectSearchableKnowledge,
  type SearchableKnowledge,
} from "./knowledgeSearch.ts";
import {
  applicabilityKey,
  consolidationRoot,
  digest,
  readConsolidation,
  sourceRevision,
  sourcesCurrent,
  topicMarkdown,
  writeConsolidation,
  type ConsolidationJob,
  type KnowledgeTopic,
  type TopicVersion,
} from "./knowledgeConsolidationStore.ts";
export interface ConsolidationInput {
  root: string;
  sources: SearchableKnowledge[];
  topics: KnowledgeTopic[];
  signal: AbortSignal;
  progress: (message: string) => void;
}
export type ConsolidationRunner = (
  input: ConsolidationInput,
) => Promise<string>;
const now = () => new Date().toISOString();
export function consolidationSources(dir: string) {
  return collectSearchableKnowledge(
    dir,
    { repo: "", repositories: [], moduleIds: [] },
    true,
    true,
  ).assets;
}
function proposals(
  text: string,
  sources: SearchableKnowledge[],
  topics: KnowledgeTopic[],
): Array<{ key: string; version: TopicVersion }> {
  // Models sometimes introduce the final JSON with a short explanation.
  // Accept one explicit JSON block; retain all content/source validation below.
  const blocks = [...text.matchAll(/^```(?:json)?\s*\n([\s\S]*?)^```\s*$/gm)];
  const parsed = JSON.parse(blocks.length === 1 ? blocks[0][1] : text.trim());
  if (!Array.isArray(parsed.topics)) throw new Error("模型未返回专题草稿数组");
  const keys = new Set<string>();
  return parsed.topics.map((p: any) => {
    if (
      typeof p.key !== "string" ||
      !p.key.trim() ||
      p.key.length > 160 ||
      keys.has(p.key)
    )
      throw new Error("专题标识为空或重复");
    keys.add(p.key);
    for (const field of ["title", "content", "summary"])
      if (typeof p[field] !== "string" || !p[field].trim())
        throw new Error(`草稿缺少 ${field}`);
    if (p.title.length > 160 || Buffer.byteLength(p.content) > 2 * 1024 * 1024)
      throw new Error("草稿标题或正文过长");
    if (
      !Array.isArray(p.sources) ||
      !p.sources.length ||
      !Array.isArray(p.conflicts) ||
      p.conflicts.some((c: unknown) => typeof c !== "string")
    )
      throw new Error("草稿缺少来源或冲突说明");
    const seen = new Set<string>();
    const refs = p.sources.map((s: any) => {
      const source = sources.find((a) => a.id === s.id);
      if (
        !source ||
        seen.has(s.id) ||
        !Array.isArray(s.sections) ||
        s.sections.some((v: unknown) => typeof v !== "string")
      )
        throw new Error("草稿引用了未知或重复来源");
      seen.add(s.id);
      return {
        id: source.id,
        title: source.title,
        revision: sourceRevision(source),
        full: s.full === true,
        sections: s.sections,
      };
    });
    // Updating a stable topic must account for every still-active previous source.
    const previous = topics.find((t) => t.key === p.key);
    const prior = previous?.pending ?? previous?.published;
    if (
      prior?.sources.some(
        (s) => sources.some((a) => a.id === s.id) && !seen.has(s.id),
      )
    )
      throw new Error("更新专题遗漏既有来源，请重试整理");
    return {
      key: p.key,
      version: {
        title: p.title.trim(),
        content: p.content,
        summary: p.summary,
        ...(typeof p.rationale === "string" ? { rationale: p.rationale } : {}),
        sources: refs,
        conflicts: p.conflicts,
        at: now(),
        operator: "agent",
      },
    };
  });
}
export class KnowledgeConsolidation {
  private active?: {
    id: string;
    controller: AbortController;
    work: Promise<void>;
  };
  private notifying = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private dir: string,
    private run: ConsolidationRunner,
    private onPublish: () => void = () => {},
    private log: (s: string) => void = () => {},
    private notify?: (job: ConsolidationJob) => Promise<void>,
  ) {
    const state = readConsolidation(dir);
    let changed = false;
    for (const job of state.jobs)
      if (job.state === "running") {
        job.state = "failed";
        job.error = "服务重启，整理已中断；已有草稿保留，可重试";
        job.ended_at = now();
        changed = true;
      }
    if (changed) writeConsolidation(dir, state);
  }
  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.log(`知识整理调度失败：${String(e)}`);
      }
    }, 60_000);
    this.timer.unref();
  }
  tick(date = new Date()) {
    const state = readConsolidation(this.dir),
      s = state.settings;
    for (const job of state.jobs)
      if (job.state !== "running" && job.topics.length && !job.notified)
        void this.notifyJob(job.id).catch((e) =>
          this.log(`知识整理通知失败：${String(e)}`),
        );
    if (!s.enabled || this.active) return;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: s.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (t: string) => parts.find((p) => p.type === t)?.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`,
      time = `${part("hour")}:${part("minute")}`;
    if (state.lastDay === day || time < s.time) return;
    // Persist the daily claim before starting; restart never repeats today's model call.
    state.lastDay = day;
    writeConsolidation(this.dir, state);
    this.start(s.operator, "scheduled");
  }
  view() {
    const state = readConsolidation(this.dir),
      sources = consolidationSources(this.dir);
    return {
      ...state,
      topics: state.topics.map((t) => ({
        ...t,
        stale: !!t.published && !sourcesCurrent(t.published, sources),
        pending_stale: !!t.pending && !sourcesCurrent(t.pending, sources),
      })),
    };
  }
  settings(input: any, operator: string) {
    if (
      typeof input.enabled !== "boolean" ||
      typeof input.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)
    )
      throw new Error("请填写每天整理时间");
    if (
      typeof input.timezone !== "string" ||
      !input.timezone.trim() ||
      input.timezone.length > 100
    )
      throw new Error("请填写有效时区，如 Asia/Shanghai");
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    const state = readConsolidation(this.dir);
    state.settings = {
      enabled: input.enabled,
      time: input.time,
      timezone: String(input.timezone),
      operator,
    };
    state.settings_history = [
      ...(state.settings_history ?? []),
      { at: now(), ...state.settings },
    ];
    writeConsolidation(this.dir, state);
    return state.settings;
  }
  start(operator: string, trigger: "manual" | "scheduled" = "manual") {
    if (this.active)
      return readConsolidation(this.dir).jobs.find(
        (j) => j.id === this.active!.id,
      )!;
    const state = readConsolidation(this.dir),
      all = consolidationSources(this.dir),
      groups = new Map<string, SearchableKnowledge[]>();
    for (const source of all) {
      const key = applicabilityKey(source);
      groups.set(key, [...(groups.get(key) ?? []), source]);
    }
    const selected = [...groups].filter(([key, sources]) => {
      const fingerprint = digest(
        sources.map((s) => [s.id, sourceRevision(s)]).sort(),
      );
      return state.groups[key] !== fingerprint;
    });
    const job: ConsolidationJob = {
      id: `kc-${randomUUID()}`,
      at: now(),
      operator,
      trigger,
      state: selected.length ? "running" : "done",
      stage: selected.length
        ? "准备资料"
        : "没有待整理的变更；已有待审草稿保持不变",
      topics: [],
    };
    if (!selected.length) job.ended_at = now();
    state.jobs.push(job);
    writeConsolidation(this.dir, state);
    if (selected.length) {
      const controller = new AbortController();
      const work = Promise.resolve().then(() =>
        this.execute(job.id, selected, controller.signal),
      );
      this.active = { id: job.id, controller, work };
      void work.then(
        () => {
          if (this.active?.id === job.id) this.active = undefined;
        },
        (error) => {
          if (this.active?.id === job.id) this.active = undefined;
          this.log(`知识整理失败：${String(error)}`);
        },
      );
    }
    return job;
  }
  private updateJob(id: string, change: Partial<ConsolidationJob>) {
    const state = readConsolidation(this.dir),
      job = state.jobs.find((j) => j.id === id);
    if (job) {
      Object.assign(job, change);
      writeConsolidation(this.dir, state);
    }
  }
  private async execute(
    id: string,
    groups: Array<[string, SearchableKnowledge[]]>,
    signal: AbortSignal,
  ) {
    try {
      for (const [index, [key, sources]] of groups.entries()) {
        signal.throwIfAborted();
        const before = readConsolidation(this.dir),
          existing = before.topics.filter((t) => t.group === key);
        const root = join(consolidationRoot(this.dir), "runs", id, key);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "sources.json"), JSON.stringify(sources), {
          mode: 0o640,
        });
        saveConsolidationEvidence(root, "before.json", existing);
        const stage = `整理范围 ${index + 1}/${groups.length} · ${sources.length} 份资料`;
        this.updateJob(id, { stage });
        const result = await this.run({
          root,
          sources,
          topics: existing,
          signal,
          progress: (m) => this.updateJob(id, { stage: `${stage} · ${m}` }),
        });
        signal.throwIfAborted();
        const drafts = proposals(result, sources, existing);
        const evidence: ConsolidationAuditResult[] = drafts.map((p) => ({
          ...p,
          disposition: "not_applied",
        }));
        saveConsolidationEvidence(root, "results.json", evidence);
        const current = consolidationSources(this.dir),
          currentMap = new Map(current.map((a) => [a.id, sourceRevision(a)]));
        if (sources.some((s) => currentMap.get(s.id) !== sourceRevision(s)))
          throw new Error("整理期间来源已修改或停用；请重试，未发布过期内容");
        const state = readConsolidation(this.dir),
          job = state.jobs.find((j) => j.id === id)!;
        for (const [position, proposal] of drafts.entries()) {
          const record = evidence[position];
          let topic = state.topics.find(
            (t) => t.group === key && t.key === proposal.key,
          );
          record.topic_id = topic?.id;
          if (topic?.pending) {
            record.disposition = "deferred";
            topic.needs_update = true;
            continue;
          }
          if (
            topic?.published &&
            digest({ ...topic.published, at: "", operator: "" }) ===
              digest({ ...proposal.version, at: "", operator: "" })
          ) {
            record.disposition = "unchanged";
            continue;
          }
          if (!topic) {
            topic = {
              id: `kg-${randomUUID()}`,
              key: proposal.key,
              group: key,
              scope: sources[0].scope,
              applicability: sources[0].applicability,
              productVersions: sources[0].productVersions,
              revision: 0,
              history: [],
            };
            state.topics.push(topic);
          }
          topic.pending = proposal.version;
          topic.edited = false;
          topic.revision++;
          topic.history.push({
            at: now(),
            operator: "agent",
            action: "生成整理草稿",
          });
          job.topics.push(topic.id);
          record.topic_id = topic.id;
          record.disposition = "draft";
        }
        state.groups[key] = digest(
          sources.map((s) => [s.id, sourceRevision(s)]).sort(),
        );
        writeConsolidation(this.dir, state);
        saveConsolidationEvidence(root, "results.json", evidence);
      }
      this.updateJob(id, {
        state: "done",
        stage: "整理完成，请审查专题草稿",
        ended_at: now(),
      });
      await this.notifyJob(id);
    } catch (e) {
      this.updateJob(id, {
        state: signal.aborted ? "cancelled" : "failed",
        error: String(e instanceof Error ? e.message : e),
        stage: signal.aborted ? "已停止，已有草稿保留" : "整理失败，可重试",
        ended_at: now(),
      });
    }
  }
  private async notifyJob(id: string) {
    if (!this.notify || this.notifying.has(id)) return;
    const job = readConsolidation(this.dir).jobs.find((j) => j.id === id);
    if (!job || job.notified || !job.topics.length || job.operator === "system")
      return;
    this.notifying.add(id);
    try {
      await this.notify(job);
      this.updateJob(id, { notified: true, notification_error: undefined });
    } catch (e) {
      this.updateJob(id, {
        notification_error: String(e instanceof Error ? e.message : e),
      });
    } finally {
      this.notifying.delete(id);
    }
  }
  act(id: string, action: string, input: any, operator: string) {
    const state = readConsolidation(this.dir),
      topic = state.topics.find((t) => t.id === id);
    if (!topic) throw new Error("专题不存在");
    if (input.revision !== topic.revision)
      throw new Error("草稿已被更新，请刷新后继续；你的编辑内容仍保留在页面");
    if (action === "withdraw") {
      topic.published = undefined;
      delete state.groups[topic.group];
    } else {
      if (!topic.pending) throw new Error("没有待审草稿");
      if (action === "discard") {
        topic.pending = undefined;
        topic.edited = false; /* Unchanged rejected material is not resubmitted daily. */
      } else {
        if (
          typeof input.content !== "string" ||
          !input.content.trim() ||
          Buffer.byteLength(input.content) > 2 * 1024 * 1024
        )
          throw new Error("请填写非空 Markdown 正文（最大 2 MiB）");
        if (
          typeof input.title !== "string" ||
          !input.title.trim() ||
          input.title.length > 160
        )
          throw new Error("请填写专题名称（最多 160 字）");
        const pending = {
          ...topic.pending,
          title: input.title.trim(),
          content: input.content,
          at: now(),
          operator,
        };
        if (
          !Array.isArray(input.covered) ||
          input.covered.some(
            (s: unknown) =>
              typeof s !== "string" || !pending.sources.some((r) => r.id === s),
          )
        )
          throw new Error("请确认完整覆盖的来源");
        pending.sources = pending.sources.map((s) => ({
          ...s,
          full: input.covered.includes(s.id),
        }));
        if (action === "adopt") {
          if (!sourcesCurrent(pending, consolidationSources(this.dir)))
            throw new Error(
              "来源已变更，请保留编辑内容并丢弃旧草稿，再重新整理",
            );
          // Standalone Markdown is a portable artifact; JSON retains governance/provenance.
          const root = join(consolidationRoot(this.dir), "published");
          mkdirSync(root, { recursive: true });
          const file = join(root, `${topic.id}.md`),
            temporary = `${file}.${randomUUID()}.tmp`;
          writeFileSync(temporary, topicMarkdown(pending, topic), {
            mode: 0o640,
          });
          renameSync(temporary, file);
          topic.published = pending;
          topic.pending = undefined;
          topic.edited = false;
        } else if (action === "edit") {
          topic.pending = pending;
          topic.edited = true;
        } else throw new Error("未知整理操作");
      }
    }
    if (action !== "edit" && topic.needs_update) {
      delete state.groups[topic.group];
      topic.needs_update = false;
    }
    topic.revision++;
    topic.history.push({
      at: now(),
      operator,
      action: (
        {
          edit: "人工编辑草稿",
          adopt: "采纳专题",
          discard: "丢弃草稿",
          withdraw: "撤回专题",
        } as Record<string, string>
      )[action],
    });
    writeConsolidation(this.dir, state);
    this.onPublish();
    return topic;
  }
  stop() {
    this.active?.controller.abort();
    return { ok: true };
  }
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.stop();
    await this.active?.work;
  }
}
