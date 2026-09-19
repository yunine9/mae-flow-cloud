import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Markdown } from "./markdown";
import { documentRequest } from "./knowledgeDocumentsApi";
import type { ConsolidationAuditDetail } from "../../src/knowledgeConsolidationTypes";
const timestamp = (v?: string) =>
  v ? new Date(v).toLocaleString() : "尚未结束";
const dispositions = {
  draft: "生成待审草稿",
  deferred: "保留当前人工草稿，后续再整理",
  unchanged: "没有实质变化",
  not_applied: "生成结果未应用",
};
export function KnowledgeConsolidationAudit({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const sourceRequest = useRef(0);
  const [data, setData] = useState<ConsolidationAuditDetail>(),
    [error, setError] = useState(""),
    [group, setGroup] = useState(""),
    [tab, setTab] = useState("results");
  const [snapshot, setSnapshot] = useState<{
      title: string;
      content: string;
      revision: string;
    }>(),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true,
      finished = false;
    const load = async () => {
      try {
        const value = await documentRequest<ConsolidationAuditDetail>(
          `/consolidation/jobs/${encodeURIComponent(id)}`,
        );
        if (live) {
          setData(value);
          setGroup((k) => k || value.groups[0]?.key || "");
          finished = value.job.state !== "running";
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!finished) void load();
    }, 5000);
    return () => {
      live = false;
      sourceRequest.current++;
      clearInterval(timer);
    };
  }, [id]);
  const selected = data?.groups.find((g) => g.key === group),
    job = data?.job;
  async function source(sourceId: string) {
    const request = ++sourceRequest.current;
    setLoading(true);
    setError("");
    try {
      const value = await documentRequest<{
        title: string;
        content: string;
        revision: string;
      }>(
        `/consolidation/jobs/${id}/source/${group}/${encodeURIComponent(sourceId)}`,
      );
      if (request === sourceRequest.current) setSnapshot(value);
    } catch (e) {
      if (request === sourceRequest.current) setError((e as Error).message);
    } finally {
      if (request === sourceRequest.current) setLoading(false);
    }
  }
  const names = new Map(
    [
      ...(selected?.sources ?? []),
      ...(selected?.before ?? []).map((t) => ({
        id: t.id,
        title: (t.pending ?? t.published)?.title ?? t.key,
      })),
    ].map((s) => [s.id, s.title]),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="tw-root !max-w-[1480px] h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>整理记录详情</DialogTitle>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-destructive"
          >
            {error}
          </p>
        )}
        {!data ? (
          <p>正在读取整理记录…</p>
        ) : (
          <div className="min-h-0 overflow-auto space-y-5 pr-2">
            <div className="grid grid-cols-4 gap-4 rounded-xl border border-line bg-muted/20 p-5 text-base">
              <div>
                <small className="text-muted-foreground">开始时间</small>
                <p>{timestamp(job!.at)}</p>
              </div>
              <div>
                <small className="text-muted-foreground">结束时间</small>
                <p>{timestamp(job!.ended_at)}</p>
              </div>
              <div>
                <small className="text-muted-foreground">
                  触发方式 / 操作人
                </small>
                <p>
                  {job!.trigger === "scheduled"
                    ? "定时整理"
                    : job!.trigger === "manual"
                      ? "手动发起"
                      : "旧记录未记录触发方式"}{" "}
                  · {job!.operator}
                </p>
              </div>
              <div>
                <small className="text-muted-foreground">本轮结果</small>
                <p>
                  {data.groups.reduce((n, g) => n + g.sources.length, 0)} 份输入
                  → {job!.topics.length} 篇待审草稿
                </p>
              </div>
            </div>
            <p className="text-muted-foreground">
              {job!.stage}
              {job!.error ? `：${job!.error}` : ""} · {job!.id}
            </p>
            {!data.groups.length ? (
              <p className="rounded-xl border border-line p-6">
                本轮没有资料处理记录。无变更检查不会调用模型；旧版本未留存的内容不做补造。
              </p>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <strong>整理范围</strong>
                  <Select
                    value={group}
                    onValueChange={(v) => {
                      sourceRequest.current++;
                      setLoading(false);
                      setGroup(v ?? "");
                      setSnapshot(undefined);
                    }}
                    items={data.groups.map((g, i) => ({
                      value: g.key,
                      label: `${i + 1}. ${g.scope} · ${g.sources.length} 份资料`,
                    }))}
                  >
                    <SelectTrigger className="w-[360px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.groups.map((g, i) => (
                        <SelectItem key={g.key} value={g.key}>
                          {i + 1}. {g.scope} · {g.sources.length} 份资料
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-sm text-muted-foreground">
                    {selected?.execution
                      ? `模型：${selected.execution.provider} / ${selected.execution.model}`
                      : "旧记录未保存模型信息"}
                  </span>
                </div>
                {snapshot ? (
                  <section className="space-y-4 rounded-xl border border-line p-5">
                    <Button
                      variant="outline"
                      onClick={() => setSnapshot(undefined)}
                    >
                      ← 返回本轮记录
                    </Button>
                    <h3 className="text-xl font-semibold">
                      当时的原文：{snapshot.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      版本 {snapshot.revision} ·
                      此处读取本轮固定快照，不受后续文档编辑影响
                    </p>
                    <Markdown text={snapshot.content} />
                  </section>
                ) : (
                  <>
                    <nav className="flex gap-2 border-b border-line pb-3">
                      {[
                        ["results", "整理了什么"],
                        ["sources", "输入资料"],
                        ["actions", "怎么整理的"],
                      ].map(([value, label]) => (
                        <Button
                          key={value}
                          variant={tab === value ? "secondary" : "ghost"}
                          onClick={() => setTab(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </nav>
                    {tab === "sources" ? (
                      <div className="space-y-3">
                        {selected?.sources.map((s) => (
                          <div
                            key={s.id}
                            className="flex items-center justify-between gap-4 rounded-xl border border-line p-4"
                          >
                            <div>
                              <strong>{s.title}</strong>
                              <p className="text-sm text-muted-foreground">
                                {s.characters.toLocaleString()} 字符 · 原文版本{" "}
                                {s.revision.slice(0, 16)}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              disabled={loading}
                              onClick={() => void source(s.id)}
                            >
                              阅读当时的原文
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : tab === "actions" ? (
                      <div className="space-y-4">
                        <p className="text-muted-foreground">
                          下面是实际工具操作；整理依据见结果说明。不会展示模型内部思考或凭据。
                        </p>
                        {!selected?.actions.length ? (
                          <p>这轮没有留存可展示的工具操作记录。</p>
                        ) : (
                          <ol className="space-y-3">
                            {selected.actions.map((e, i) => (
                              <li
                                key={i}
                                className="rounded-lg border border-line p-4"
                              >
                                <div className="flex gap-4">
                                  <time className="text-sm text-muted-foreground">
                                    {timestamp(e.at)}
                                  </time>
                                  <strong>
                                    {(
                                      {
                                        "list:started": "开始浏览目录",
                                        "list:finished": "已浏览目录",
                                        "search:started": "开始检索",
                                        "search:finished": "检索返回",
                                        "read:started": "开始阅读",
                                        "read:finished": "已阅读原文",
                                      } as Record<string, string>
                                    )[e.action] ?? e.action}
                                  </strong>
                                </div>
                                {e.query && <p>查询：{e.query}</p>}
                                {e.id && (
                                  <p>
                                    {names.get(e.id) ?? e.id} · 从第{" "}
                                    {(e.offset ?? 0) + 1} 个字符读取
                                    {e.characters !== undefined
                                      ? `，返回 ${e.characters} 个字符`
                                      : ""}
                                  </p>
                                )}
                                {e.returned_ids && (
                                  <p className="text-sm text-muted-foreground">
                                    返回：
                                    {e.returned_ids
                                      .map((id) => names.get(id) ?? id)
                                      .join("、") || "无匹配资料"}
                                  </p>
                                )}
                                {e.error && (
                                  <p className="text-destructive">{e.error}</p>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                        {selected?.execution && (
                          <details className="rounded-lg border border-line p-4">
                            <summary className="cursor-pointer font-semibold">
                              本轮给 Agent 的整理要求
                            </summary>
                            <pre className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
                              {selected.execution.instruction}
                            </pre>
                          </details>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-5">
                        {selected?.results === undefined ? (
                          <p className="rounded-xl border border-line p-5">
                            这轮没有保存生成稿快照（可能是旧记录，或尚未完成生成）。不会以当前草稿冒充当时的结果。
                          </p>
                        ) : !selected.results.length ? (
                          <p>Agent 检查后没有提出新的专题或实质更新。</p>
                        ) : (
                          selected.results.map((r, i) => {
                            const before = selected.before.find(
                              (t) => t.key === r.key,
                            );
                            const prior = before?.pending ?? before?.published;
                            return (
                              <section
                                key={i}
                                className="space-y-4 rounded-xl border border-line p-5"
                              >
                                <header className="flex items-center justify-between gap-4">
                                  <h3 className="text-xl font-semibold">
                                    {r.version.title}
                                  </h3>
                                  <span className="rounded-md bg-primary/10 px-3 py-1 text-sm text-primary">
                                    {dispositions[r.disposition]}
                                  </span>
                                </header>
                                <p>
                                  <strong>整理依据：</strong>
                                  {r.version.rationale ||
                                    "该轮未记录文字说明，请对照来源和前后内容核查。"}
                                </p>
                                {r.version.conflicts.length > 0 && (
                                  <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
                                    {r.version.conflicts.map((c, j) => (
                                      <p key={j}>{c}</p>
                                    ))}
                                  </div>
                                )}
                                <div className="flex flex-wrap gap-2">
                                  {r.version.sources.map((s) => (
                                    <Button
                                      key={s.id}
                                      variant="outline"
                                      disabled={loading}
                                      onClick={() => void source(s.id)}
                                    >
                                      {s.title} ·{" "}
                                      {s.full ? "全文覆盖" : "部分引用"}
                                    </Button>
                                  ))}
                                </div>
                                <div
                                  className={
                                    prior ? "grid grid-cols-2 gap-5" : ""
                                  }
                                >
                                  {prior && (
                                    <section className="min-w-0 rounded-lg bg-muted/20 p-4">
                                      <h4 className="mb-4 font-semibold">
                                        整理前 · 当时的
                                        {before?.pending
                                          ? "待审草稿"
                                          : "已采纳版本"}
                                      </h4>
                                      <Markdown text={prior.content} />
                                    </section>
                                  )}
                                  <section className="min-w-0 p-4">
                                    <h4 className="mb-4 font-semibold">
                                      当时生成的结果{!prior ? " · 新专题" : ""}
                                    </h4>
                                    <Markdown text={r.version.content} />
                                  </section>
                                </div>
                              </section>
                            );
                          })
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
