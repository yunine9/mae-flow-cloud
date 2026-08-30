import { useEffect, useRef, useState } from "react";
import {
  resolveRepositoryProfiles,
  saveRepositoryProfile,
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

function identity(repository: string): string {
  return repository.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
    .toLowerCase();
}

export function RepositoryTechnologyPicker({ repositories, value, onChange }: {
  repositories: string[];
  value: RepositoryTechnologyDraft[];
  onChange: (value: RepositoryTechnologyDraft[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [savingRepository, setSavingRepository] = useState("");
  const [error, setError] = useState("");
  const normalized = repositories.map((item) => item.trim()).filter(Boolean);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!normalized.length) { onChange([]); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      void resolveRepositoryProfiles(normalized).then((items) => {
        if (!alive) return;
        const local = new Map(valueRef.current.map((item) =>
          [identity(item.repository), item]));
        const resolved = new Map(items.map((item) =>
          [identity(item.repository), item]));
        onChange(normalized.map((repository) => {
          const current = local.get(identity(repository));
          const item = resolved.get(identity(repository));
          // 草稿代表“本单已经采用”的选择，优先级高于团队画像回填。
          // 特别是 remembered=false（保存失败）不能在重挂载后被抹掉。
          if (current) return {
            ...current,
            repository: item?.repository ?? repository,
            technologies: [...current.technologies],
          };
          return {
            repository: item?.repository ?? repository,
            technologies: item?.profile?.technologies ?? [],
            confirmed: item?.profile?.confirmed === true,
            remembered: !!item?.profile,
          };
        }));
      }).catch((reason) => {
        if (!alive) return;
        // 画像是推荐旁路，读不到不能卡下单；界面明确说明退化结果。
        setError(reason instanceof Error ? reason.message : "仓库技术画像读取失败");
        const local = new Map(valueRef.current.map((item) =>
          [identity(item.repository), item]));
        onChange(normalized.map((repository) => {
          const current = local.get(identity(repository));
          return current ? { ...current, repository,
            technologies: [...current.technologies] }
            : { repository, technologies: [], confirmed: false };
        }));
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
  const remember = async (
    item: RepositoryTechnologyDraft,
    technologies: string[],
  ) => {
    setSavingRepository(item.repository);
    setError("");
    try {
      const saved = await saveRepositoryProfile({
        repository: item.repository,
        technologies,
        confirmed: true,
      });
      update(item.repository, {
        technologies: saved.technologies,
        confirmed: true,
        remembered: true,
      });
    } catch (reason) {
      // 画像是推荐旁路：记忆失败不能卡本任务。当前选择仍进入本任务的
      // 资源匹配和任务快照，只明确告诉用户下次可能需要重新确认。
      update(item.repository, {
        technologies,
        confirmed: true,
        remembered: false,
      });
      setError(`${reason instanceof Error ? reason.message : "仓库技术画像保存失败"}；本任务已采用当前选择，但系统没有记住，下次可能需要重新确认`);
    } finally {
      setSavingRepository("");
    }
  };
  return <div className="repository-technology-picker">
    <div className="repository-technology-head">
      <span><strong>仓库技术栈</strong><small>
        第一次由你选择，系统记住；以后用来匹配工程知识，不做代码猜测。</small></span>
      <em>{loading ? "读取中…" : value.every((item) => item.confirmed)
        ? "已确认" : "有首次选择"}</em>
    </div>
    {error && <p className="repository-technology-warning" role="status">
      {error}。请核对上方当前选择状态；本单已确认的选择仍会保留。</p>}
    <div className="repository-technology-list">
      {value.map((item) => <article key={item.repository}>
        <header><span><strong>{label(item.repository)}</strong>
          <small title={item.repository}>{item.repository}</small></span>
          {item.remembered && <em>系统已记住 · 可修改</em>}
          {!item.remembered && <em className="first">首次使用</em>}
        </header>
        {item.confirmed ? <>
          <div className="repository-technology-state">
            <KnowledgeLanguageTags languages={item.technologies}
              empty="已确认：暂不确定 / 技术无关" />
            <button type="button" onClick={() => update(item.repository,
              { confirmed: false })}>重新选择</button>
          </div>
        </> : <div className="repository-technology-first">
          <KnowledgeLanguagePicker value={item.technologies}
            includeAgnostic={false}
            onChange={(technologies) => update(item.repository,
              { technologies })} />
          <div><button type="button" className="primary"
            disabled={!item.technologies.length || !!savingRepository}
            onClick={() => void remember(item, item.technologies)}>
            {savingRepository === item.repository ? "正在保存…" : "确认并记住"}</button>
            <button type="button" disabled={!!savingRepository}
              onClick={() => void remember(item, [])}>
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
