import { useState } from "react";
import { OverlayDialog } from "./WarmupPanel";
import {
  createKnowledgeCandidate,
  interruptTask,
  type KnowledgeAction,
  type KnowledgeForm,
  type TaskKnowledgeUsage,
} from "./api";
import { KnowledgeLanguagePicker } from "./KnowledgeLanguages";

const KIND = { rules: "规则", document: "文档", skill: "Skill" } as const;
const ACTION: Record<KnowledgeAction, string> = {
  available: "进入能力目录", loaded: "已加载到上下文",
  read: "读取正文", searched: "检索定位",
};
const ROLE = { main: "主 Agent", subagent: "子 Agent", prepush: "推送前编译",
  warmup: "预热编译", "developer-assistant": "开发助手" } as const;

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hour12: false,
  });
}

function shortRepository(value: string): string {
  return value.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/i, "")
    || value;
}

export function KnowledgeFootprint({ usage, utMethod, taskId, taskStatus,
  repositories = [], repositoryTechnologies = [], businessModules = [] }: {
  usage?: TaskKnowledgeUsage;
  utMethod?: string;
  taskId: string;
  taskStatus: string;
  repositories?: string[];
  repositoryTechnologies?: string[];
  businessModules?: Array<{ id: string; name: string }>;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    nature: "engineering" as "business" | "engineering",
    form: "document" as KnowledgeForm,
    title: "", summary: "", when_to_use: "", content: "",
    business_module_ids: [] as string[], repositories: [...repositories],
    technologies: [...repositoryTechnologies],
  });
  const consumed = usage?.resources.filter((item) =>
    item.loaded_count > 0 || item.read_count > 0) ?? [];
  const resources = usage?.resources ?? [];
  const catalog = [
    { title: "业务模块知识", note: "由模块 Owner 治理；按任务固定版本",
      items: resources.filter((item) => item.scope === "module") },
    { title: "团队工程知识与 Skill", note: "按仓库、技术栈和模块上下文匹配",
      items: resources.filter((item) => item.scope === "team") },
    { title: "代码仓 Skill", note: "扫描后默认勾选；正文由 Agent 按需读取",
      items: resources.filter((item) => !!item.repository && item.kind === "skill") },
    { title: "项目规则", note: "代码仓内自动发现",
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

  async function submitCandidate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFeedback("");
    try {
      const candidate = await createKnowledgeCandidate(taskId, {
        ...draft,
        technologies: draft.nature === "engineering" ? draft.technologies : [],
      });
      setFeedback(`已提交知识候选 ${candidate.id}，等待${draft.nature === "business"
        ? "模块维护者" : "管理员"}审核；不会阻塞本任务。`);
      setDraft((current) => ({ ...current, title: "", summary: "",
        when_to_use: "", content: "" }));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "知识候选提交失败");
    } finally { setBusy(false); }
  }

  return <section className="knowledge-footprint"
    aria-labelledby="knowledge-footprint-title">
    <header>
      <div className="knowledge-footprint-mark" aria-hidden>知</div>
      <div><span>TASK KNOWLEDGE</span><strong id="knowledge-footprint-title">
        本任务知识</strong>
        <p>看见本任务可用与实际消费的知识，也可中途补充或沉淀；知识旁路不参与流程门禁。</p></div>
      <div className="knowledge-footprint-stats" aria-label="知识消费摘要">
        <span><strong>{usage?.summary.used ?? 0}</strong><small>已消费</small></span>
        <span><strong>{resources.length}</strong><small>本任务可用</small></span>
        <button type="button" className="knowledge-catalog-badge"
          onClick={() => setCatalogOpen(true)}>补充已有知识</button>
        <button type="button" className="knowledge-catalog-badge capture"
          onClick={() => { setCaptureOpen(true); setFeedback(""); }}>
          沉淀新知识</button>
      </div>
    </header>

    {catalogOpen && <OverlayDialog ariaLabel="本任务可用知识"
      title="本任务可用知识" onClose={() => setCatalogOpen(false)}>
      <p className="knowledge-catalog-note">
        三类来源分开呈现。可用≠已读；点“提醒 Agent 使用”会真实送达，送不了会明确报错，不会假装生效。
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
          本任务还没有可补充的已有知识；可直接沉淀新知识，或在下次发起时关联业务模块、技术画像与仓内 Skill。</div>}
      </div>
    </OverlayDialog>}

    {captureOpen && <OverlayDialog ariaLabel="沉淀新知识"
      title="从本任务沉淀知识" onClose={() => setCaptureOpen(false)}>
      <form className="knowledge-candidate-form" onSubmit={submitCandidate}>
        <p>先判断正文性质，再选择呈现形态。提交后进入待审；审核发布成功才会推荐给后续任务，不会自动污染团队知识库。</p>
        <div className="skill-kind-picker two">
          <button type="button" aria-pressed={draft.nature === "business"}
            onClick={() => setDraft({ ...draft, nature: "business",
              business_module_ids: draft.business_module_ids.slice(0, 1),
              technologies: [] })}><strong>业务知识</strong>
            <small>领域概念、规则、流程与业务边界</small></button>
          <button type="button" aria-pressed={draft.nature === "engineering"}
            onClick={() => setDraft({ ...draft, nature: "engineering" })}>
            <strong>工程知识</strong><small>编码、构建、测试与排障方法</small></button>
        </div>
        <label><span>呈现形态</span><select value={draft.form}
          onChange={(event) => setDraft({ ...draft,
            form: event.target.value as KnowledgeForm })}>
          <option value="document">文档</option><option value="skill">Skill</option>
          <option value="rule">规则</option><option value="example">示例</option>
        </select></label>
        <div className="business-module-form-grid">
          <label><span>标题</span><input required value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label><span>什么时候应该使用</span><input required
            value={draft.when_to_use} onChange={(event) => setDraft({
              ...draft, when_to_use: event.target.value })} /></label>
        </div>
        <label><span>一句话摘要</span><textarea required rows={2}
          value={draft.summary} onChange={(event) => setDraft({
            ...draft, summary: event.target.value })} /></label>
        <div className="knowledge-candidate-scope">
          <span><strong>{draft.nature === "business" ? "归属业务模块（必选）"
            : "业务模块上下文（可选）"}</strong></span>
          <div className="skill-module-picker">{businessModules.map((module) =>
            <button type="button" key={module.id}
              aria-pressed={draft.business_module_ids.includes(module.id)}
              onClick={() => setDraft({ ...draft, business_module_ids:
                draft.nature === "business" ? [module.id]
                : draft.business_module_ids.includes(module.id)
                  ? draft.business_module_ids.filter((id) => id !== module.id)
                  : [...draft.business_module_ids, module.id] })}>
              {module.name}</button>)}</div>
        </div>
        {!!repositories.length && <div className="knowledge-candidate-scope">
          <span><strong>适用仓库（可多选）</strong><small>不选表示不限仓库</small></span>
          <div className="skill-module-picker">{repositories.map((repository) =>
            <button type="button" key={repository}
              aria-pressed={draft.repositories.includes(repository)}
              onClick={() => setDraft({ ...draft, repositories:
                draft.repositories.includes(repository)
                  ? draft.repositories.filter((item) => item !== repository)
                  : [...draft.repositories, repository] })}>
              {shortRepository(repository)}</button>)}</div>
        </div>}
        {draft.nature === "engineering" && <div className="knowledge-candidate-scope">
          <span><strong>适用技术栈（可选）</strong><small>不选表示技术无关</small></span>
          <KnowledgeLanguagePicker value={draft.technologies}
            includeAgnostic={false}
            onChange={(technologies) => setDraft({ ...draft, technologies })} />
        </div>}
        <label><span>知识正文（Markdown）</span><textarea required rows={12}
          value={draft.content} onChange={(event) => setDraft({
            ...draft, content: event.target.value })} /></label>
        {feedback && <p className="knowledge-workbench-feedback" role="status">
          {feedback}</p>}
        <div className="business-module-form-actions">
          <span>模糊内容请在正文中标明边界，审核人会明确接纳或驳回原因。</span>
          <button className="primary" type="submit" disabled={busy
            || (draft.nature === "business" && !draft.business_module_ids.length)}>
            {busy ? "提交中…" : "提交待审"}</button>
        </div>
      </form>
    </OverlayDialog>}

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
          : item.scope === "team" ? "团队工程知识" : KIND[item.kind]}</span>
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
