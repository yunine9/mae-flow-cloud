import type {
  BusinessModule,
  KnowledgeNature,
  SkillKnowledgeMetadataInput,
} from "./api";
import {
  KnowledgeLanguagePicker,
  KnowledgeLanguageTags,
} from "./KnowledgeLanguages";

export interface SkillMetadataDraft {
  nature?: SkillKnowledgeMetadataInput["nature"];
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

export const EMPTY_SKILL_METADATA: SkillMetadataDraft = {
  business_module_ids: [], repositories: [], technologies: [],
};

export function skillMetadataInput(
  value: SkillMetadataDraft,
): SkillKnowledgeMetadataInput | undefined {
  if (!value.nature) return undefined;
  if (value.nature === "business" && !value.business_module_ids.length) {
    return undefined;
  }
  return {
    nature: value.nature,
    business_module_ids: value.business_module_ids,
    repositories: value.repositories,
    technologies: value.nature === "engineering" ? value.technologies : [],
  };
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value) : [...values, value];
}

export function SkillMetadataEditor({ value, modules, onChange }: {
  value: SkillMetadataDraft;
  modules: BusinessModule[];
  onChange: (value: SkillMetadataDraft) => void;
}) {
  const activeModules = modules.filter((module) => module.status === "active");
  const repositoryOptions = [...new Set(activeModules.flatMap((module) =>
    module.repositories))];
  const chooseNature = (nature: Exclude<KnowledgeNature, "unclassified">) =>
    onChange({ ...value, nature,
      business_module_ids: nature === "business"
        ? value.business_module_ids.slice(0, 1) : value.business_module_ids,
      technologies: nature === "business" ? [] : value.technologies });
  return <div className="skill-classification-editor">
    <div className="skill-kind-picker two" role="group" aria-label="知识性质">
      <button type="button" aria-pressed={value.nature === "business"}
        onClick={() => chooseNature("business")}>
        <strong>业务知识</strong><small>领域概念、规则、流程与业务边界</small>
      </button>
      <button type="button" aria-pressed={value.nature === "engineering"}
        onClick={() => chooseNature("engineering")}>
        <strong>工程知识</strong><small>编码、构建、测试、排障和技术方法</small>
      </button>
    </div>
    {!value.nature && <p className="skill-classification-prompt">
      先判断正文讲业务事实还是工程方法；Skill 只是它的呈现形态。</p>}

    {value.nature && <div className="skill-classification-detail">
      <span><strong>{value.nature === "business" ? "归属业务模块（必选）"
        : "业务模块上下文（可选）"}</strong><small>
        {value.nature === "business"
          ? "业务知识必须有明确模块归属。"
          : "例如订单仓排障 Skill 仍是工程知识，这里只说明使用语境。"}
      </small></span>
      {activeModules.length ? <div className="skill-module-picker">
        {activeModules.map((module) => <button type="button" key={module.id}
          aria-pressed={value.business_module_ids.includes(module.id)}
          onClick={() => onChange({ ...value,
            business_module_ids: value.nature === "business" ? [module.id]
              : toggle(value.business_module_ids, module.id) })}>
          {module.name}<small>{module.id}</small></button>)}
      </div> : <small className="skill-classification-empty">
        目前没有启用中的业务模块。</small>}
    </div>}

    {value.nature && repositoryOptions.length > 0
      && <div className="skill-classification-detail">
        <span><strong>适用代码仓（可选）</strong><small>
          不选表示不限仓库；选择后只向涉及这些仓库的任务推荐。</small></span>
        <div className="skill-module-picker repository-options">
          {repositoryOptions.map((repository) => <button type="button"
            key={repository} title={repository}
            aria-pressed={value.repositories.includes(repository)}
            onClick={() => onChange({ ...value,
              repositories: toggle(value.repositories, repository) })}>
            {repository.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/i, "")
              || repository}</button>)}
        </div>
      </div>}

    {value.nature === "engineering" && <div
      className="skill-classification-detail">
      <span><strong>适用技术栈（可选）</strong><small>
        不选表示技术无关；仓库技术栈由用户首次选择并由系统记忆。</small></span>
      <KnowledgeLanguagePicker value={value.technologies}
        includeAgnostic={false}
        onChange={(technologies) => onChange({ ...value, technologies })} />
    </div>}

    <p className="skill-classification-rule">
      性质看正文，不看挂载位置。若同一正文同时讲业务规则和工程实现，请拆成两项知识；它们可以关联同一模块和仓库。</p>
  </div>;
}

const NATURE_LABEL: Record<KnowledgeNature, string> = {
  business: "业务知识", engineering: "工程知识", unclassified: "待补属性",
};

export function SkillMetadataTags({ nature, moduleIds, repositories,
  technologies, modules }: {
  nature: KnowledgeNature;
  moduleIds: string[];
  repositories: string[];
  technologies: string[];
  modules: BusinessModule[];
}) {
  const names = new Map(modules.map((module) => [module.id, module.name]));
  return <span className="skill-classification-tags">
    <em className={`kind-${nature}`}>{NATURE_LABEL[nature]}</em>
    <em className="kind-form">Skill 形态</em>
    {moduleIds.map((id) => <em className="skill-module-tag" key={id}>
      {names.get(id) ?? id}</em>)}
    {repositories.map((repository) => <em className="skill-repository-tag"
      key={repository}>{repository.replace(/\/+$/, "").split("/").at(-1)
        ?.replace(/\.git$/i, "") || repository}</em>)}
    {nature === "engineering" && <KnowledgeLanguageTags
      languages={technologies} empty="技术无关" />}
  </span>;
}
