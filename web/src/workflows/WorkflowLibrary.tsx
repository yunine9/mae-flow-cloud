import type { WorkflowAssetSummary } from "../api";
import { statusLabels } from "./model";

export function WorkflowLibrary({
  workflows,
  loading = false,
  error,
  warnings = [],
  selectedId,
  onSelect,
  onCreate,
  onCopy,
  onRefresh,
}: {
  workflows: WorkflowAssetSummary[];
  loading?: boolean;
  error?: string;
  warnings?: string[];
  selectedId?: string;
  onSelect: (workflow: WorkflowAssetSummary) => void;
  onCreate?: () => void;
  onCopy?: (workflow: WorkflowAssetSummary) => void;
  onRefresh?: () => void;
}) {
  return <section className="wf-library" aria-labelledby="wf-library-title">
    <header className="wf-library-head">
      <div><span className="wf-kicker">WORKFLOW ASSETS</span>
        <h2 id="wf-library-title">工作流方案</h2>
        <p>保存、复制和发布精确的阶段编排。平台标准方案始终兜底，普通任务无需配置。</p>
      </div>
      <div>{onRefresh && <button type="button" disabled={loading} onClick={onRefresh}>
        {loading ? "读取中…" : "刷新"}</button>}
        {onCreate && <button type="button" className="wf-primary" onClick={onCreate}>
          新建工作流</button>}</div>
    </header>
    {error && <div className="wf-state-banner error" role="alert">
      <strong>工作流资产读取失败</strong><span>{error}</span>
      {onRefresh && <button type="button" onClick={onRefresh}>重试</button>}
    </div>}
    {warnings.map((warning, index) => <div className="wf-state-banner warning"
      key={`${warning}-${index}`}><strong>部分资产暂不可见</strong><span>{warning}</span></div>)}
    {loading && !workflows.length ? <div className="wf-library-skeleton" aria-label="正在读取工作流">
      <i /><i /><i />
    </div> : workflows.length ? <div className="wf-library-grid">
      {workflows.map((workflow) => <article key={workflow.id}
        className={selectedId === workflow.id ? "selected" : ""}>
        <button className="wf-workflow-main" type="button" onClick={() => onSelect(workflow)}>
          <span className="wf-workflow-title"><strong>{workflow.name}</strong>
            <em className={`status-${workflow.status}`}>{statusLabels[workflow.status]}</em></span>
          <p>{workflow.description || "暂无说明。打开后可查看各阶段的精确编排。"}</p>
          <span className="wf-workflow-meta">
            <b>{workflow.scope === "team" ? "团队资产" : "个人资产"}</b>
            <b>v{workflow.latest_version || "—"}</b><b>草稿 r{workflow.draft_revision}</b>
            <b>{formatTime(workflow.updated_at)}</b>
          </span>
          <span className="wf-workflow-owner">Owner · {workflow.owner}</span>
        </button>
        <footer>
          <span>{workflow.selectable_for_tasks ? "可供新任务选择" : statusHint(workflow)}</span>
          <div>{onCopy && <button type="button" onClick={() => onCopy(workflow)}>复制</button>}
            <button type="button" onClick={() => onSelect(workflow)}>查看</button></div>
        </footer>
      </article>)}
    </div> : !loading && !error && <div className="wf-empty large">
      <strong>团队还没有可复用的工作流</strong>
      <span>普通任务继续使用平台标准方案；有清晰编排思路时，再创建专业定制。</span>
      {onCreate && <button type="button" className="wf-primary" onClick={onCreate}>
        创建第一个工作流</button>}
    </div>}
  </section>;
}

function statusHint(workflow: WorkflowAssetSummary): string {
  if (workflow.status === "archived") return "已归档，仅保留历史任务";
  if (workflow.status === "pending_review") return "审核通过后可供新任务选择";
  if (workflow.status === "draft") return "发布后可供新任务选择";
  return "当前版本不可用于新任务";
}

function formatTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? value : time.toLocaleDateString("zh-CN", {
    month: "short", day: "numeric", year: "numeric",
  });
}
