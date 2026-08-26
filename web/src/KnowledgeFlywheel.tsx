import { useMemo, useState } from "react";
import type {
  HostSkillShelf,
  KnowledgeInsightResource,
  KnowledgeKind,
  TeamKnowledgeInsights,
} from "./api";

const KIND_LABEL: Record<KnowledgeKind, string> = {
  rules: "项目规则",
  document: "业务文档",
  skill: "Skill",
};

function repositoryName(value?: string): string {
  if (!value) return "未标注仓库";
  const clean = value.replace(/\/+$/, "");
  return clean.split("/").at(-1)?.replace(/\.git$/i, "") || value;
}

function latest(value?: string): string {
  if (!value) return "尚未主动访问";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `最近 ${date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  })}`;
}

function ResourceRow({ resource }: { resource: KnowledgeInsightResource }) {
  const reach = resource.provided_tasks > 0
    ? Math.round(resource.accessed_tasks / resource.provided_tasks * 100) : 0;
  return <article className={`knowledge-rank kind-${resource.kind}`}>
    <span className="knowledge-rank-kind">{KIND_LABEL[resource.kind]}</span>
    <div className="knowledge-rank-main">
      <strong title={resource.name}>{resource.name}</strong>
      <span title={`${resource.repository ?? ""} · ${resource.path}`}>
        {repositoryName(resource.repository)} · {resource.path}
      </span>
    </div>
    <div className="knowledge-rank-reach" title={`${resource.provided_tasks} 个任务可用，${resource.accessed_tasks} 个主动访问`}>
      <span><i style={{ width: `${reach}%` }} /></span>
      <small>{resource.accessed_tasks}/{resource.provided_tasks} 任务访问</small>
    </div>
    <div className="knowledge-rank-outcome">
      <strong>{resource.access_events}</strong><small>访问</small>
      <strong>{resource.completed_tasks}</strong><small>交付</small>
      <strong className={resource.repair_tasks ? "attention" : ""}>{resource.repair_tasks}</strong><small>修复</small>
    </div>
    <time dateTime={resource.last_used_at}>{latest(resource.last_used_at)}</time>
  </article>;
}

/** 货架与足迹互补:足迹只看得见被任务带过的资源,放坏了的 skill 在
 * 足迹里隐形,货架把"现在生效的是什么"照出来——包括不可装载的。 */
