import { useEffect, useState } from "react";
import { OverlayDialog } from "./WarmupPanel";
import {
  listTaskMemories,
  listTaskMemoryUsage,
  readTaskMemory,
  type MemoryUsageRow,
  withdrawTaskMemory,
  type MemoryRecord,
  interruptTask,
  type KnowledgeAction,
  type TaskKnowledgeUsage,
} from "./api";

const KIND = { rules: "规则", document: "文档", skill: "Skill" } as const;
const ACTION: Record<KnowledgeAction, string> = {
  available: "进入能力目录", loaded: "已加载到上下文",
  read: "读取正文", searched: "检索定位",
};
const ROLE = { main: "主 Agent", subagent: "子 Agent", prepush: "Build-Fix",
  warmup: "预热编译", "developer-assistant": "开发助手" } as const;


function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hour12: false,
  });
}

export function KnowledgeFootprint({ usage, utMethod, taskId, taskStatus }: {
  usage?: TaskKnowledgeUsage;
  utMethod?: string;
  taskId: string;
  taskStatus: string;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
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
    { title: "业务模块知识", note: "由模块 Owner 治理；按任务固定版本",
      items: resources.filter((item) => item.scope === "module") },
    { title: "团队通用知识", note: "由团队资产治理，按任务范围匹配并固定版本",
      items: resources.filter((item) => item.scope === "team") },
    { title: "代码仓原生能力", note: "来自任务固定的 Git commit；平台只读取，不管理",
      items: resources.filter((item) => !!item.repository && item.kind === "skill") },
    { title: "代码仓项目规则", note: "Agent 从 Git 工作现场自主发现",
      items: resources.filter((item) => item.kind === "rules"
        && !item.repository && item.scope !== "team") },
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


  return <section className="knowledge-footprint"
    aria-labelledby="knowledge-footprint-title">
    <header>
      <div className="knowledge-footprint-mark" aria-hidden>知</div>
      <div><span>TASK KNOWLEDGE</span><strong id="knowledge-footprint-title">
        本任务知识</strong>
        <p>看见本任务可用与实际消费的知识，可中途提醒 Agent 用某一条；沉淀不在这里做——闭环的意见和修复会自动记成下面的记忆。</p></div>
      <div className="knowledge-footprint-stats" aria-label="知识消费摘要">
        <span><strong>{usage?.summary.used ?? 0}</strong><small>已消费</small></span>
        <span><strong>{resources.length}</strong><small>本任务可用</small></span>
        <button type="button" className="knowledge-catalog-badge"
          onClick={() => { setCatalogOpen(true); setFeedback(""); }}>提醒 Agent 用这条</button>
      </div>
    </header>

    {catalogOpen && <OverlayDialog ariaLabel="本任务可用知识"
      title="本任务可用知识" onClose={() => setCatalogOpen(false)}>
      <p className="knowledge-catalog-note">
        平台知识与 Git 原生上下文分开呈现。可用≠已读；提醒会真实送达，送不了会明确报错。
      </p>
      {feedback && <p className="knowledge-workbench-feedback" role="status">
        {feedback}</p>}
      <div className="knowledge-catalog-body">
        {catalog.map((group) => <div key={group.title}
          className="knowledge-catalog-group">
          <strong>{group.title}<i>{group.items.length}</i></strong>
          <small className="knowledge-catalog-group-note">{group.note}</small>
          {group.items.slice(0, 30).map((item) => <article key={item.id}>
            <b title={item.path}>{item.name}</b>
            <span title={item.description ?? ""}>{item.description || item.path}</span>
            <small className={item.read_count > 0 ? "is-read"
              : item.loaded_count > 0 ? "is-loaded" : "is-idle"}>
              {item.read_count > 0 ? `读取 ${item.read_count} 次`
                : item.loaded_count > 0 ? "开局已加载" : "可用未读"}</small>
            <button type="button" disabled={busy || taskStatus !== "running"}
              title={taskStatus === "running" ? "送达当前 Agent"
                : "任务不在运行中，当前不能向 Agent 补充"}
              onClick={() => void remind(item)}>提醒 Agent 使用</button>
          </article>)}
        </div>)}
        {!catalog.length && <div className="knowledge-footprint-empty">
          本任务还没有可提醒的平台知识；下次发起时关联业务模块并确认技术画像即可。</div>}
      </div>
    </OverlayDialog>}

    <section className="knowledge-memories" aria-labelledby="knowledge-memories-title">
      <header>
        <div><strong id="knowledge-memories-title">这单记下的</strong>
          <small>闭环的检视意见、修好的构建失败、你圈选记下的，都会自动落在这里；只读，圈错了可撤回。</small></div>
        <span>{memories.filter((item) => !item.withdrawn && !item.superseded_by).length} 条</span>
      </header>
      {feedback && <p className="knowledge-workbench-feedback" role="status">{feedback}</p>}
      {memories.length ? <ol>
        {memories.filter((item) => !item.withdrawn).map((item) => {
          const gone = !!item.superseded_by;
          return <li key={item.id} className={`source-${item.source}${gone ? " is-gone" : ""}`}>
            <button type="button" className="knowledge-memory-row"
              aria-expanded={memoryOpen?.id === item.id}
              onClick={() => void openMemory(item)}>
              <i aria-hidden>{item.source === "user_note" ? "记"
                : item.source === "prepush_fix" ? "修" : "议"}</i>
              <span>
                <strong>{item.trigger}</strong>
                <em>{gone ? "已撤回" : item.conclusion}</em>
                <small>{item.source === "user_note" ? `${item.author ?? "有人"} 圈选记下`
                  : item.source === "prepush_fix" ? "Build-Fix 失败后修好"
                    : "检视意见闭环"}
                  {item.paths[0] ? ` · ${item.paths[0]}${item.line ? `:${item.line}` : ""}` : ""}
                  {` · ${time(item.at)}`}</small>
              </span>
            </button>
            {memoryOpen?.id === item.id && <pre className="knowledge-memory-source">{memoryOpen.content}</pre>}
            {item.source === "user_note" && !gone && <button type="button"
              className="knowledge-memory-withdraw" disabled={memoryBusy}
              onClick={() => void withdrawMemory(item)}>撤回</button>}
          </li>;
        })}
      </ol> : <div className="knowledge-footprint-empty">
        还没有记下任何东西。检视意见闭环、Build-Fix 修好失败，或在材料上圈选「记为记忆」后会出现在这里。</div>}
    </section>
    <section className="knowledge-memories knowledge-memories-used" aria-labelledby="knowledge-memory-usage-title">
      <header>
        <div><strong id="knowledge-memory-usage-title">这单用到的</strong>
          <small>宿主在开局、进入新阶段、首次改某目录时替 Agent 查过并推送的记忆，以及 Agent 自己查过、展开过的。</small></div>
        <span>{memoryUsage.length} 次</span>
      </header>
      {memoryUsage.length ? <ol>
        {memoryUsage.slice(-12).reverse().map((row, index) => <li key={`${row.ts}-${index}`} className={`moment-${row.moment}`}>
          <div className="knowledge-memory-row is-static">
            <i aria-hidden>{row.moment === "launch" ? "启" : row.moment === "phase" ? "阶"
              : row.moment === "edit" ? "改" : row.moment === "search" ? "查" : "展"}</i>
            <span>
              <strong>{row.moment === "launch" ? "开局推送"
                : row.moment === "phase" ? `进入「${row.phase ?? "新阶段"}」时推送`
                  : row.moment === "edit" ? `首次改 ${row.dir || "某目录"} 时提醒`
                    : row.moment === "search" ? `Agent 检索：${row.query ?? ""}`
                      : "Agent 展开记忆"}</strong>
              <em>{row.ids.length ? row.ids.join("、") : "没有命中"}</em>
              <small>{time(row.ts)}</small>
            </span>
          </div>
        </li>)}
      </ol> : <div className="knowledge-footprint-empty">
        还没有推送或检索。任务启动时会按仓推送历史记忆；Agent 也可以自己用 corpus_search 查。</div>}
    </section>
    {utMethod && <p className={`knowledge-ut-method${
      utMethod === "仓内既有写法" ? " is-fallback" : ""}`}>
      UT 生成方式:<strong>「{utMethod}」</strong>
      {utMethod === "仓内既有写法"
        ? "——本单未指向团队 UT Skill，Agent 不读 UT skill 属正确行为。"
        : "——写测试前 Agent 会先读取该 Skill 正文。"}</p>}
    {consumed.length ? <div className="knowledge-footprint-resources">
      {consumed.slice(0, 8).map((item) => <article key={item.id}
        className={`knowledge-resource kind-${item.kind}`}>
        <span>{item.scope === "module" ? "模块知识"
          : item.scope === "team" ? "团队通用知识"
            : item.repository ? "仓库原生" : KIND[item.kind]}</span>
        <strong title={item.name}>{item.name}</strong>
        <code title={item.path}>{item.path}</code>
        <small>{item.read_count > 0 ? `读取/检索 ${item.read_count} 次`
          : "开局已加载"}</small></article>)}</div>
      : <div className="knowledge-footprint-empty">
        尚无已消费知识；可用知识被加载、读取或检索后会在这里出现。</div>}
    {!!usage?.events.length && <details className="knowledge-footprint-events">
      <summary>查看消费明细<span>{usage.events.length} 条</span></summary>
      <div>{usage.events.slice(0, 24).map((event, index) =>
        <article key={`${event.ts}-${event.id}-${index}`}>
          <i className={`kind-${event.kind}`} aria-hidden />
          <time dateTime={event.ts}>{time(event.ts)}</time>
          <strong>{event.name}</strong><span>{ACTION[event.action]}</span>
          <small>{ROLE[event.session_role]}{event.step ? ` · ${event.step}` : ""}</small>
        </article>)}</div>
    </details>}
  </section>;
}
