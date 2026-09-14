/**
 * 任务记忆总览(只读)。docs/knowledge-memory-design.md §9「可见不可管」:
 * 这里没有编辑、没有删除、没有审核——记忆由闭环自动产生、由台账自动排序
 * 和沉底;人能看到"记了什么、谁被推过、谁真被用、谁返工了、谁沉底了",
 * 想撤自己圈的那条,回任务页去撤。
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { memoryPreparation, memorySearchPresentation } from "./memoryPresentation";
import {
  getMemoryInsights, readMemoryInsight,
  type MemoryInsightRow, type MemoryInsights,
} from "./api";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription } from "@/components/Empty";

const SOURCE = {
  agent_note: "Agent 主动记录", annotation: "检视意见闭环", prepush_fix: "Build-Fix 修好", user_note: "人圈选记下",
} as const;
const SCOPE = { one_off: "一次性", local: "局部", general: "仓内通用", platform: "平台通用" } as const;

function day(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], {
    year: "2-digit", month: "2-digit", day: "2-digit",
  });
}

export function MemoryBoard({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [insights, setInsights] = useState<MemoryInsights>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState("");
  const [scope, setScope] = useState("");
  const [source, setSource] = useState("");
  const [withGone, setWithGone] = useState(false);
  const [needle, setNeedle] = useState("");
  const [open, setOpen] = useState<{ id: string; content: string }>();

  async function load() {
    setLoading(true);
    try {
      setInsights(await getMemoryInsights());
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "读取记忆总览失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => {
    const all = insights?.memories ?? [];
    const query = needle.trim();
    return all.filter((row) =>
      (!repo || row.repo === repo)
      && (!scope || row.scope === scope)
      && (!source || row.source === source)
      && (withGone || (!row.archived && !row.withdrawn && !row.superseded_by))
      && (!query || `${row.trigger}${row.conclusion}${row.paths.join(" ")}`.includes(query)))
      .slice(0, 200);
  }, [insights, repo, scope, source, withGone, needle]);

  const totals = useMemo(() => {
    const repos = insights?.repos ?? [];
    const sum = (key: keyof typeof repos[number]) =>
      repos.reduce((acc, item) => acc + Number(item[key] ?? 0), 0);
    return {
      active: sum("active"), one_off: sum("one_off"), archived: sum("archived"),
      pushes: sum("pushes"), hits: sum("hits"), reworks: sum("reworks"),
    };
  }, [insights]);

  async function toggle(row: MemoryInsightRow) {
    if (open?.id === row.id) { setOpen(undefined); return; }
    const found = await readMemoryInsight(row.id);
    if (found) setOpen({ id: row.id, content: found.content });
  }

  const searchStatus = memorySearchPresentation(insights?.sidecar, Boolean(error));
  const chipTone = searchStatus.state === "ready"
    ? "border-success/35 bg-success/10 text-success"
    : searchStatus.state === "unavailable"
      ? "border-attention/35 bg-attention/10 text-attention"
      : "border-line bg-surface-2 text-muted-foreground";

  return <section className="grid gap-3.5" aria-labelledby="memory-board-title">
    <header className="flex min-h-[92px] items-center justify-between gap-6 border-b border-line
      bg-gradient-to-br from-surface-2 to-surface px-[21px] py-[18px]">
      <div><h2 id="memory-board-title" className="text-[21px] font-bold text-text-strong">任务记忆</h2>
        <p className="border-t border-line bg-surface-2 px-5 py-2.5 text-[13px] leading-[1.5] text-faint">
          平台不建知识库，只记住自己干过的活：闭环的检视意见、修好的构建失败、人圈选记下的约定，
          自动落成记忆，下一单改到同一处时推给 Agent。这里只看不管——排序和沉底由台账自动完成。
        </p></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full border px-2 py-[3px] text-[13px]", chipTone)} title={searchStatus.title}>
          {searchStatus.label}
        </span>
        {!!insights?.drafting && <span className="rounded-full border border-line bg-surface-2 px-2 py-[3px] text-[13px] text-muted-foreground">整理中 {insights.drafting}</span>}
        <span className="flex flex-none items-center gap-2.5">
          <button type="button"
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-primary/25
              bg-surface px-2.5 text-[13px] font-bold text-primary hover:border-primary hover:bg-primary/10
              disabled:cursor-wait disabled:opacity-55"
            onClick={() => void load()}
            disabled={loading} aria-label="刷新记忆总览">{loading ? "刷新中…" : "刷新"}</button>
        </span>
      </div>
    </header>
    {error && !insights && <div className="m-5 flex min-h-[110px] flex-col items-start gap-[13px] rounded-[11px]
      border border-dashed border-danger/30 bg-danger/10 p-5 text-danger" role="alert">
      <strong className="text-[13.5px] text-text-strong">读不到记忆总览</strong><span className="text-[13px] text-muted-foreground">{error}</span></div>}
    <div className="grid grid-cols-6 gap-2 max-[900px]:grid-cols-3" aria-label="记忆总览摘要">
      <div className="grid gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5"><strong className="text-xl text-text-strong">{totals.active}</strong><span className="text-[13px] text-muted-foreground">在用</span></div>
      <div className="grid gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5"><strong className="text-xl text-text-strong">{totals.one_off}</strong><span className="text-[13px] text-muted-foreground">一次性（只进检索）</span></div>
      <div className="grid gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5"><strong className="text-xl text-text-strong">{totals.archived}</strong><span className="text-[13px] text-muted-foreground">已沉底</span></div>
      <div className="grid gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5"><strong className="text-xl text-text-strong">{totals.pushes}</strong><span className="text-[13px] text-muted-foreground">推送次数</span></div>
      <div className="grid gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5"><strong className="text-xl text-text-strong">{totals.hits}</strong><span className="text-[13px] text-muted-foreground">Agent 命中</span></div>
      <div className={cn("grid gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5", totals.reworks && "[&>strong]:text-attention")}><strong className="text-xl text-text-strong">{totals.reworks}</strong><span className="text-[13px] text-muted-foreground">推后返工</span></div>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Select value={repo}
        items={[{ value: "", label: "全部仓库" },
          ...(insights?.repos ?? []).map((item) => ({
            value: item.repo, label: `${item.repo}（${item.active} 在用）`,
          }))]}
        onValueChange={(value) => setRepo(value ?? "")}>
        <SelectTrigger aria-label="按仓库筛选"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="">全部仓库</SelectItem>
            {(insights?.repos ?? []).map((item) => <SelectItem key={item.repo} value={item.repo}>
              {item.repo}（{item.active} 在用）</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select value={scope}
        items={[{ value: "", label: "全部范围" },
          ...Object.entries(SCOPE).map(([key, label]) => ({ value: key, label }))]}
        onValueChange={(value) => setScope(value ?? "")}>
        <SelectTrigger aria-label="按范围筛选"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="">全部范围</SelectItem>
            {Object.entries(SCOPE).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select value={source}
        items={[{ value: "", label: "全部来源" },
          ...Object.entries(SOURCE).map(([key, label]) => ({ value: key, label }))]}
        onValueChange={(value) => setSource(value ?? "")}>
        <SelectTrigger aria-label="按来源筛选"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="">全部来源</SelectItem>
            {Object.entries(SOURCE).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Input className="w-56" value={needle} onChange={(event) => setNeedle(event.target.value)}
        placeholder="按触发条件、结论或路径找" aria-label="搜索记忆" />
      <label className="flex items-center gap-2 text-[13px] text-muted-foreground"><Checkbox checked={withGone}
        onCheckedChange={(checked) => setWithGone(checked)} />含已沉底 / 撤回 / 被覆盖</label>
    </div>
    {rows.length ? <ol className="m-0 grid list-none gap-2 p-0">
      {rows.map((row) => {
        const gone = row.archived || row.withdrawn || !!row.superseded_by;
        const preparation = memoryPreparation(row);
        return <li key={row.id} className={cn("rounded-[10px] border border-line bg-surface", gone && "opacity-60")}>
          <button type="button" aria-expanded={open?.id === row.id}
            className="grid w-full cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2.5
              border-0 bg-transparent p-3 text-left font-[inherit] text-inherit hover:bg-surface-2
              max-[900px]:grid-cols-[28px_minmax(0,1fr)]"
            onClick={() => void toggle(row)}>
            <i aria-hidden className={cn("grid size-[26px] place-items-center rounded-[7px] text-xs font-bold not-italic",
              row.source === "prepush_fix" ? "bg-attention/10 text-attention"
                : row.source === "user_note" ? "bg-success/10 text-success" : "bg-primary/10 text-primary")}>
              {["user_note", "agent_note"].includes(row.source) ? "记" : row.source === "prepush_fix" ? "修" : "议"}</i>
            <span className="grid min-w-0 gap-[3px]">
              <strong className="flex flex-wrap items-center gap-1.5 text-text-strong">{row.trigger}
                <b className={cn("rounded border px-1.5 py-px text-xs font-semibold",
                  row.scope === "general" ? "border-success/30 bg-success/10 text-success"
                    : row.scope === "one_off" ? "border-attention/30 bg-attention/10 text-attention"
                      : "border-line bg-surface-2 text-muted-foreground")}>{SCOPE[row.scope]}</b>
                {row.source !== "user_note"
                  && <b className="rounded border border-line bg-surface-2 px-1.5 py-px text-xs font-semibold text-muted-foreground" title={preparation.title}>{preparation.label}</b>}
                {row.archived && <b className="rounded border border-line bg-surface-2 px-1.5 py-px text-xs font-semibold text-faint" title={row.archive_reason}>已沉底</b>}
                {row.withdrawn && <b className="rounded border border-line bg-surface-2 px-1.5 py-px text-xs font-semibold text-faint">已撤回</b>}
                {row.superseded_by && <b className="rounded border border-line bg-surface-2 px-1.5 py-px text-xs font-semibold text-faint">被覆盖</b>}
              </strong>
              <em className="not-italic leading-[1.5] text-text">{row.conclusion}</em>
              <small className="text-[13px] text-muted-foreground">{row.repo} · {SOURCE[row.source]} · {row.judged_by === "human" ? "人确认" : row.judged_by === "agent" ? "Agent 记录" : "流水线"}
                {row.paths[0] ? ` · ${row.paths[0]}${row.line ? `:${row.line}` : ""}` : ""}
                {` · ${day(row.at)}`}
              </small>
            </span>
            <span className="flex gap-1.5 whitespace-nowrap max-[900px]:col-start-2" title={`权重 ${row.weight}${row.last_used ? ` · 最近用于 ${day(row.last_used)}` : ""}`}>
              <b className="rounded bg-surface-2 px-1.5 py-0.5 text-[13px] font-medium text-muted-foreground">推 {row.pushes}</b>
              <b className="rounded bg-surface-2 px-1.5 py-0.5 text-[13px] font-medium text-muted-foreground">命中 {row.hits}</b>
              <b className={cn("rounded bg-surface-2 px-1.5 py-0.5 text-[13px] font-medium text-muted-foreground", row.reworks && "bg-attention/10 text-attention")}>返工 {row.reworks}</b>
            </span>
          </button>
          <div className="px-3 pb-2 pl-[50px]">
            <button type="button" className="cursor-pointer border-0 bg-none p-0 text-[13px] text-primary" onClick={() => onOpenTask?.(row.task)}>
              来自任务 {row.task}</button>
          </div>
          {open?.id === row.id && <pre className="m-0 whitespace-pre-wrap break-words border-t border-dashed border-line
            pb-3 pl-[47px] pr-3 pt-2.5 text-xs leading-[1.55] text-muted-foreground">{open.content}</pre>}
        </li>;
      })}
    </ol> : <Empty className="mx-5 my-5 min-h-[110px] border" role="status">
      <EmptyDescription>{insights ? "还没有符合条件的记忆。闭环的检视意见、修好的构建失败和圈选「记为记忆」会自动落在这里。" : "加载中…"}</EmptyDescription>
    </Empty>}
  </section>;
}
