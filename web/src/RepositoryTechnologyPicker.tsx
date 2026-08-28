import { useEffect, useState } from "react";
import {
  resolveRepositoryProfiles,
  type RepositoryProfile,
} from "./api";
import { KnowledgeLanguagePicker, KnowledgeLanguageTags } from "./KnowledgeLanguages";

export interface RepositoryTechnologyDraft {
  repository: string;
  technologies: string[];
  confirmed: boolean;
  remembered?: boolean;
}

function label(repository: string): string {
  return repository.replace(/\/+$/, "").split("/").at(-1)
    ?.replace(/\.git$/i, "") || repository;
}

export function RepositoryTechnologyPicker({ repositories, value, onChange }: {
  repositories: string[];
  value: RepositoryTechnologyDraft[];
  onChange: (value: RepositoryTechnologyDraft[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const normalized = repositories.map((item) => item.trim()).filter(Boolean);

  useEffect(() => {
    if (!normalized.length) { onChange([]); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      void resolveRepositoryProfiles(normalized).then((items) => {
        if (!alive) return;
        onChange(items.map((item) => ({
          repository: item.repository,
          technologies: item.profile?.technologies ?? [],
          confirmed: item.profile?.confirmed === true,
          remembered: !!item.profile,
        })));
      }).catch((reason) => {
        if (!alive) return;
        // 画像是推荐旁路，读不到不能卡下单；界面明确说明退化结果。
        setError(reason instanceof Error ? reason.message : "仓库技术画像读取失败");
        onChange(normalized.map((repository) => ({
          repository, technologies: [], confirmed: false,
        })));
      }).finally(() => { if (alive) setLoading(false); });
    }, 350);
    return () => { alive = false; window.clearTimeout(timer); };
    // 仓库列表变化才重新解析；value 由用户编辑，不能触发回填覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(normalized)]);

  if (!normalized.length) return null;
  const update = (repository: string, patch: Partial<RepositoryTechnologyDraft>) =>
    onChange(value.map((item) => item.repository === repository
      ? { ...item, ...patch } : item));
  return <div className="repository-technology-picker">
    <div className="repository-technology-head">
      <span><strong>仓库技术栈</strong><small>
        第一次由你选择，系统记住；以后用来匹配工程知识，不做代码猜测。</small></span>
      <em>{loading ? "读取中…" : value.every((item) => item.confirmed)
        ? "已确认" : "有首次选择"}</em>
    </div>
    {error && <p className="repository-technology-warning" role="status">
      {error}。不影响发起任务，本单将只按仓库范围匹配知识。</p>}
    <div className="repository-technology-list">
      {value.map((item) => <article key={item.repository}>
        <header><span><strong>{label(item.repository)}</strong>
          <small title={item.repository}>{item.repository}</small></span>
          {item.remembered && <em>系统已记住 · 可修改</em>}
          {!item.remembered && <em className="first">首次使用</em>}
        </header>
        {item.confirmed ? <>
          <KnowledgeLanguagePicker value={item.technologies}
            includeAgnostic={false}
            onChange={(technologies) => update(item.repository, {
              technologies, confirmed: true, remembered: false,
            })} />
          <div className="repository-technology-state">
            <KnowledgeLanguageTags languages={item.technologies}
              empty="已确认：暂不确定 / 技术无关" />
            <button type="button" onClick={() => update(item.repository,
              { confirmed: false, technologies: [] })}>重新选择</button>
          </div>
        </> : <div className="repository-technology-first">
          <KnowledgeLanguagePicker value={item.technologies}
            includeAgnostic={false}
            onChange={(technologies) => update(item.repository,
              { technologies })} />
          <div><button type="button" className="primary"
            disabled={!item.technologies.length}
            onClick={() => update(item.repository, { confirmed: true })}>
            确认并记住</button>
            <button type="button" onClick={() => update(item.repository,
              { confirmed: true, technologies: [] })}>
              暂不确定，也继续</button></div>
        </div>}
      </article>)}
    </div>
    <p className="repository-technology-note">
      这项选择不构成流程门禁。未确认或暂不确定时，业务模块知识和仓内知识仍正常使用，只减少按技术栈自动匹配的工程知识。</p>
  </div>;
}

export function asRepositoryProfiles(
  drafts: RepositoryTechnologyDraft[],
): Array<Pick<RepositoryProfile, "repository" | "technologies" | "confirmed">> {
  return drafts.filter((item) => item.confirmed).map((item) => ({
    repository: item.repository,
    technologies: item.technologies,
    confirmed: true,
  }));
}
