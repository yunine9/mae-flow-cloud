/**
 * 交付时间线(只读旁路):把现场文件读成"这单经历了什么"的人话。
 *
 * 数据源全部只读,且各自独立降级——时间线坏一行不能毁整页
 * (fail-open 红线):文件缺失、半行 JSON、字段缺失一律跳过该条,
 * 绝不抛错。它只呈现事实,不参与任何判定;阶段真相仍在
 * `.mae-flow.json`,证据判定仍在内核。
 *
 * 命令行版是 `harness/run-report.py`(markdown),这里是它的结构化
 * 兄弟:同样的事实,给页面看。
 *
 * 一处刻意的克制:内核的"步骤→阶段"映射不在这里复刻(CLAUDE.md
 * 红线:连阶段映射都不许抄第二份)。history 里有什么步骤就报什么
 * 步骤,人话在标题里,步骤代号原样示人——它本来就是面板上的词汇。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type TimelineTone = "info" | "attention" | "success" | "danger";

export interface TimelineEntry {
  /** 现场里的原始时间戳(内核与事件账本同格式,可直接排序)。 */
  ts: string;
  kind: "session" | "phase" | "ask" | "decision" | "agent" | "quality";
  title: string;
  detail?: string;
  tone: TimelineTone;
}

function clip(value: unknown, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** JSONL 逐行解析:坏行跳过,不让半行毁掉整页。 */
function readJsonl(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const rows: Array<Record<string, any>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // 半行(写入方还在写)或损坏行:跳过,继续读后面的。
    }
  }
  return rows;
}

