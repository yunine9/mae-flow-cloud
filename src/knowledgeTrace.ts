/**
 * 任务知识足迹：只记录“提供/加载/阅读”这些宿主可观察事实。
 *
 * 它不是 Mae-Flow 证据，也不参与步骤迁移。写失败只记日志；页面没有
 * 足迹最多是不展示，绝不能因为观测旁路拖住 Agent。
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SelectedRepositorySkill } from "./repositorySkillRuntime.ts";
import type { SelectedRepositoryKnowledge } from "./repositoryKnowledgeRuntime.ts";

export type KnowledgeKind = "rules" | "document" | "skill";
export type KnowledgeAction = "available" | "loaded" | "read" | "searched";

export interface KnowledgeResourceRef {
  id: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  repository?: string;
  description?: string;
  digest?: string;
  selected?: boolean;
}

export interface KnowledgeTraceEvent extends KnowledgeResourceRef {
  ts: string;
  task_id: string;
  session_id: string;
  session_role: "main" | "subagent" | "prepush" | "developer-assistant";
  step?: string;
  action: KnowledgeAction;
  observed_path?: string;
}

export interface TaskKnowledgeResource extends KnowledgeResourceRef {
  state: "available" | "loaded" | "used";
  available_count: number;
  loaded_count: number;
  read_count: number;
  first_at?: string;
  last_at?: string;
}

export interface TaskKnowledgeUsage {
  summary: {
    resources: number;
    loaded: number;
    used: number;
    skills_used: number;
    selected_unused: number;
  };
  resources: TaskKnowledgeResource[];
  events: KnowledgeTraceEvent[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel));
}

function roleOf(sessionId: string): KnowledgeTraceEvent["session_role"] {
  if (sessionId.startsWith("child-")) return "subagent";
  if (sessionId.includes("prepush")) return "prepush";
  if (sessionId.includes("developer-assistant")) return "developer-assistant";
  return "main";
}

function pathInput(input: Record<string, unknown>): string {
  return String(input.file_path ?? input.path ?? input.directory ?? "").trim();
}

function safeName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1)?.replace(/\.(?:md|mdx)$/i, "") || path;
}

export class KnowledgeTrace {
  private resources = new Map<string, KnowledgeResourceRef>();
  private directories: Array<{ directory: string; resource: KnowledgeResourceRef }> = [];
  private emitted = new Set<string>();

  constructor(
    readonly file: string,
    readonly taskId: string,
    readonly workspace: string,
    private currentStep?: () => string,
    private log?: (message: string) => void,
  ) {}

  register(path: string, resource: KnowledgeResourceRef, directory = false): void {
    const absolute = resolve(path);
    this.resources.set(absolute, resource);
    if (directory) this.directories.push({ directory: absolute, resource });
  }

  private displayPath(absolute: string): string {
    if (contained(this.workspace, absolute)) {
      return relative(this.workspace, absolute).split(sep).join("/") || ".";
    }
    const parts = absolute.split(sep).filter(Boolean);
    return parts.slice(-3).join("/");
  }

  private resourceFor(path: string): KnowledgeResourceRef | undefined {
    const absolute = resolve(path);
    const exact = this.resources.get(absolute);
    if (exact) return exact;
    const packaged = this.directories.find((item) =>
      contained(item.directory, absolute));
    if (packaged) return packaged.resource;
    if (!contained(this.workspace, absolute)) return undefined;
    const rel = this.displayPath(absolute);
    const basename = rel.split("/").at(-1) ?? rel;
    const rules = /^(?:AGENTS(?:\.override)?|CLAUDE)\.md$/i.test(basename);
    const document = /(?:^|\/)docs\/.*\.(?:md|mdx)$/i.test(rel);
    if (!rules && !document) return undefined;
    return {
      id: `observed:${sha256(rel)}`,
      kind: rules ? "rules" : "document",
      name: rules ? basename : safeName(rel),
      path: rel,
    };
  }

  record(
    action: KnowledgeAction,
    sessionId: string,
    resource: KnowledgeResourceRef,
    observedPath?: string,
  ): void {
    const step = this.currentStep?.() || undefined;
    // 同一会话里的“可见/加载”只记一次；阅读保留重复次数，飞轮需要知道
    // 一篇文档是否被反复翻找。
    const dedupe = `${sessionId}\0${action}\0${resource.id}`;
    if ((action === "available" || action === "loaded")
        && this.emitted.has(dedupe)) return;
    this.emitted.add(dedupe);
    const event: KnowledgeTraceEvent = {
      ...resource,
      ts: new Date().toISOString(),
      task_id: this.taskId,
      session_id: sessionId,
      session_role: roleOf(sessionId),
      step,
      action,
      observed_path: observedPath,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (error) {
      this.log?.(`任务 ${this.taskId} 知识足迹写入失败(不影响执行): ${String(error)}`);
    }
  }

  observeTool(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
    isError: boolean,
  ): void {
    if (isError) return;
    const normalized = name.toLowerCase();
    if (!["read", "grep", "find", "ls"].includes(normalized)) return;
    const rawPath = pathInput(input);
    if (!rawPath) return;
    const absolute = isAbsolute(rawPath)
      ? resolve(rawPath) : resolve(this.workspace, rawPath);
    const resource = this.resourceFor(absolute);
    if (!resource) return;
    this.record(normalized === "read" ? "read" : "searched",
      sessionId, resource, this.displayPath(absolute));
  }
}

function parseEvents(file: string): KnowledgeTraceEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").split("\n").filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as KnowledgeTraceEvent;
        return event?.id && event?.action ? [event] : [];
      } catch {
        return [];
      }
    });
}

/** 任务详情读侧投影。坏行跳过，知识观测永远 fail-open。 */
export function knowledgeUsageSnapshot(options: {
  workspace: string;
  selectedKnowledge?: SelectedRepositoryKnowledge[];
  selectedSkills?: SelectedRepositorySkill[];
}): TaskKnowledgeUsage | undefined {
  const events = parseEvents(resolve(options.workspace, "knowledge-events.jsonl"));
  const resources = new Map<string, TaskKnowledgeResource>();
  const seed = (resource: KnowledgeResourceRef) => {
    if (resources.has(resource.id)) return;
    resources.set(resource.id, {
      ...resource,
      state: "available",
      available_count: 0,
      loaded_count: 0,
      read_count: 0,
    });
  };
  for (const item of options.selectedKnowledge ?? []) seed({
    id: item.id, kind: "document", name: item.title,
    path: item.relative_path, repository: item.repository,
    description: item.description, digest: item.digest, selected: true,
  });
  for (const item of options.selectedSkills ?? []) seed({
    id: item.id, kind: "skill", name: item.name,
    path: item.relative_path, repository: item.repository,
    description: item.description, digest: item.digest, selected: true,
  });
  for (const event of events) {
    seed(event);
    const item = resources.get(event.id)!;
    item.first_at = !item.first_at || event.ts < item.first_at ? event.ts : item.first_at;
    item.last_at = !item.last_at || event.ts > item.last_at ? event.ts : item.last_at;
    if (event.action === "available") item.available_count += 1;
    if (event.action === "loaded") item.loaded_count += 1;
    if (event.action === "read" || event.action === "searched") item.read_count += 1;
    item.state = item.read_count > 0 ? "used"
      : item.loaded_count > 0 ? "loaded" : "available";
  }
  if (!resources.size && !events.length) return undefined;
  const list = [...resources.values()].sort((left, right) =>
    (right.last_at ?? "").localeCompare(left.last_at ?? "")
      || left.name.localeCompare(right.name));
  return {
    summary: {
      resources: list.length,
      loaded: list.filter((item) => item.loaded_count > 0).length,
      used: list.filter((item) => item.read_count > 0 || item.loaded_count > 0).length,
      skills_used: list.filter((item) => item.kind === "skill"
        && item.read_count > 0).length,
      selected_unused: list.filter((item) => item.selected
        && item.kind === "skill" && item.read_count === 0).length,
    },
    resources: list,
    events: events.slice(-160).reverse(),
  };
}
