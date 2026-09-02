/**
 * 团队知识使用效能(只读)。
 *
 * 2026-09-01 拆分:资产管理(上架/审核/沉淀候选)搬去 KnowledgeAssets,
 * 这里只剩"看数"。原因是两件事的心智完全不同——一边要动手裁决,一边
 * 是只读观察,挤在一根竖轴上谁都看不清,而且管理区一展开就把统计顶到
 * 屏外。现在它们是团队资产下的两个同级页签。
 */

import { useMemo, useState } from "react";
import type {
  KnowledgeInsightResource,
  KnowledgeKind,
  TeamKnowledgeInsights,
} from "./api";

const KIND_LABEL: Record<KnowledgeKind, string> = {
  rules: "项目规则",
  document: "模块知识",
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

const MIN_SAMPLE_TASKS = 3;

function ResourceRow({ resource }: { resource: KnowledgeInsightResource }) {
  const reach = resource.provided_tasks > 0
    ? Math.round(resource.accessed_tasks / resource.provided_tasks * 100) : 0;
  const thin = resource.provided_tasks < MIN_SAMPLE_TASKS;
  return <article className={`knowledge-rank kind-${resource.kind}`}>
    <span className="knowledge-rank-kind">{KIND_LABEL[resource.kind]}</span>
    <div className="knowledge-rank-main">
      <strong title={resource.path}>{resource.name}
        {thin && <em className="knowledge-rank-thin" title={`只在 ${resource.provided_tasks} 个任务里出现过,消费率还说明不了问题`}>样本不足</em>}
      </strong>
      <span title={`${resource.repository ?? "团队级"} · ${resource.path}`}>
        {resource.description || resource.path}
      </span>
    </div>
    <div className="knowledge-rank-reach" title={`${resource.provided_tasks} 个任务可用，${resource.accessed_tasks} 个主动访问`}>
      <span><i style={{ width: `${reach}%` }} /></span>
      <small>{resource.accessed_tasks}/{resource.provided_tasks} 任务访问（{reach}%）</small>
    </div>
    <div className="knowledge-rank-outcome">
      <strong>{resource.access_events}</strong><small>访问</small>
      <strong>{resource.completed_tasks}</strong><small>交付</small>
      <strong className={resource.repair_tasks ? "attention" : ""}>{resource.repair_tasks}</strong><small>修复</small>
    </div>
    <time dateTime={resource.last_used_at}>{latest(resource.last_used_at)}</time>
  </article>;
}

/** 一个分组一个榜:仓库级资源只在本仓任务里被消费,跨仓比绝对量
 * 比的是流量不是价值(用户 2026-08-26 点名),所以按仓分组、组内按
 * 消费率排,样本不足的沉底标注。 */
function ResourceGroup({ title, note, items }: {
  title: string;
  note?: string;
  items: KnowledgeInsightResource[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 5);
  return <div className="knowledge-rank-group">
    <div className="knowledge-rank-group-head">
      <strong>{title}</strong>
      {note && <small>{note}</small>}
      <span>{items.length} 项</span>
    </div>
    {visible.map((item) => <ResourceRow key={item.key} resource={item} />)}
    {items.length > 5 && <button type="button" className="knowledge-show-all"
      onClick={() => setShowAll((current) => !current)}>
      {showAll ? "收起" : `展开全部 ${items.length} 项`}</button>}
  </div>;
}

export function KnowledgeInsightsBoard({
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
  const [kind, setKind] = useState<"all" | "document" | "skill">("all");
  // 分组代替跨仓混排:团队级(跨仓资产)一组在前,其余按仓一组一个榜。
  // 组内排序:消费率(读取/装载)优先,样本不足(<3 单)沉底;绝对量只做
  // 次级键——谁的仓单多谁霸榜的老毛病由此消除。
  const groups = useMemo(() => {
    const filtered = (insights?.resources ?? [])
      .filter((item) => kind === "all" || item.kind === kind);
    const byRepo = new Map<string, KnowledgeInsightResource[]>();
    for (const item of filtered) {
      const key = item.scope === "module"
        ? `module:${item.module_id ?? item.module_name ?? "unknown"}`
        : item.repository ?? "";
      const list = byRepo.get(key) ?? [];
      list.push(item);
      byRepo.set(key, list);
    }
    const rate = (item: KnowledgeInsightResource) => item.provided_tasks > 0
      ? item.accessed_tasks / item.provided_tasks : 0;
    const sortGroup = (list: KnowledgeInsightResource[]) => [...list]
      .sort((left, right) => {
        const leftThin = left.provided_tasks < MIN_SAMPLE_TASKS;
        const rightThin = right.provided_tasks < MIN_SAMPLE_TASKS;
        if (leftThin !== rightThin) return leftThin ? 1 : -1;
        return rate(right) - rate(left)
          || right.accessed_tasks - left.accessed_tasks
          || left.name.localeCompare(right.name);
      });
    return [...byRepo.entries()]
      .map(([repo, list]) => ({
        repo,
        items: sortGroup(list),
        activity: list.reduce((sum, item) => sum + item.accessed_tasks, 0),
      }))
      .sort((left, right) => (left.repo === "" ? -1 : right.repo === "" ? 1
        : left.repo.startsWith("module:") && !right.repo.startsWith("module:") ? -1
        : right.repo.startsWith("module:") && !left.repo.startsWith("module:") ? 1
        : right.activity - left.activity
          || left.repo.localeCompare(right.repo)));
  }, [insights, kind]);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  return <section className="knowledge-flywheel" aria-labelledby="knowledge-flywheel-title">
    <header className="knowledge-flywheel-head">
      <div className="knowledge-flywheel-title">
        <span className="knowledge-flywheel-icon" aria-hidden>效</span>
        <div><span className="section-kicker">KNOWLEDGE FLYWHEEL</span><h2 id="knowledge-flywheel-title">团队知识效能</h2><p>只观察经过沉淀、能跨任务复用的团队资产；任务需求文档留在各自现场。</p></div>
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
    {insights && insights.summary.tracked_tasks === 0 && <div className="knowledge-flywheel-empty"><span aria-hidden>◎</span><div><strong>知识飞轮正在等待第一批数据</strong><p>正式模块知识或 Skill 被新任务装载、读取后，这里会出现使用趋势；任务文档和仓库项目规则不会进入团队统计。</p></div></div>}

    {insights && insights.summary.tracked_tasks > 0 && <>
      <div className="knowledge-flywheel-metrics" aria-label="知识效能摘要">
        <div><span>已追踪任务</span><strong>{insights.summary.tracked_tasks}</strong><small>采用新知识口径</small></div>
        <div><span>主动访问率</span><strong>{insights.summary.access_rate}<em>%</em></strong><small>{insights.summary.accessed_tasks} 个任务真正读取</small></div>
        <div><span>活跃资产</span><strong>{insights.summary.active_resources}</strong><small>共识别 {insights.summary.unique_resources} 项</small></div>
        <div className={insights.summary.opportunities ? "attention" : "positive"}><span>改进机会</span><strong>{insights.summary.opportunities}</strong><small>{insights.summary.selected_unused} 项选而未用</small></div>
      </div>

      <div className="knowledge-flywheel-body">
        <div className="knowledge-ranking">
          <div className="knowledge-panel-head"><div><strong>可复用资产使用</strong><small>这里只统计正式模块知识与 Skill 的真实消费；仓库项目规则和任务文档仍留在各自现场。</small></div><span>{total} 项</span></div>
          <div className="knowledge-filterbar">
            <div role="group" aria-label="按知识类型筛选">
              {(["all", "document", "skill"] as const).map((value) => <button type="button" key={value} className={kind === value ? "on" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "all" ? "全部" : KIND_LABEL[value]}</button>)}
            </div>
          </div>
          <div className="knowledge-ranking-list">
            {groups.map((group) => <ResourceGroup
              key={group.repo || "__team__"}
              title={group.repo.startsWith("module:")
                ? `业务模块 · ${group.items[0]?.module_name ?? group.repo.slice(7)}`
                : group.repo ? repositoryName(group.repo) : "团队级资产（跨仓）"}
              note={group.repo.startsWith("module:")
                ? "Owner 显式发布的模块知识，按任务真实读取统计"
                : group.repo ? "组内按消费率排,受本仓单量影响,不跨仓比较" : undefined}
              items={group.items} />)}
            {total === 0 && <div className="knowledge-ranking-empty">当前筛选下还没有知识使用记录。</div>}
          </div>
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
      <footer className="knowledge-flywheel-note"><span>口径</span>任务需求、附件与过程文档只留在单任务现场，项目规则只属于相关仓库；团队页只统计正式模块知识和 Skill，交付结果仅作相关性参考。</footer>
    </>}
  </section>;
}
