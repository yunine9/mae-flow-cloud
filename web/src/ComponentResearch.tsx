import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import {
  componentRequest,
  type ComponentRepository,
  type ComponentResearchRecord,
} from "./componentResearchApi";
import { getBusinessModules, type BusinessModule } from "./api";
import { Markdown } from "./markdown";
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="grid gap-2">
      {label}
      <Select
        value={value}
        items={items}
        onValueChange={(v) => onChange(v ?? "")}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function ComponentResearch({
  open,
  onClose,
  onAdopt,
}: {
  open: boolean;
  onClose: () => void;
  onAdopt: (id: string) => void;
}) {
  const [components, setComponents] = useState<ComponentRepository[]>([]),
    [records, setRecords] = useState<ComponentResearchRecord[]>([]),
    [modules, setModules] = useState<BusinessModule[]>([]);
  const [component, setComponent] = useState(
      new URLSearchParams(location.search).get("component") ?? "",
    ),
    [language, setLanguage] = useState(""),
    [topic, setTopic] = useState("");
  const [selected, setSelected] = useState(
      new URLSearchParams(location.search).get("componentResearch") ?? "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(""),
    [title, setTitle] = useState(""),
    [editing, setEditing] = useState(false),
    [scope, setScope] = useState("platform"),
    [module, setModule] = useState(""),
    [repos, setRepos] = useState("");
  const [detail, setDetail] = useState<ComponentResearchRecord>();
  const current = detail?.id === selected ? detail : undefined;
  const source = components.find((c) => c.id === component);
  const load = async () => {
    const result = await componentRequest<{
      records: ComponentResearchRecord[];
    }>("/component-research");
    setRecords(result.records);
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<{
          records: ComponentResearchRecord[];
        }>("/component-research");
        if (active) setRecords(result.records);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    void componentRequest<{ components: ComponentRepository[] }>(
      "/component-repositories",
    )
      .then((r) => {
        if (active) setComponents(r.components);
      })
      .catch((e) => setError(e.message));
    void getBusinessModules()
      .then((r) => {
        if (active) setModules(r.modules);
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !selected || ["new", "history"].includes(selected)) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<ComponentResearchRecord>(
          `/component-research/${encodeURIComponent(selected)}`,
        );
        if (active) setDetail(result);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, selected]);
  useEffect(() => {
    setLanguage(source?.languages[0] ?? "");
  }, [component, source?.languages.join(",")]);
  useEffect(() => {
    setDraft(current?.draft ?? "");
    setTitle(
      current
        ? `${current.component.name} · ${current.topic}`.slice(0, 160)
        : "",
    );
    setEditing(false);
    setScope("platform");
    setModule("");
    setRepos("");
  }, [selected, current?.draft]);
  function selectRecord(id: string) {
    setSelected(id);
    const url = new URL(location.href);
    url.searchParams.set("componentResearch", id);
    history.replaceState(history.state, "", url);
  }
  async function start(refresh = false) {
    setBusy(true);
    setError("");
    try {
      const r = await componentRequest<ComponentResearchRecord>(
        "/component-research",
        refresh && current
          ? {
              component_id: current.component.id,
              language: current.language,
              topic: current.topic,
              refresh: true,
            }
          : { component_id: component, language, topic },
      );
      await load();
      setDetail(r);
      selectRecord(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tw-root flex min-h-[620px] h-[calc(100vh-230px)] flex-col gap-5 rounded-xl border border-line bg-white p-6" aria-label="源码萃取工作区">
        <header className="flex items-center gap-4 border-b border-line pb-4">
          <Button variant="outline" onClick={onClose}>← 返回知识库</Button>
          <h2 className="text-xl font-semibold">源码萃取</h2>
          <span className="text-muted-foreground">离开页面后仍会继续，可随时回来查看</span>
        </header>
        <div className="grid grid-cols-[280px_1fr] min-h-0 flex-1 gap-5">
          <aside className="overflow-auto border-r border-line pr-4">
            <Button
              className="mb-4 w-full"
              onClick={() => {
                selectRecord("new");
                setError("");
              }}
            >
              ＋ 发起萃取
            </Button>
            <h3 className="mb-3 font-semibold">萃取记录</h3>
            {records.map((r) => (
              <button
                key={r.id}
                className={`mb-2 w-full rounded-lg border p-3 text-left ${selected === r.id ? "border-primary bg-primary/5" : "border-line"}`}
                onClick={() => {
                  setDetail(undefined);
                  selectRecord(r.id);
                  setError("");
                }}
              >
                <strong className="block">{r.topic}</strong>
                <span className="mt-2 block text-sm text-muted-foreground">
                  {r.component.name} · {knowledgeLanguageLabel(r.language)}
                </span>
                <span className="mt-1 block text-sm">{r.stage}</span>
              </button>
            ))}
            {!records.length && (
              <p className="text-muted-foreground">暂无萃取记录</p>
            )}
          </aside>
          <main className="min-w-0 overflow-auto pr-2 text-base">
            {error && (
              <p role="alert" className="mb-3 text-danger">
                {error}
              </p>
            )}
            {!selected || selected === "history" ? <div className="p-8 text-muted-foreground">选择一条萃取记录查看进度与草稿，或发起新的萃取。</div> : selected !== "new" && !current ? <p className="p-8" role="status">正在加载萃取记录…</p> : !current ? (
              <div className="mx-auto grid max-w-2xl gap-5 py-4">
                <h2 className="text-xl font-semibold">
                  从真实源码中提炼开发范式
                </h2>
                <p className="text-muted-foreground">
                  选定组件、语言与具体问题。后台阅读组件实现、检索真实调用，生成带来源的
                  Markdown 草稿。
                </p>
                <Choice
                  label="基础组件"
                  value={component}
                  onChange={setComponent}
                  items={components
                    .filter((c) => c.enabled)
                    .map((c) => ({ value: c.id, label: c.name }))}
                />
                <a
                  className="text-primary underline"
                  href="/configuration?tab=components"
                >
                  去配置中心维护基础组件仓 ↗
                </a>
                {source && (
                  <p className="break-all text-sm text-muted-foreground">
                    {source.repository} · {source.branch} ·{" "}
                    {source.path || "根目录"}
                  </p>
                )}
                <Choice
                  label="本次萃取语言"
                  value={language}
                  onChange={setLanguage}
                  items={(source?.languages ?? []).map((l) => ({
                    value: l,
                    label: knowledgeLanguageLabel(l),
                  }))}
                />
                <label className="grid gap-2">
                  研究主题
                  <Textarea
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="例如：文件组件的句柄归属、异常清理及 UT Mock 方式"
                  />
                </label>
                <Button
                  disabled={busy || !component || !language || !topic.trim()}
                  onClick={() => void start()}
                >
                  {busy ? "发起中…" : "开始后台萃取"}
                </Button>
              </div>
            ) : (
              <>
                <header className="mb-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold">{current.topic}</h2>
                    {["done", "failed"].includes(current.status) && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void start(true)}
                      >
                        重新萃取
                      </Button>
                    )}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {current.component.name} ·{" "}
                    {knowledgeLanguageLabel(current.language)} ·{" "}
                    {current.operator}
                  </p>
                  <p className="mt-3 font-medium text-primary">
                    {current.stage}
                  </p>
                  {current.error && (
                    <p role="alert" className="mt-3 text-danger">
                      {current.error}
                    </p>
                  )}
                </header>
                <details className="mb-5 rounded-lg border border-line p-4">
                  <summary className="cursor-pointer font-medium">
                    源码范围与研究记录 · {current.evidence.length} 次工具调用
                  </summary>
                  <p className="mt-3 break-all text-sm">
                    {current.component.repository} · {current.component.branch}{" "}
                    · {current.component.path || "根目录"}
                  </p>
                  <p className="my-2 break-all text-sm">
                    固定版本：{current.revision ?? "尚未同步"}
                  </p>
                  <ol className="max-h-64 overflow-auto text-sm">
                    {current.evidence.map((e, i) => (
                      <li
                        key={i}
                        className="border-t border-line py-2 break-all"
                      >
                        {String(e.at ?? "")} ·{" "}
                        {e.tool === "code_search" ? "跨仓检索" : "组件源码"} /{" "}
                        {String(e.action ?? "")}
                        <br />
                        {String(e.query ?? e.path ?? "")}{" "}
                        {String(e.repository ?? "")}{" "}
                        {e.status === "failed"
                          ? `失败：${e.error}`
                          : `返回 ${e.characters ?? 0} 字符`}
                        {typeof e.preview === "string" && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-primary">
                              查看返回片段
                            </summary>
                            <pre className="mt-2 whitespace-pre-wrap rounded bg-surface-2 p-3">
                              {e.preview}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
                {current.draft && (
                  <>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold">
                        {current.document_id
                          ? "原始萃取草稿"
                          : "知识草稿 · 待人工审查"}
                      </h3>
                      <Button
                        variant="outline"
                        disabled={!!current.document_id}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? "预览" : "编辑草稿"}
                      </Button>
                    </div>
                    {editing ? (
                      <Textarea
                        aria-label="知识草稿"
                        className="min-h-[360px] font-mono text-sm"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    ) : (
                      <Markdown text={draft} />
                    )}
                    {current.document_id ? (
                      <Button
                        className="mt-5"
                        onClick={() => onAdopt(current.document_id!)}
                      >
                        查看已采纳知识
                      </Button>
                    ) : (
                      <section className="mt-5 grid gap-4 rounded-lg border border-line bg-surface-2 p-4">
                        <label className="grid gap-2">
                          知识名称
                          <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                          />
                        </label>
                        <Choice
                          label="采纳后的适用范围"
                          value={scope}
                          onChange={setScope}
                          items={[
                            { value: "platform", label: "平台通用" },
                            { value: "module", label: "业务模块" },
                            { value: "repository", label: "特定代码仓" },
                          ]}
                        />
                        {scope === "module" && (
                          <Choice
                            label="业务模块"
                            value={module}
                            onChange={setModule}
                            items={modules
                              .filter((m) => m.status === "active")
                              .map((m) => ({ value: m.id, label: m.name }))}
                          />
                        )}
                        {scope === "repository" && (
                          <label className="grid gap-2">
                            适用代码仓（每行一个地址）
                            <Textarea
                              value={repos}
                              onChange={(e) => setRepos(e.target.value)}
                            />
                          </label>
                        )}
                        <Button
                          disabled={
                            busy ||
                            !draft.trim() ||
                            !title.trim() ||
                            (scope === "module" && !module) ||
                            (scope === "repository" && !repos.trim())
                          }
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            try {
                              const doc = await componentRequest<{
                                id: string;
                              }>(`/component-research/${current.id}/adopt`, {
                                title,
                                content: draft,
                                scope,
                                module_ids: module ? [module] : [],
                                repositories: repos
                                  .split("\n")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              });
                              await load();
                              onAdopt(doc.id);
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          确认采纳到知识库
                        </Button>
                      </section>
                    )}
                  </>
                )}
              </>
            )}
          </main>
        </div>
    </section>
  );
}