function HostSkillShelfPanel({ shelf }: { shelf: HostSkillShelf }) {
  return <div className="knowledge-shelf" aria-label="团队 Skill 货架">
    <div className="knowledge-panel-head">
      <div><strong>团队 Skill 货架</strong><small>部署数据目录 skills/ 里当前生效的资产;每个新任务自动装载。</small></div>
      <span>{shelf.skills.length} 项</span>
    </div>
    {!shelf.root_exists && <div className="knowledge-shelf-empty">本部署尚未放置团队 Skill(数据目录下无 skills/)。放入后新任务即自动装载,无需重启。</div>}
    {shelf.root_exists && shelf.skills.length === 0 && <div className="knowledge-shelf-empty">skills/ 目录是空的——放入含 SKILL.md 的技能包后,新任务即自动装载。</div>}
    {shelf.skills.map((skill) => <article className={`knowledge-shelf-row${skill.loadable ? "" : " broken"}`} key={skill.path}>
      <div className="knowledge-shelf-main">
        <strong>{skill.name}</strong>
        {!skill.loadable && <span className="knowledge-shelf-badge" title="pi 装载器未接受,任何会话都不会带上它;检查 SKILL.md frontmatter 的 name/description">不可装载</span>}
        <p>{skill.description || "(没有描述——模型靠描述判断何时读取,建议补上)"}</p>
      </div>
      <div className="knowledge-shelf-meta">
        <span title={`SKILL.md 内容 sha256:${skill.digest}`}>版本 {skill.digest.slice(0, 8)}</span>
        <span>{skill.path}</span>
        <time dateTime={skill.updated_at}>{latest(skill.updated_at).replace("最近 ", "更新 ")}</time>
      </div>
    </article>)}
    {shelf.warnings.length > 0 && <div className="knowledge-shelf-warnings" role="note">
      {shelf.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
    </div>}
  </div>;
}

export function KnowledgeFlywheel({
  insights,
  loading,
  error,
  onRetry,
  onOpenTask,
}: {
  insights?: TeamKnowledgeInsights;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [kind, setKind] = useState<"all" | KnowledgeKind>("all");
  const [repository, setRepository] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const repositories = useMemo(() => [...new Set(
    (insights?.resources ?? []).map((item) => item.repository)
      .filter((item): item is string => !!item),
  )].sort(), [insights]);
  const filtered = useMemo(() => (insights?.resources ?? []).filter((item) =>
    (kind === "all" || item.kind === kind)
      && (repository === "all" || item.repository === repository)),
  [insights, kind, repository]);
  const visible = showAll ? filtered : filtered.slice(0, 6);

  return <section className="knowledge-flywheel" aria-labelledby="knowledge-flywheel-title">
    <header className="knowledge-flywheel-head">
      <div className="knowledge-flywheel-title">
        <span className="knowledge-flywheel-icon" aria-hidden>知</span>
        <div><span className="section-kicker">KNOWLEDGE FLYWHEEL</span><h2 id="knowledge-flywheel-title">团队知识效能</h2><p>从“提供”到“主动访问”再到交付结果，发现值得沉淀和需要补齐的业务知识。</p></div>
      </div>
      <div className="knowledge-flywheel-refresh">
        {insights && <small>更新于 {latest(insights.generated_at).replace("最近 ", "")}</small>}
        {error && insights && <small className="knowledge-flywheel-stale" title={error}>刷新失败，展示上次结果</small>}
        <button type="button" onClick={onRetry} disabled={loading} aria-label="刷新知识效能">
          <svg viewBox="0 0 18 18" aria-hidden><path d="M14.5 6.5A5.75 5.75 0 1 0 15 11M14.5 3v3.5H11" /></svg>
          {loading ? "统计中" : "刷新"}
        </button>
      </div>
    </header>

    {error && !insights && <div className="knowledge-flywheel-error" role="alert"><strong>知识效能暂时不可用</strong><span>{error}</span><button type="button" onClick={onRetry}>重新读取</button></div>}
    {loading && !insights && <div className="knowledge-flywheel-loading" aria-label="正在统计知识效能"><i /><i /><i /></div>}
    {insights && insights.summary.tracked_tasks === 0 && <div className="knowledge-flywheel-empty"><span aria-hidden>◎</span><div><strong>知识飞轮正在等待第一批数据</strong><p>新任务开始选择或读取业务知识后，这里会自动出现使用趋势和改进建议；旧任务不会被猜测补数。</p></div></div>}

    {insights?.host_skills && <HostSkillShelfPanel shelf={insights.host_skills} />}

    {insights && insights.summary.tracked_tasks > 0 && <>
      <div className="knowledge-flywheel-metrics" aria-label="知识效能摘要">
        <div><span>已追踪任务</span><strong>{insights.summary.tracked_tasks}</strong><small>采用新知识口径</small></div>
        <div><span>主动访问率</span><strong>{insights.summary.access_rate}<em>%</em></strong><small>{insights.summary.accessed_tasks} 个任务真正读取</small></div>
        <div><span>活跃知识</span><strong>{insights.summary.active_resources}</strong><small>共识别 {insights.summary.unique_resources} 项</small></div>
        <div className={insights.summary.opportunities ? "attention" : "positive"}><span>改进机会</span><strong>{insights.summary.opportunities}</strong><small>{insights.summary.selected_unused} 项选而未用</small></div>
      </div>

      <div className="knowledge-flywheel-body">
        <div className="knowledge-ranking">
          <div className="knowledge-panel-head"><div><strong>知识使用排行</strong><small>访问表示 Agent 主动读取或检索，不把“被提供”冒充“已使用”。</small></div><span>{filtered.length} 项</span></div>
          <div className="knowledge-filterbar">
            <div role="group" aria-label="按知识类型筛选">
              {(["all", "rules", "document", "skill"] as const).map((value) => <button type="button" key={value} className={kind === value ? "on" : ""} aria-pressed={kind === value} onClick={() => { setKind(value); setShowAll(false); }}>{value === "all" ? "全部" : KIND_LABEL[value]}</button>)}
            </div>
            {repositories.length > 1 && <select aria-label="按仓库筛选知识" value={repository} onChange={(event) => { setRepository(event.target.value); setShowAll(false); }}><option value="all">全部仓库</option>{repositories.map((item) => <option value={item} key={item}>{repositoryName(item)}</option>)}</select>}
          </div>
          <div className="knowledge-ranking-list">
            {visible.map((item) => <ResourceRow key={item.key} resource={item} />)}
            {filtered.length === 0 && <div className="knowledge-ranking-empty">当前筛选下还没有知识使用记录。</div>}
          </div>
          {filtered.length > 6 && <button type="button" className="knowledge-show-all" onClick={() => setShowAll((current) => !current)}>{showAll ? "收起" : `查看全部 ${filtered.length} 项`}</button>}
        </div>

        <aside className="knowledge-opportunities">
          <div className="knowledge-panel-head"><div><strong>下一步怎么改</strong><small>建议只辅助知识运营，不会自动改仓库或卡住任务。</small></div><span>{insights.recommendations.length} 条</span></div>
          <div className="knowledge-opportunity-list">
            {insights.recommendations.map((item) => <article className={`tone-${item.tone}`} key={item.id}>
              <i aria-hidden>{item.tone === "positive" ? "✓" : item.tone === "attention" ? "!" : "i"}</i>
              <div><strong>{item.title}</strong><p>{item.evidence}</p><small>{item.action}</small>{!!item.task_ids?.length && <div className="knowledge-task-links"><span>相关任务</span>{item.task_ids.map((taskId) => <button type="button" key={taskId} onClick={() => onOpenTask(taskId)}>{taskId}</button>)}</div>}</div>
            </article>)}
            {insights.recommendations.length === 0 && <div className="knowledge-opportunity-empty"><span aria-hidden>✓</span><div><strong>暂时没有足够样本形成建议</strong><small>继续积累真实任务，不用为了填满面板制造结论。</small></div></div>}
          </div>
        </aside>
      </div>
      <footer className="knowledge-flywheel-note"><span>口径</span>“提供、加载、主动访问”分开统计；交付与修复只做相关性参考，不代表某份知识直接导致成功或失败。</footer>
    </>}
  </section>;
}
