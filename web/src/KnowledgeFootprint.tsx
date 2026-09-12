import { useEffect, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription } from "@/components/Empty";
import { OverlayDialog } from "./WarmupPanel";
import { KnowledgeSource } from "./KnowledgeSource";
import { knowledgeOrigin } from "./knowledgeOrigin";
import { memoryPreparation } from "./memoryPresentation";
import { cn } from "cn";
import {
  syncTaskSkills,
  listTaskMemories,
  listTaskMemoryUsage,
  readTaskMemory,
  type MemoryUsageRow,
  withdrawTaskMemory,
  type MemoryRecord,
  interruptTask,
  type KnowledgeAction,
  type KnowledgeKind,
  type TaskKnowledgeUsage,
  type TaskKnowledgeResource,
} from "./api";

const KIND = { rules: "规则", document: "文档", skill: "Skill" } as const;
const ACTION: Record<KnowledgeAction, string> = {
  available: "进入能力目录", loaded: "已加载到上下文",
  read: "读取正文", searched: "检索定位",
};
const ROLE = { main: "主 Agent", subagent: "子 Agent", prepush: "Build-Fix",
  warmup: "预热编译", "developer-assistant": "开发助手" } as const;

/** 知识种类→色:资源卡左侧色条、事件时间轴圆点同一份词典
 * (原硬编码 #efaa4b/#36a88b/#7a6de2 收编进状态/合并令牌)。 */
const KIND_ACCENT: Record<KnowledgeKind, string> = {
  rules: "bg-attention",
  document: "bg-success",
  skill: "bg-merge",
};
const KIND_BAR: Record<KnowledgeKind, string> = {
  rules: "shadow-[inset_3px_0_0_var(--attention)]",
  document: "shadow-[inset_3px_0_0_var(--success)]",
  skill: "shadow-[inset_3px_0_0_var(--merge)]",
};

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hour12: false,
  });
}

/** 原文链接(原 .knowledge-source-link):正文色链接,悬停下划线。 */
function SourceLink({ className, ...props }: ComponentProps<"button">) {
  return <button type="button" className={cn("cursor-pointer overflow-hidden",
    "text-left text-primary underline-offset-2 hover:underline",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    className)} {...props} />;
}

/** 平台回执(原 .knowledge-workbench-feedback:紫底浅字提示条)。 */
function Feedback({ children }: { children: ReactNode }) {
  return <p role="status" className="m-0 rounded-md bg-merge-soft px-2.5 py-2
    text-sm/relaxed text-merge">{children}</p>;
}

/** 记忆行左侧的字章(原 .knowledge-memory-row > i,按来源/时机分色)。 */
function MemoryMark({ tone, children }: {
  tone: "default" | "success" | "attention" | "plain";
  children: ReactNode;
}) {
  return <i aria-hidden className={cn("grid size-[26px] flex-none",
    "place-items-center rounded-[7px] text-xs font-extrabold not-italic",
    tone === "success" ? "bg-success-soft text-success"
      : tone === "attention" ? "bg-attention-soft text-attention"
      : tone === "plain" ? "border border-line bg-surface text-muted-foreground"
        : "bg-merge-soft text-merge")}>{children}</i>;
}

