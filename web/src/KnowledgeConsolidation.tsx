import { KnowledgeConsolidationAudit } from "./KnowledgeConsolidationAudit";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarClock,
  Play,
  RefreshCw,
  ArrowLeft,
  Check,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "./markdown";
import { documentRequest } from "./knowledgeDocumentsApi";
import type {
  ConsolidationState,
  KnowledgeTopic,
} from "../../src/knowledgeConsolidationTypes";
const styles = {
  page: "tw-root min-h-[650px] bg-background text-base text-foreground",
  heading:
    "flex items-center justify-between gap-6 border-b border-line px-7 py-6 [&_h2]:my-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-3 [&_h2]:text-[26px] [&_h2]:font-semibold [&_p]:text-muted-foreground [&_p]:leading-relaxed",
  actions: "flex items-center gap-3",
  nav: "flex items-center gap-3 border-b border-line px-7 py-3 [&>span]:ml-auto [&>span]:text-sm [&>span]:text-muted-foreground",
  badge:
    "whitespace-nowrap rounded-md bg-primary/10 px-2 py-1 text-sm text-primary",
  running: "flex items-center gap-3 bg-primary/5 px-7 py-3 text-primary",
  error:
    "my-3 rounded-lg bg-destructive/10 px-4 py-3 leading-relaxed text-destructive",
  warning:
    "my-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 leading-relaxed text-amber-900",
  workspace:
    "grid min-h-[570px] grid-cols-[300px_minmax(0,1fr)] [&>aside]:border-r [&>aside]:border-line [&>aside]:bg-muted/20 [&>aside>button]:flex [&>aside>button]:w-full [&>aside>button]:gap-3 [&>aside>button]:border-b [&>aside>button]:border-line [&>aside>button]:px-5 [&>aside>button]:py-5 [&>aside>button]:text-left [&>aside>button.selected]:border-l-[3px] [&>aside>button.selected]:border-l-primary [&>aside>button.selected]:bg-primary/8 [&>aside_strong]:block [&>aside_strong]:text-base [&>aside_small]:my-2 [&>aside_small]:block [&>aside_small]:text-sm [&>aside_small]:text-muted-foreground [&>aside_em]:block [&>aside_em]:text-sm [&>aside_em]:not-italic [&>aside_em]:text-primary [&>main]:min-w-0 [&>main]:p-6 [&_footer]:mt-6 [&_footer]:flex [&_footer]:items-center [&_footer]:justify-end [&_footer]:gap-3 [&_footer]:border-t [&_footer]:border-line [&_footer]:pt-5 [&_footer>span]:mr-auto [&_footer>span]:text-sm [&_footer>span]:text-muted-foreground",
  "topic-head":
    "flex items-start justify-between gap-3 [&_h3]:text-[23px] [&_h3]:font-semibold [&_p]:my-2 [&_p]:leading-relaxed [&_p]:text-muted-foreground",
  sources:
    "my-5 rounded-xl border border-line bg-muted/20 p-4 [&>span]:mb-3 [&>span]:mt-2 [&>span]:block [&>span]:text-sm [&>span]:text-muted-foreground [&>div]:flex [&>div]:flex-wrap [&>div]:items-center [&>div]:gap-2 [&_small]:text-muted-foreground",
  tabs: "flex gap-2 border-b border-line pb-3",
  comparison:
    "grid grid-cols-2 gap-5 pt-4 [&>section]:max-h-[620px] [&>section]:min-w-0 [&>section]:overflow-auto [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:p-5 [&>section]:break-words [&_h4]:mb-4 [&_h4]:border-b [&_h4]:border-line [&_h4]:pb-3 [&_h4]:text-sm [&_h4]:text-muted-foreground",
  reading: "px-1 py-6 leading-relaxed",
  history: "px-1 py-6 leading-relaxed",
  editor:
    "my-5 grid gap-4 [&_textarea]:min-h-[420px] [&_textarea]:text-base [&_textarea]:leading-relaxed",
  empty: "px-5 py-8 leading-relaxed text-muted-foreground",
  jobs: "px-7 py-5 [&_article]:flex [&_article]:justify-between [&_article]:gap-5 [&_article]:border-b [&_article]:border-line [&_article]:py-5 [&_p]:my-2 [&_small]:text-muted-foreground",
  settings:
    "grid gap-5 pt-3 [&_label]:block [&_input]:mt-2 [&_p]:leading-relaxed [&_p]:text-muted-foreground",
};

