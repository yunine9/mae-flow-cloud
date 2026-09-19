/** Background research is an inspectable draft, not a task or a delivery gate. */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  componentKey,
  componentRepositories,
  type ComponentRepository,
} from "./componentRepositories.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import {
  saveKnowledgeDocument,
  readKnowledgeDocument,
} from "./knowledgeDocuments.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
export interface ResearchRecord {
  id: string;
  component: ComponentRepository;
  components?: ComponentRepository[];
  revisions?: Record<string, string>;
  language: string;
  topic: string;
  operator: string;
  key: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  deleted_at?: string;
  deleted_by?: string;
  created_at: string;
  finished_at?: string;
  stage: string;
  revision?: string;
  draft?: string;
  error?: string;
  document_id?: string;
  evidence: Array<Record<string, unknown>>;
}
export interface ResearchInput {
  component_id?: string;
  language: string;
  topic: string;
  refresh?: boolean;
}
export interface ResearchExecution {
  record: ResearchRecord;
  root: string;
  signal: AbortSignal;
  update: (patch: Partial<ResearchRecord>) => void;
  evidence: (item: Record<string, unknown>) => void;
}
export class ComponentResearch {
  private records = new Map<string, ResearchRecord>();
  private running = new Map<
    string,
    { controller: AbortController; work: Promise<void> }
  >();
  private stopped = false;
  constructor(
    readonly dir: string,
    private execute: (input: ResearchExecution) => Promise<string>,
    private onAdopt: () => void = () => {},
  ) {
    const root = join(dir, "component-research");
    if (existsSync(root))
      for (const name of readdirSync(root)) {
        if (!/^cr-[a-f0-9-]{36}$/.test(name)) continue;
        const path = join(root, name, "record.json");
        if (!existsSync(path)) continue;
        const record: ResearchRecord = JSON.parse(readFileSync(path, "utf8"));
        this.records.set(record.id, record);
        if (["queued", "running"].includes(record.status))
          this.update(record, {
            status: "failed",
            stage: "已中断",
            error: "服务重启中断了萃取，请重新发起",
            finished_at: new Date().toISOString(),
          });
      }
  }
  list(summaryOnly = false) {
    return [...this.records.values()]
      .filter(r => !r.deleted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) =>
        structuredClone(
          summaryOnly ? { ...r, draft: undefined, evidence: [] } : r,
        ),
      );
  }
  get(id: string) {
    const r = this.records.get(id);
    if (!r) throw new Error("萃取记录不存在");
    return structuredClone(r);
  }
  start(input: ResearchInput, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const language = normalizeKnowledgeLanguages([input.language])[0];
    const components = componentRepositories(this.dir).filter(c => c.enabled && c.languages.includes(language));
    if (!components.length) throw new Error("请先在配置中心启用该语言的基础组件仓");
    const component = components[0]; // Legacy records retain their single component; new jobs cover the language registry.
    const topic = String(input.topic ?? "").trim();
    if (!topic || topic.length > 1000)
      throw new Error("请填写具体萃取主题，最多 1000 字");
    const key = JSON.stringify([
      components.map(componentKey).sort(),
      language,
      topic.replace(/\s+/g, " ").toLowerCase(),
    ]);
    const previous = [...this.records.values()]
      .reverse()
      .find(
        (r) =>
          r.key === key && r.operator === operator && !r.deleted_at && !["failed", "cancelled"].includes(r.status),
      );
    if (previous && (!input.refresh || previous.status !== "done"))
      return structuredClone(previous);
    if (
      [...this.records.values()].filter((r) => r.status === "queued").length >=
      50
    )
      throw new Error("待萃取队列已满，请稍后再试");
    const record: ResearchRecord = {
      id: `cr-${randomUUID()}`,
      component,
      components,
      language,
      topic,
      operator,
      key,
      status: "queued",
      created_at: new Date().toISOString(),
      stage: "等待萃取",
      evidence: [],
    };
    this.records.set(record.id, record);
    this.update(record, {});
    this.pump();
    return this.get(record.id);
  }
  private root(id: string) {
    return join(this.dir, "component-research", id);
  }
  private update(record: ResearchRecord, patch: Partial<ResearchRecord>) {
    Object.assign(record, patch);
    const root = this.root(record.id);
    mkdirSync(root, { recursive: true });
    const path = join(root, "record.json");
    writeFileSync(path + ".tmp", JSON.stringify(record), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  private pump() {
    if (this.stopped) return;
    for (const record of this.records.values()) {
      if (this.running.size >= 2) break;
      if (record.status !== "queued") continue;
      const controller = new AbortController();
      this.update(record, { status: "running", stage: "准备组件源码" });
      // Defer execution until the running entry exists (also handles synchronous failures).
      const work = Promise.resolve()
        .then(async () => {
          try {
            const draft = await this.execute({
              record: structuredClone(record),
              root: this.root(record.id),
              signal: controller.signal,
              update: (patch) => { if (!record.deleted_at && record.status !== "cancelled") this.update(record, patch); },
              evidence: (item) => {
                record.evidence.push({ at: new Date().toISOString(), ...item });
                this.update(record, {});
              },
            });
            if (record.deleted_at || record.status === "cancelled") return;
            if (controller.signal.aborted) throw new Error("萃取已停止");
            if (!draft.trim()) throw new Error("模型未产出草稿");
            scanForSecrets("组件知识草稿.md", Buffer.from(draft));
            this.update(record, {
              status: "done",
              stage: "草稿待审查",
              draft,
              finished_at: new Date().toISOString(),
            });
          } catch (error) {
            if (record.deleted_at || record.status === "cancelled") return;
            this.update(record, {
              status: "failed",
              stage: "萃取失败",
              error: error instanceof Error ? error.message : "萃取失败",
              finished_at: new Date().toISOString(),
            });
          }
        })
        .finally(() => {
          this.running.delete(record.id);
          this.pump();
        });
      this.running.set(record.id, { controller, work });
    }
  }
  stop(id: string) {
    const record = this.records.get(id);
    if (!record || record.deleted_at) throw new Error("萃取任务不存在");
    if (["queued", "running"].includes(record.status)) {
      this.update(record, {status:"cancelled", stage:"已停止", finished_at:new Date().toISOString()});
      this.running.get(id)?.controller.abort();
    }
    return this.get(id);
  }
  remove(id: string, operator: string) {
    this.stop(id);
    const record = this.records.get(id)!;
    // Preserve provenance of adopted knowledge; hide the task from management lists.
    this.update(record, {deleted_at:new Date().toISOString(), deleted_by:operator});
    return { deleted: true };
  }
  retry(id: string, operator: string) {
    const record = this.get(id);
    if (record.deleted_at) throw new Error("萃取任务已删除");
    return this.start({language:record.language, topic:record.topic, refresh:true}, operator);
  }
  adopt(id: string, input: Record<string, unknown>, operator: string) {
    const record = this.records.get(id);
    if (!record || record.deleted_at || record.status !== "done") throw new Error("请等待草稿生成");
    if (record.document_id)
      return readKnowledgeDocument(this.dir, record.document_id);
    const content = String(input.content ?? record.draft ?? "");
    scanForSecrets("组件知识.md", Buffer.from(content));
    const document = saveKnowledgeDocument(
      this.dir,
      {
        ...input,
        title:
          input.title ??
          `${record.language} · ${record.topic}`.slice(0, 160),
        content,
        technologies: [record.language],
        research_source: {
          job_id: id,
          repository: record.component.repository,
          branch: record.component.branch,
          path: record.component.path,
          revision: record.revision,
          components: record.components?.map(c => ({id:c.id, repository:c.repository, branch:c.branch, path:c.path, revision:record.revisions?.[c.id]})),
        },
        when_to_use:
          input.when_to_use ??
          `${record.language} / ${record.topic}`,
        active: true,
      },
      operator,
    );
    this.update(record, { document_id: document.id, stage: "已采纳为知识" });
    this.onAdopt();
    return document;
  }
  async shutdown() {
    this.stopped = true;
    for (const r of this.records.values())
      if (r.status === "queued")
        this.update(r, {
          status: "failed",
          stage: "已中断",
          error: "服务停止，请重新发起",
        });
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.work));
  }
}