export function KnowledgeFootprint({ usage, utMethod, taskId, taskStatus, canSyncSkills, onChanged }: {
  usage?: TaskKnowledgeUsage;
  utMethod?: string;
  taskId: string;
  taskStatus: string;
  canSyncSkills?: boolean;
  onChanged?: () => void;
}) {
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState("");
  async function supplementSkills() {
    setSyncBusy(true); setSyncFeedback("");
    try {
      const result = await syncTaskSkills(taskId);
      setSyncFeedback([result.added.length ? `已补充：${result.added.join("、")}` : "", result.receipt, ...result.warnings].filter(Boolean).join("；"));
      onChanged?.();
    } catch (error) { setSyncFeedback(error instanceof Error ? error.message : "补充失败，请重试"); }
    finally { setSyncBusy(false); }
  }
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState<TaskKnowledgeResource>();
  const [feedback, setFeedback] = useState("");
  // 这单记下的记忆(docs/knowledge-memory-design.md §9):只读列表 + 撤回。
  // 不逐条在文档上打标——文档太多,标满了反而看不见(用户拍板)。
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoryUsage, setMemoryUsage] = useState<MemoryUsageRow[]>([]);
  const [memoryOpen, setMemoryOpen] = useState<{ id: string; content: string }>();
  const [memoryBusy, setMemoryBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void listTaskMemories(taskId).then((rows) => { if (alive) setMemories(rows); });
      void listTaskMemoryUsage(taskId).then((rows) => { if (alive) setMemoryUsage(rows); });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [taskId]);
  async function openMemory(record: MemoryRecord) {
    if (memoryOpen?.id === record.id) { setMemoryOpen(undefined); return; }
    const found = await readTaskMemory(taskId, record.id);
    if (found) setMemoryOpen({ id: record.id, content: found.content });
  }
  async function withdrawMemory(record: MemoryRecord) {
    if (memoryBusy) return;
    setMemoryBusy(true);
    setFeedback("");
    const result = await withdrawTaskMemory(taskId, record.id);
    setMemoryBusy(false);
    if (result.error) { setFeedback(result.error); return; }
    setMemories(await listTaskMemories(taskId));
  }
  const [busy, setBusy] = useState(false);
  const consumed = usage?.resources.filter((item) =>
    item.loaded_count > 0 || item.read_count > 0) ?? [];
  const resources = usage?.resources ?? [];
  const catalog = [
    { title: "平台", note: "平台提供的知识，包含工作流自带的规则与 Skill",
      items: resources.filter((item) => knowledgeOrigin(item) === "平台") },
    { title: "代码仓", note: "代码仓中的项目规则、文档与 Skill",
      items: resources.filter((item) => knowledgeOrigin(item) === "代码仓") },
    { title: "来源未记录", note: "早期记录未保留来源，仍可查看原文和使用情况",
      items: resources.filter((item) => knowledgeOrigin(item) === "来源未记录") },
  ].filter((group) => group.items.length > 0);

  async function remind(resource: typeof resources[number]) {
    setBusy(true); setFeedback("");
    try {
      await interruptTask(taskId,
        `用户在「本任务知识」中补充指定：请在当前工作相关时优先读取并采用这项知识；若不适用，请明确说明，不要假装使用。\n知识：${resource.name}\n路径：${resource.path}\n说明：${resource.description ?? "无"}`);
      setFeedback(`已提醒 Agent 关注「${resource.name}」；会在当前工具调用结束后送达。`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "补充知识未送达");
    } finally { setBusy(false); }
  }


  return <section
    className="mb-3.5 overflow-hidden rounded-lg border border-success/25
      bg-surface shadow-(--shadow-xs)"
    aria-labelledby="knowledge-footprint-title">
    <header className="grid min-h-[82px] grid-cols-[36px_minmax(0,1fr)_auto]
      items-center gap-3 bg-linear-to-r from-success/10 to-surface p-3.5">
      <div aria-hidden className="grid size-9 place-items-center rounded-[10px]
        border border-success/25 bg-success/10 text-sm font-extrabold
        text-success">知</div>
      <div className="grid min-w-0 gap-0.5"><span className="font-mono
        text-xs font-bold text-success">任务上下文</span><strong
        id="knowledge-footprint-title" className="text-[15px]
        text-foreground">
        本任务知识</strong>
        <p className="m-0 text-sm/relaxed text-muted-foreground">看见本任务可用与实际消费的知识，可中途提醒 Agent 用某一条；沉淀不在这里做——闭环的意见和修复会自动记成下面的记忆。</p></div>
      <div className="flex items-center gap-2" aria-label="知识消费摘要">
        <span className="grid min-w-[62px] gap-px rounded-[9px] border
          border-line bg-muted px-2 py-1.5 text-center"><strong
          className="font-mono text-[15px] font-bold text-foreground">{
          usage?.summary.used ?? 0}</strong><small className="text-sm
          text-muted-foreground">已消费</small></span>
        <span className="grid min-w-[62px] gap-px rounded-[9px] border
          border-line bg-muted px-2 py-1.5 text-center"><strong
          className="font-mono text-[15px] font-bold text-foreground">{
          resources.length}</strong><small className="text-sm
          text-muted-foreground">本任务可用</small></span>
        <Button type="button" variant="outline" size="sm"
          onClick={() => { setCatalogOpen(true); setFeedback(""); }}>提醒 Agent 用这条</Button>
        {canSyncSkills && !["completed", "canceled"].includes(taskStatus) && <Button type="button" variant="outline" size="sm"
          disabled={syncBusy} title="补充新上架且适用的团队技能，保留已加入技能的版本"
          onClick={() => void supplementSkills()}>{syncBusy ? "正在补充…" : "补充新技能"}</Button>}
      </div>
    </header>
    {syncFeedback && <div className="px-3.5 pb-3.5"><Feedback>{syncFeedback}</Feedback></div>}

    {catalogOpen && <OverlayDialog ariaLabel="本任务可用知识"
      title="本任务可用知识" onClose={() => setCatalogOpen(false)}>
      <p className="mb-2 text-sm/relaxed text-muted-foreground">
        平台知识与 Git 原生上下文分开呈现。可用≠已读；提醒会真实送达，送不了会明确报错。
      </p>
      {feedback && <Feedback>{feedback}</Feedback>}
      <div className="max-h-[50vh] overflow-auto">
        {catalog.map((group) => <div key={group.title} className="py-1.5 pb-2">
          <strong className="flex items-center gap-1.5 text-xs font-bold
            text-muted-foreground">{group.title}<i className="font-medium
            not-italic">{group.items.length}</i></strong>
          <small className="mb-1 block text-xs text-faint">{group.note}</small>
          {group.items.slice(0, 30).map((item) => <article key={item.id}
            className="flex items-baseline gap-2.5 py-1 text-sm">
            <SourceLink className="flex-none max-w-[40%] truncate text-[13px]"
              title={`查看原文：${item.path}`}
              onClick={() => { setCatalogOpen(false); setSourceOpen(item); }}>{item.name}</SourceLink>
            <span className="min-w-0 flex-1 truncate text-muted-foreground"
              title={item.description ?? ""}>{item.description || item.path}</span>
            <small className={cn("flex-none", item.read_count > 0
              ? "font-bold text-primary" : item.loaded_count > 0
                ? "text-text" : "text-faint")}>
              {item.read_count > 0 ? `读取 ${item.read_count} 次`
                : item.loaded_count > 0 ? "开局已加载" : "可用未读"}</small>
            <Button type="button" variant="outline" size="xs" className="flex-none"
              disabled={busy || taskStatus !== "running"}
              title={taskStatus === "running" ? "送达当前 Agent"
                : "任务不在运行中，当前不能向 Agent 补充"}
              onClick={() => void remind(item)}>提醒 Agent 使用</Button>
          </article>)}
        </div>)}
        {!catalog.length && <Empty className="mb-3.5 border p-3">
          <EmptyDescription>本任务还没有可提醒的平台知识；下次发起时关联业务模块并确认技术画像即可。</EmptyDescription></Empty>}
      </div>
    </OverlayDialog>}

    <section aria-labelledby="knowledge-memories-title"
      className="mx-3.5 mb-3.5 rounded-lg border border-line bg-surface p-3.5">
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5"><strong id="knowledge-memories-title"
          className="text-base font-semibold text-foreground">这单记下的</strong>
          <small className="text-sm/relaxed text-muted-foreground">闭环的检视意见、修好的构建失败、你圈选记下的，都会自动落在这里；只读，圈错了可撤回。</small></div>
        <Badge variant="merge">{memories.filter((item) => !item.withdrawn && !item.superseded_by).length} 条</Badge>
      </header>
      {feedback && <div className="mt-2"><Feedback>{feedback}</Feedback></div>}
      {memories.length ? <ol className="mt-2.5 grid list-none gap-1.5 p-0">
        {memories.filter((item) => !item.withdrawn).map((item) => {
          const gone = !!item.superseded_by;
          const preparation = memoryPreparation(item);
          return <li key={item.id}
            className={cn("relative rounded-[9px] border border-line bg-muted",
              gone && "opacity-55")}>
            <button type="button" aria-expanded={memoryOpen?.id === item.id}
              className={cn("grid w-full grid-cols-[26px_minmax(0,1fr)] gap-2.5",
                "p-2.5 text-left", !gone && "cursor-pointer")}
              onClick={() => void openMemory(item)}>
              <MemoryMark tone={["user_note", "agent_note"].includes(item.source)
                ? "success" : item.source === "prepush_fix"
                  ? "attention" : "default"}>
                {["user_note", "agent_note"].includes(item.source) ? "记"
                  : item.source === "prepush_fix" ? "修" : "议"}
              </MemoryMark>
              <span className="grid min-w-0 gap-0.5">
                <strong className="flex flex-wrap items-center gap-1.5
                  text-[13.5px] text-foreground">{item.trigger}
                  {item.source !== "user_note" && <Badge variant={
                    item.scope === "general" ? "success"
                      : item.scope === "one_off" ? "warning" : "neutral"}
                    title={preparation.title}>
                    {item.scope === "one_off" ? "一次性" : item.scope === "general" ? "通用" : "局部"}
                    {`·${preparation.label}`}</Badge>}
                  {item.archived && <Badge variant="neutral"
                    title={item.archive_reason}>已沉底</Badge>}
                </strong>
                <em className="text-[13px] not-italic leading-normal
                  text-text">{gone ? "已撤回" : item.conclusion}</em>
                <small className="text-sm text-faint">{item.source === "agent_note" ? "Agent 主动记录" : item.source === "user_note" ? `${item.author ?? "有人"} 圈选记下`
                  : item.source === "prepush_fix" ? "Build-Fix 失败后修好"
                    : "检视意见闭环"}
                  {item.paths[0] ? ` · ${item.paths[0]}${item.line ? `:${item.line}` : ""}` : ""}
                  {` · ${time(item.at)}`}</small>
              </span>
            </button>
            {memoryOpen?.id === item.id && <pre className="m-0 break-words
              border-t border-dashed border-line py-2.5 pl-12 pr-3 text-xs/relaxed
              whitespace-pre-wrap text-muted-foreground">{memoryOpen.content}</pre>}
            {item.source === "user_note" && !gone && <Button type="button"
              variant="outline" size="xs"
              className="absolute top-2 right-2.5" disabled={memoryBusy}
              onClick={() => void withdrawMemory(item)}>撤回</Button>}
          </li>;
        })}
      </ol> : <Empty className="mb-3.5 border p-3">
        <EmptyDescription>还没有记下任何东西。检视意见闭环、Build-Fix 修好失败，或在材料上圈选「记为记忆」后会出现在这里。</EmptyDescription></Empty>}
    </section>
    <section aria-labelledby="knowledge-memory-usage-title"
      className="mx-3.5 mb-3.5 rounded-lg border border-line bg-surface p-3.5">
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5"><strong id="knowledge-memory-usage-title"
          className="text-base font-semibold text-foreground">这单用到的</strong>
          <small className="text-sm/relaxed text-muted-foreground">宿主在开局、进入新阶段、首次改某目录时替 Agent 查过并推送的记忆，以及 Agent 自己查过、展开过的。</small></div>
        <Badge variant="merge">{memoryUsage.length} 次</Badge>
      </header>
      {memoryUsage.length ? <ol className="mt-2.5 grid list-none gap-1.5 p-0">
        {memoryUsage.slice(-12).reverse().map((row, index) => <li
          key={`${row.ts}-${index}`}
          className="relative rounded-[9px] border border-line bg-muted">
          <div className="grid grid-cols-[26px_minmax(0,1fr)] gap-2.5 p-2.5
            text-left">
            <MemoryMark tone={row.moment === "search" || row.moment === "expand"
              ? "plain" : "default"}>
              {row.moment === "launch" ? "启" : row.moment === "phase" ? "阶"
                : row.moment === "edit" ? "改" : row.moment === "search" ? "查" : "展"}
            </MemoryMark>
            <span className="grid min-w-0 gap-0.5">
              <strong className="flex flex-wrap items-center gap-1.5
                text-[13.5px] text-foreground">{row.moment === "launch" ? "开局推送"
                : row.moment === "phase" ? `进入「${row.phase ?? "新阶段"}」时推送`
                  : row.moment === "edit" ? `首次改 ${row.dir || "某目录"} 时${row.digest ? "推送目录摘要" : "提醒"}`
                    : row.moment === "search" ? `Agent 检索：${row.query ?? ""}`
                      : "Agent 展开记忆"}</strong>
              <em className="font-mono text-xs text-muted-foreground">{row.ids.length ? row.ids.join("、") : "没有命中"}</em>
              <small className="text-sm text-faint">{time(row.ts)}</small>
            </span>
          </div>
        </li>)}
      </ol> : <Empty className="mb-3.5 border p-3">
        <EmptyDescription>还没有推送或检索。任务启动时会按仓推送历史记忆；Agent 也可以自己用 corpus_search 查。</EmptyDescription></Empty>}
    </section>
    {utMethod && <p className={cn("mx-3.5 mb-3 rounded-[9px] border px-2.5 py-2",
      "text-sm", utMethod === "仓内既有写法"
        ? "border-dashed border-line bg-muted text-muted-foreground"
        : "border-line bg-muted text-text")}>
      UT 生成方式:<strong className={utMethod === "仓内既有写法"
        ? "text-foreground" : "text-merge"}>「{utMethod}」</strong>
      {utMethod === "仓内既有写法"
        ? "——本单未指向团队 UT Skill，Agent 不读 UT skill 属正确行为。"
        : "——写测试前 Agent 会先读取该 Skill 正文。"}</p>}
    {consumed.length ? <div className="grid grid-cols-[repeat(4,minmax(0,1fr))]
      gap-1.5 px-3.5 pb-3.5">
      {consumed.slice(0, 8).map((item) => <article key={item.id}
        className={cn("grid min-w-0 gap-0.5 rounded-[9px] border border-line",
          "bg-muted p-2.5", KIND_BAR[item.kind])}>
        <span className="text-sm font-bold text-muted-foreground">{
          knowledgeOrigin(item)} · {KIND[item.kind]}</span>
        <strong title={item.name} className="truncate text-sm
          text-foreground">{item.name}</strong>
        <SourceLink className="font-mono text-[13px]" aria-label={`查看原文：${item.name}`}
          title={`查看原文：${item.path}`}
          onClick={() => setSourceOpen(item)}>{item.path} ↗</SourceLink>
        <small className="text-sm text-muted-foreground">{item.read_count > 0 ? `读取/检索 ${item.read_count} 次`
          : "开局已加载"}</small></article>)}</div>
      : <Empty className="mx-3.5 mb-3.5 border p-3">
        <EmptyDescription>尚无已消费知识；可用知识被加载、读取或检索后会在这里出现。</EmptyDescription></Empty>}
    {!!usage?.events.length && <details className="border-t border-line">
      <summary className="flex min-h-[38px] cursor-pointer items-center
        justify-between px-3.5 text-sm font-bold text-text">
        <span>查看消费明细</span><span className="font-medium
          text-muted-foreground">{usage.events.length} 条</span></summary>
      <div className="max-h-[260px] overflow-auto border-t border-line">
        {usage.events.slice(0, 24).map((event, index) =>
          <article key={`${event.ts}-${event.id}-${index}`}
            className="grid min-h-[34px] grid-cols-[7px_78px_minmax(110px,1fr)_auto_minmax(120px,auto)]
              items-center gap-2 border-b border-line px-3.5 py-1.5 text-sm">
            <i aria-hidden className={cn("size-1.5 rounded-full",
              KIND_ACCENT[event.kind])} />
            <time dateTime={event.ts} className="text-muted-foreground">{time(event.ts)}</time>
            <SourceLink className="truncate text-[13px]"
              title={`查看原文：${event.path}`}
              onClick={() => setSourceOpen(resources.find((item) => item.id === event.id))}>
              {event.name}</SourceLink>
            <span className="text-merge">{knowledgeOrigin(resources.find((item) => item.id === event.id) ?? event)} · {ACTION[event.action]}</span>
            <small className="text-right text-muted-foreground">{ROLE[event.session_role]}{event.step ? ` · ${event.step}` : ""}</small>
          </article>)}
      </div>
    </details>}
    {sourceOpen && <KnowledgeSource taskId={taskId} resource={sourceOpen}
      onClose={() => setSourceOpen(undefined)} />}
  </section>;
}