type Topic = KnowledgeTopic & { stale: boolean; pending_stale: boolean };
type State = Omit<ConsolidationState, "topics"> & { topics: Topic[] };
const api = <T,>(path = "", body?: unknown) =>
  documentRequest<T>(`/consolidation${path}`, body);
export function KnowledgeConsolidation({ onClose }: { onClose: () => void }) {
  const [auditId, setAuditId] = useState("");
  const [data, setData] = useState<State>(),
    [selected, setSelected] = useState(
      new URLSearchParams(location.search).get("knowledgeConsolidation") ?? "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("review"),
    [settings, setSettings] = useState(false),
    [enabled, setEnabled] = useState(true),
    [time, setTime] = useState("03:00"),
    [zone, setZone] = useState("Asia/Shanghai");
  const [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [covered, setCovered] = useState<string[]>([]),
    [revision, setRevision] = useState(0),
    [dirty, setDirty] = useState(false),
    [mode, setMode] = useState("compare");
  const [source, setSource] = useState<{ title: string; content: string }>(),
    request = useRef(0);
  const topic = data?.topics.find((t) => t.id === selected),
    version = topic?.pending ?? topic?.published;
  const load = async () => {
    const next = await api<State>();
    setData(next);
    setSelected((id) =>
      next.topics.some((t) => t.id === id)
        ? id
        : (next.topics.find((t) => t.pending)?.id ?? next.topics[0]?.id ?? ""),
    );
    return next;
  };
  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (alive) void load().catch((e) => alive && setError(e.message));
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!version || dirty) return;
    setTitle(version.title);
    setContent(version.content);
    setCovered(version.sources.filter((s) => s.full).map((s) => s.id));
    setRevision(topic!.revision);
  }, [topic?.id, topic?.revision, dirty]);
  useEffect(() => {
    if (topic) setMode(topic.published ? "compare" : "preview");
  }, [topic?.id]);
  const pick = (id: string) => {
    if (dirty && !confirm("尚有未保存的编辑，离开这篇草稿？")) return;
    setDirty(false);
    setSelected(id);
    setMode("compare");
  };
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      setDirty(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const save = (verb: string) =>
    action(`/${selected}/${verb}`, { title, content, covered, revision });
  async function showSource(id: string) {
    const epoch = ++request.current;
    try {
      const doc = await documentRequest<{ title: string; content: string }>(
        `/${encodeURIComponent(id)}`,
      );
      if (epoch === request.current) setSource(doc);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const pending = data?.topics.filter((t) => t.pending).length ?? 0,
    running = data?.jobs.find((j) => j.state === "running");
  return (
    <section className={styles.page}>
      {auditId && (
        <KnowledgeConsolidationAudit
          id={auditId}
          onClose={() => setAuditId("")}
        />
      )}
      <header className={styles["heading"]}>
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              if (!dirty || confirm("尚有未保存的编辑，返回知识库？"))
                onClose();
            }}
          >
            <ArrowLeft size={17} />
            知识库
          </Button>
          <h2>
            <BookOpen />
            知识整理
          </h2>
          <p>把已采纳经验与正式文档，整理成可持续维护的专题。</p>
        </div>
        <div className={styles["actions"]}>
          <Button
            variant="outline"
            onClick={() => {
              setEnabled(data?.settings.enabled ?? true);
              setTime(data?.settings.time ?? "03:00");
              setZone(data?.settings.timezone ?? "Asia/Shanghai");
              setSettings(true);
            }}
          >
            <CalendarClock size={17} />
            每天定时整理
          </Button>
          <Button
            disabled={busy || !!running}
            onClick={() => void action("/run")}
          >
            <Play size={16} />
            立即整理
          </Button>
        </div>
      </header>
      {error && (
        <div role="alert" className={styles["error"]}>
          {error}
        </div>
      )}
      <nav className={styles["nav"]}>
        <Button
          variant={tab === "review" ? "secondary" : "ghost"}
          onClick={() => setTab("review")}
        >
          专题与待审草稿{" "}
          {pending > 0 && <span className={styles["badge"]}>{pending}</span>}
        </Button>
        <Button
          variant={tab === "jobs" ? "secondary" : "ghost"}
          onClick={() => setTab("jobs")}
        >
          整理记录
        </Button>
        <span>
          {data?.settings.enabled
            ? `每天 ${data.settings.time} · ${data.settings.timezone}`
            : "定时整理已暂停"}
        </span>
      </nav>
      {running && (
        <div className={styles["running"]}>
          <RefreshCw size={17} />
          {running.stage}
          <Button variant="link" onClick={() => setTab("jobs")}>
            查看进度
          </Button>
        </div>
      )}
      {tab === "jobs" ? (
        <div className={styles["jobs"]}>
          {[...(data?.jobs ?? [])].reverse().map((job) => (
            <article key={job.id}>
              <div>
                <strong>
                  {
                    {
                      running: "正在整理",
                      done: "整理完成",
                      failed: "整理失败",
                      cancelled: "已停止",
                    }[job.state]
                  }
                </strong>
                <p>{job.stage}</p>
                {job.error && <p className={styles["error"]}>{job.error}</p>}
                {job.notification_error && (
                  <p className={styles["warning"]}>
                    通知未送达：{job.notification_error}
                  </p>
                )}
                <small>
                  {new Date(job.at).toLocaleString()} · {job.operator} ·{" "}
                  {job.topics.length} 篇草稿
                </small>
              </div>
              <div className={styles["actions"]}>
                <Button variant="outline" onClick={() => setAuditId(job.id)}>
                  查看整理详情
                </Button>
                {job.topics.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      pick(job.topics[0]);
                      setTab("review");
                    }}
                  >
                    查看草稿
                  </Button>
                )}
                {job.state === "running" ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void action("/stop")}
                  >
                    停止
                  </Button>
                ) : (
                  (job.state === "failed" || job.state === "cancelled") && (
                    <Button
                      variant="outline"
                      disabled={busy || !!running}
                      onClick={() => void action("/retry")}
                    >
                      重试
                    </Button>
                  )
                )}
              </div>
            </article>
          ))}
          {!data?.jobs.length && (
            <p className={styles["empty"]}>
              尚无整理记录。可立即整理，也可等待每日定时运行。
            </p>
          )}
        </div>
      ) : (
        <div className={styles["workspace"]}>
          <aside>
            {data?.topics.map((t) => (
              <button
                key={t.id}
                className={selected === t.id ? "selected" : ""}
                onClick={() => pick(t.id)}
              >
                <FileText size={21} />
                <span>
                  <strong>
                    {(t.pending ?? t.published)?.title ?? "已撤回专题"}
                  </strong>
                  <small>
                    {t.scope} ·{" "}
                    {t.applicability?.languages.join(" / ") ||
                      "保留原文适用条件"}
                  </small>
                  <em>
                    {t.pending
                      ? t.edited
                        ? "已人工编辑 · 待采纳"
                        : "待审查"
                      : t.stale
                        ? "来源有变化 · 暂停检索"
                        : t.published
                          ? "已采纳"
                          : "已撤回"}
                  </em>
                </span>
              </button>
            ))}
            {!data?.topics.length && (
              <p className={styles["empty"]}>整理后，专题草稿会显示在这里。</p>
            )}
          </aside>
          <main>
            {topic && version ? (
              <>
                <header className={styles["topic-head"]}>
                  <div>
                    <h3>{version.title}</h3>
                    <p>{version.summary}</p>
                  </div>
                  <span className={styles["badge"]}>
                    {topic.pending ? "待审查" : "已采纳"}
                  </span>
                </header>
                {topic.needs_update && (
                  <p className={styles.warning}>
                    还有新的相关资料；当前草稿保留你的编辑，审查后将继续增量整理。
                  </p>
                )}
                {(topic.stale || topic.pending_stale) && (
                  <div className={styles["warning"]}>
                    来源已修改或停用。旧专题已退出检索，仍有效的原始资料继续可用。请保留需要的编辑后丢弃过期草稿，再重新整理。
                  </div>
                )}
                {version.conflicts.length > 0 && (
                  <div className={styles["warning"]}>
                    <strong>需要你判断</strong>
                    {version.conflicts.map((c, i) => (
                      <p key={i}>{c}</p>
                    ))}
                  </div>
                )}
                <div className={styles["sources"]}>
                  <strong>来源与覆盖范围</strong>
                  <span>
                    仅勾选已完整覆盖的原文；采纳后检索优先使用专题，原文仍保留。
                  </span>
                  {version.sources.map((s) => (
                    <div key={s.id}>
                      {topic.pending && (
                        <input
                          type="checkbox"
                          aria-label={`完整覆盖 ${s.title}`}
                          checked={covered.includes(s.id)}
                          onChange={(e) => {
                            setCovered((v) =>
                              e.target.checked
                                ? [...v, s.id]
                                : v.filter((id) => id !== s.id),
                            );
                            setDirty(true);
                          }}
                        />
                      )}
                      <Button
                        variant="link"
                        onClick={() => void showSource(s.id)}
                      >
                        {s.title}
                      </Button>
                      <small>
                        {s.sections.join(" · ") || "全文"}
                        {!topic.pending && s.full ? " · 已完整覆盖" : ""}
                      </small>
                    </div>
                  ))}
                </div>
                <nav className={styles["tabs"]}>
                  {[
                    ...(topic.pending
                      ? [
                          ["compare", "整理前后"],
                          ["edit", "编辑草稿"],
                        ]
                      : []),
                    ["preview", "阅读专题"],
                    ["history", "修改记录"],
                  ].map(([key, label]) => (
                    <Button
                      key={key}
                      variant={mode === key ? "secondary" : "ghost"}
                      onClick={() => setMode(key)}
                    >
                      {label}
                    </Button>
                  ))}
                </nav>
                {mode === "history" ? (
                  <div className={styles["history"]}>
                    {[...topic.history].reverse().map((h, i) => (
                      <p key={i}>
                        {h.action} · {h.operator} ·{" "}
                        {new Date(h.at).toLocaleString()}
                      </p>
                    ))}
                  </div>
                ) : mode === "edit" && topic.pending ? (
                  <div className={styles["editor"]}>
                    <Input
                      aria-label="专题名称"
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setDirty(true);
                      }}
                    />
                    <Textarea
                      aria-label="编辑专题 Markdown"
                      value={content}
                      onChange={(e) => {
                        setContent(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                ) : mode === "compare" && topic.pending ? (
                  <div className={styles["comparison"]}>
                    <section>
                      <h4>整理前 · 已采纳版本</h4>
                      {topic.published ? (
                        <Markdown text={topic.published.content} />
                      ) : (
                        <p className={styles["empty"]}>
                          这是新专题。点击上方来源可对照原文。
                        </p>
                      )}
                    </section>
                    <section>
                      <h4>整理后 · 待审草稿</h4>
                      <Markdown text={content} />
                    </section>
                  </div>
                ) : (
                  <div className={styles["reading"]}>
                    <Markdown text={content} />
                  </div>
                )}
                <footer>
                  {topic.pending ? (
                    <>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          if (confirm("丢弃此草稿？相同来源不会每天重复提出。"))
                            void save("discard");
                        }}
                      >
                        丢弃草稿
                      </Button>
                      <span>
                        {dirty ? "有未保存的编辑" : "编辑不会被定时整理覆盖"}
                      </span>
                      <Button
                        variant="outline"
                        disabled={busy || !dirty}
                        onClick={() => void save("edit")}
                      >
                        保存草稿
                      </Button>
                      <Button
                        disabled={busy || topic.pending_stale}
                        onClick={() => void save("adopt")}
                      >
                        <Check size={16} />
                        采纳入库
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={busy || !topic.published}
                      onClick={() => {
                        if (confirm("撤回后将恢复检索原始资料，确认撤回？"))
                          void save("withdraw");
                      }}
                    >
                      撤回专题
                    </Button>
                  )}
                </footer>
              </>
            ) : (
              <p className={styles["empty"]}>
                选择一个专题，查看来源、编辑并决定是否采纳。
              </p>
            )}
          </main>
        </div>
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="tw-root">
          <DialogHeader>
            <DialogTitle>定时整理</DialogTitle>
          </DialogHeader>
          <div className={styles["settings"]}>
            <label>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              每天自动整理有变化的知识
            </label>
            <label>
              执行时间
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label>
              时区
              <Input value={zone} onChange={(e) => setZone(e.target.value)} />
            </label>
            <p>
              使用平台主模型。没有资料变化不调用模型；已有待审草稿不会被覆盖。保存设置后，新草稿会通过小鲁班通知本次设置人（需部署通知服务）。
            </p>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/settings", { enabled, time, timezone: zone });
                  await load();
                  setSettings(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存设置
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!source}
        onOpenChange={(open) => {
          if (!open) setSource(undefined);
        }}
      >
        <DialogContent className="tw-root !max-w-[1100px] max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{source?.title}</DialogTitle>
          </DialogHeader>
          <Markdown text={source?.content ?? ""} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