function readJson(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 代码工作区:调用方给了就用;没给就在任务工作区下找带
 * `.mae-flow.json` 的那一层(host 模式的克隆目录)。找不到就
 * 只出事件侧条目——没有内核现场不是错误,是流程还没走到 init。 */
function resolveCwd(workspace: string, cwd?: string): string | undefined {
  if (cwd && existsSync(join(cwd, ".mae-flow.json"))) return cwd;
  if (cwd && existsSync(cwd)) return cwd;
  try {
    for (const name of readdirSync(workspace)) {
      const candidate = join(workspace, name);
      if (!statSync(candidate).isDirectory()) continue;
      if (existsSync(join(candidate, ".mae-flow.json"))) return candidate;
    }
  } catch {
    // 工作区不可读:当作没有内核现场。
  }
  return undefined;
}

/** 语义事件 → 时间线条目。 */
function fromEvents(workspace: string): TimelineEntry[] {
  const events = readJsonl(join(workspace, "events.jsonl"));
  const entries: TimelineEntry[] = [];
  // 子 Agent 按 call_id 配对:派出与返回各是一条,配不上对的另说。
  const spawned = new Map<string, Record<string, any>>();
  const finished = new Set<string>();

  // 先扫一遍收口事件的位置:判断"没返回登记"是真丢了,还是还在跑。
  const closingIds: number[] = [];
  for (const event of events) {
    if (event.kind === "turn_finished" || event.kind === "session_ended") {
      closingIds.push(Number(event.eventId ?? 0));
    }
  }
  const hasClosingAfter = (eventId: number) =>
    closingIds.some((id) => id > eventId);

  for (const event of events) {
    const ts = String(event.ts ?? "");
    const payload = (event.payload ?? {}) as Record<string, any>;
    switch (event.kind) {
      case "session_started":
        entries.push({
          ts,
          kind: "session",
          title: payload.resume ? "重建会话续跑" : "开始执行",
          detail: payload.resume
            ? "此前对话不在上下文里,以内核当前步骤为锚继续。"
            : undefined,
          tone: "info",
        });
        break;
      case "tool_requested": {
        if (payload.name !== "AskUserQuestion") break;
        const questions = (payload.input?.questions ?? []) as Array<
          Record<string, any>
        >;
        const first = clip(questions[0]?.question, 60) || "需要你确认";
        entries.push({
          ts,
          kind: "ask",
          title: `请你决定:${first}`,
          detail: questions.length > 1
            ? `本卡共 ${questions.length} 个问题`
            : undefined,
          tone: "attention",
        });
        break;
      }
      case "human_decision":
        entries.push({
          ts,
          kind: "decision",
          title: `你的决定:${clip(payload.decision, 60) || "(空)"}`,
          detail: payload.notes ? `备注:${clip(payload.notes, 80)}` : undefined,
          tone: "success",
        });
        break;
      case "agent_spawned": {
        const callId = String(payload.call_id ?? "");
        if (callId) spawned.set(callId, { ...payload, ts, eventId: event.eventId });
        break;
      }
      case "agent_finished": {
        const callId = String(payload.call_id ?? "");
        if (callId) finished.add(callId);
        const type = spawned.get(callId)?.agent_type;
        entries.push({
          ts,
          kind: "agent",
          title: `子 Agent 返回${type ? `:${clip(type, 24)}` : ""}`,
          detail: payload.lifecycle
            ? `生命周期 ${clip(payload.lifecycle, 20)}`
            : undefined,
          tone: "info",
        });
        break;
      }
      case "session_ended":
        if (payload.reason !== "failed") break;
        entries.push({
          ts,
          kind: "session",
          title: "会话中断",
          detail: clip(payload.detail ?? payload.reason, 80),
          tone: "danger",
        });
        break;
      default:
        break;
    }
  }

  // 派出条目补进去:已返回的正常,没返回的看回合是否已收口——
  // 收口后仍无返回登记就是真的丢了(run3 实锤的那类坑)。
  for (const [callId, payload] of spawned) {
    const returned = finished.has(callId);
    const stale = !returned && hasClosingAfter(Number(payload.eventId ?? 0));
    entries.push({
      ts: String(payload.ts ?? ""),
      kind: "agent",
      title: stale
        ? `子 Agent 没有返回登记:${clip(payload.agent_type, 24)}`
        : `派出子 Agent:${clip(payload.agent_type, 24)}`,
      detail: clip(payload.description, 80) || undefined,
      tone: stale ? "danger" : returned ? "info" : "attention",
    });
  }
  return entries;
}

/** 内核阶段轨迹:history 一步一条,外加当前停在哪。 */
function fromKernel(cwd: string): TimelineEntry[] {
  const state = readJson(join(cwd, ".mae-flow.json"));
  if (!state) return [];
  const entries: TimelineEntry[] = [];
  const history = Array.isArray(state.history) ? state.history : [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const step = clip(item.step, 40) || "?";
    const result = clip(item.result, 20);
    entries.push({
      ts: String(item.at ?? ""),
      kind: "phase",
      title: `完成步骤「${step}」`,
      detail: [result && `结果 ${result}`, clip(item.note, 60)]
        .filter(Boolean).join(" · ") || undefined,
      tone: result === "done" || !result ? "info" : "attention",
    });
  }
  return entries;
}

/** 质量台账:编译/UT/代码检查的真实执行与成败。 */
function fromQualityLedger(cwd: string): TimelineEntry[] {
  const ledger = readJson(join(cwd, ".mae-flow.json.quality-executions"));
  const rows = Array.isArray(ledger?.executions) ? ledger!.executions : [];
  const label: Record<string, string> = {
    COMPILE: "编译", UT: "单元测试", CODECHECK: "代码检查",
  };
  const entries: TimelineEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const kind = String(row.kind ?? "");
    const ok = row.succeeded === true;
    entries.push({
      ts: String(row.at ?? ""),
      kind: "quality",
      title: `${label[kind] ?? kind}执行:${ok ? "成功" : "失败"}`,
      detail: [clip(row.step, 40) && `步骤 ${clip(row.step, 40)}`,
        clip(row.command, 80) || "(台账没记到命令)"]
        .filter(Boolean).join(" · "),
      tone: ok ? "success" : "danger",
    });
  }
  return entries;
}

/**
 * 读一个任务现场,产出按时间正序的人话时间线。
 * 任何一路数据源出问题都只让那一路缺席,整体永远返回数组。
 */
export function buildTimeline(
  workspace: string,
  cwd?: string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const push = (source: () => TimelineEntry[]) => {
    try {
      entries.push(...source());
    } catch {
      // 单路数据源崩了不影响其他路——只读旁路不许把页面拖垮。
    }
  };
  push(() => fromEvents(workspace));
  const codeDir = resolveCwd(workspace, cwd);
  if (codeDir) {
    push(() => fromKernel(codeDir));
    push(() => fromQualityLedger(codeDir));
  }
  // 时间戳同格式(YYYY-MM-DD HH:MM:SS),字符串序即时间序;
  // 没有时间戳的条目沉到最后,不假装知道它发生在何时。
  return entries.sort((left, right) => {
    if (!left.ts) return 1;
    if (!right.ts) return -1;
    return left.ts.localeCompare(right.ts);
  });
}
