import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  scanRepositorySkills,
  type RepositorySkillCatalog,
  type SelectedRepositoryKnowledge,
  type SelectedRepositorySkill,
} from "./api";

/** 与服务端 TaskService 的硬上限保持一致。页面先挡住，避免多仓全选后
 * 到“提交决定”才收到 400、让人回头猜该删哪些。 */
const MAX_SELECTED_SKILLS = 20;
const MAX_SELECTED_KNOWLEDGE = 12;
const MAX_KNOWLEDGE_BYTES = 256 * 1024;

export interface RepositorySkillSelection {
  /** false = 从未成功读取，本次提交不得覆盖任务原有选择。 */
  scanned: boolean;
  scanning: boolean;
  catalogToken?: string;
  selectedIds: string[];
  selectedKnowledgeIds: string[];
}

export const EMPTY_REPOSITORY_SKILL_SELECTION: RepositorySkillSelection = {
  scanned: false,
  scanning: false,
  selectedIds: [],
  selectedKnowledgeIds: [],
};

export interface RepositorySkillPickerState {
  catalog: RepositorySkillCatalog | null;
  selection: RepositorySkillSelection;
  scanError: string;
}

export const EMPTY_REPOSITORY_SKILL_PICKER_STATE: RepositorySkillPickerState = {
  catalog: null,
  selection: EMPTY_REPOSITORY_SKILL_SELECTION,
  scanError: "",
};

function repositoryLabel(repository: string): string {
  const tail = repository.replace(/\/+$/, "").split("/").pop() || repository;
  return tail.replace(/\.git$/i, "") || repository;
}

function resourceKey(repository: string, relativePath: string): string {
  return `${repository}\0${relativePath}`;
}

export function RepositorySkillPicker({
  repositories,
  baseline,
  initialSkills = [],
  initialKnowledge = [],
  onSelectionChange,
  presentation = "launch",
  state,
  onStateChange,
}: {
  repositories: string[];
  baseline?: string;
  /** Chain 检视时展示并沿用下单时已选项；重新读取后按仓+路径映射到
   * 新目录中的 id，仓库有新提交也不会仅因 revision 变化而悄悄丢选。 */
  initialSkills?: SelectedRepositorySkill[];
  initialKnowledge?: SelectedRepositoryKnowledge[];
  onSelectionChange?: (selection: RepositorySkillSelection) => void;
  presentation?: "launch" | "decision";
  /** Chain 的“需要修改→再次检视”会暂时卸载决策卡；受控状态让已经
   * 读取的目录/token 留在 TaskWorkspace，不强迫用户下一轮重扫。 */
  state?: RepositorySkillPickerState;
  onStateChange?: Dispatch<SetStateAction<RepositorySkillPickerState>>;
}) {
  const normalizedRepositories = repositories
    .map((item) => item.trim()).filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
  const [internalState, setInternalState] = useState<RepositorySkillPickerState>(
    EMPTY_REPOSITORY_SKILL_PICKER_STATE,
  );
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(),
  );
  const pickerState = state ?? internalState;
  const setPickerState = onStateChange ?? setInternalState;
  const { catalog, selection, scanError } = pickerState;
  const scanVersion = useRef(0);
  const scanAbort = useRef<AbortController | null>(null);
  const selectedIds = new Set(selection.selectedIds);
  const selectedKnowledgeIds = new Set(selection.selectedKnowledgeIds);

  useEffect(() => {
    onSelectionChange?.(selection);
  }, [onSelectionChange, selection]);

  useEffect(() => () => {
    scanVersion.current += 1;
    scanAbort.current?.abort();
  }, []);

  function wantedSkills(): Set<string> {
    if (!catalog) {
      return new Set(initialSkills.map((skill) =>
        resourceKey(skill.repository, skill.relative_path)));
    }
    const wanted = new Set<string>();
    for (const repository of catalog.repositories) {
      for (const skill of repository.skills) {
        if (selectedIds.has(skill.id)) {
          wanted.add(resourceKey(repository.repository, skill.relative_path));
        }
      }
    }
    return wanted;
  }

  function wantedKnowledge(): Set<string> {
    if (!catalog) {
      return new Set(initialKnowledge.map((item) =>
        resourceKey(item.repository, item.relative_path)));
    }
    const wanted = new Set<string>();
    for (const repository of catalog.repositories) {
      for (const item of repository.knowledge) {
        if (selectedKnowledgeIds.has(item.id)) {
          wanted.add(resourceKey(repository.repository, item.relative_path));
        }
      }
    }
    return wanted;
  }

  async function scanSkills() {
    if (!normalizedRepositories.length || selection.scanning) return;
    const preserve = wantedSkills();
    const preserveKnowledge = wantedKnowledge();
    const firstScan = !catalog && initialKnowledge.length === 0;
    const version = ++scanVersion.current;
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    setPickerState({
      catalog: null,
      scanError: "",
      selection: {
        scanned: false,
        scanning: true,
        selectedIds: [],
        selectedKnowledgeIds: [],
      },
    });
    try {
      const result = await scanRepositorySkills(
        normalizedRepositories,
        baseline?.trim() || undefined,
        controller.signal,
      );
      if (scanVersion.current !== version) return;
      setExpandedSections(new Set(result.repositories.flatMap((repository) => [
        ...(repository.knowledge.length <= 6
          ? [`${repository.repository}\0knowledge`] : []),
        ...(repository.skills.length <= 4
          ? [`${repository.repository}\0skills`] : []),
      ])));
      const nextIds = result.repositories.flatMap((repository) =>
        repository.skills
          .filter((skill) => skill.selectable
            && preserve.has(resourceKey(repository.repository, skill.relative_path)))
          .map((skill) => skill.id))
        .slice(0, MAX_SELECTED_SKILLS);
      const selectableKnowledge = result.repositories.flatMap((repository) =>
        repository.knowledge.filter((item) => item.selectable));
      const wantedKnowledgeItems = selectableKnowledge.filter((item) =>
        preserveKnowledge.has(resourceKey(
          result.repositories.find((repository) =>
            repository.knowledge.some((entry) => entry.id === item.id))
            ?.repository ?? "",
          item.relative_path,
        )) || (presentation === "launch" && firstScan && item.recommended));
      let selectedBytes = 0;
      const nextKnowledgeIds: string[] = [];
      for (const item of wantedKnowledgeItems) {
        if (nextKnowledgeIds.length >= MAX_SELECTED_KNOWLEDGE
            || selectedBytes + item.bytes > MAX_KNOWLEDGE_BYTES) continue;
        nextKnowledgeIds.push(item.id);
        selectedBytes += item.bytes;
      }
      setPickerState({
        catalog: result,
        scanError: "",
        selection: {
          scanned: true,
          scanning: false,
          catalogToken: result.catalog_token,
          selectedIds: nextIds,
          selectedKnowledgeIds: nextKnowledgeIds,
        },
      });
    } catch (reason) {
      if (scanVersion.current !== version
          || (reason instanceof DOMException && reason.name === "AbortError")) return;
      setPickerState({
        catalog: null,
        scanError: reason instanceof Error
          ? reason.message
          : "仓内能力读取失败，请稍后重试",
        selection: {
          scanned: false,
          scanning: false,
          selectedIds: [],
          selectedKnowledgeIds: [],
        },
      });
    } finally {
      if (scanVersion.current === version) scanAbort.current = null;
    }
  }

  function updateKnowledge(
    updater: (current: Set<string>) => Set<string>,
  ) {
    setPickerState((previous) => {
      const next = updater(new Set(previous.selection.selectedKnowledgeIds));
      return {
        ...previous,
        selection: {
          ...previous.selection,
          selectedKnowledgeIds: Array.from(next),
        },
      };
    });
  }

  function toggleKnowledge(id: string, on: boolean) {
    updateKnowledge((current) => {
      const next = new Set(current);
      if (!on) next.delete(id);
      else {
        const items = catalog?.repositories.flatMap((repository) =>
          repository.knowledge) ?? [];
        const bytes = items.filter((item) => next.has(item.id))
          .reduce((sum, item) => sum + item.bytes, 0);
        const item = items.find((candidate) => candidate.id === id);
        if (item && next.size < MAX_SELECTED_KNOWLEDGE
            && bytes + item.bytes <= MAX_KNOWLEDGE_BYTES) next.add(id);
      }
      return next;
    });
  }

  function updateSelected(updater: (current: Set<string>) => Set<string>) {
    setPickerState((previous) => {
      const next = updater(new Set(previous.selection.selectedIds));
      return {
        ...previous,
        selection: {
          ...previous.selection,
          selectedIds: Array.from(next),
        },
      };
    });
  }

  function toggleSkill(skillId: string, on: boolean) {
    updateSelected((current) => {
      const next = new Set(current);
      if (on && next.size < MAX_SELECTED_SKILLS) next.add(skillId);
      else if (!on) next.delete(skillId);
      return next;
    });
  }

  function setRepositorySkills(skillIds: string[], on: boolean) {
    updateSelected((current) => {
      const next = new Set(current);
      for (const skillId of skillIds) {
        if (!on) next.delete(skillId);
        else if (next.size < MAX_SELECTED_SKILLS) next.add(skillId);
      }
      return next;
    });
  }

  const atLimit = selectedIds.size >= MAX_SELECTED_SKILLS;
  const initialNames = initialSkills.map((skill) => skill.name);
  const initialKnowledgeNames = initialKnowledge.map((item) => item.title);
  const hasRepository = normalizedRepositories.length > 0;

  return (
    <section className={`${presentation === "launch" ? "launch-form-section " : ""}repository-skills-section repository-skills-${presentation}`}
      aria-labelledby={`repository-skills-title-${presentation}`}>
      <div className="repository-skills-head">
        <i aria-hidden>＋</i>
        <div>
          <strong id={`repository-skills-title-${presentation}`}>业务知识与 Skill（可选）</strong>
          <small>{presentation === "decision"
            ? "按仓选择，确认后下发给对应交付子任务"
            : "开局补齐业务上下文，运行中自动留下消费足迹"}</small>
        </div>
        <em>{(initialSkills.length + initialKnowledge.length) > 0 && !catalog
          ? `当前 ${initialSkills.length + initialKnowledge.length} 项`
          : "按需选择"}</em>
      </div>

      <div className="repository-skills-toolbar">
        <p>
          项目规则（<code>AGENTS.md</code>/<code>CLAUDE.md</code>）自动生效；
          可从 <code>docs</code> 选择本单重点知识，也可选择四类标准目录下的 Skill。
          Agent 自行判断何时使用，平台只记录事实，不把知识消费变成流程门禁。
        </p>
        <div>
          {catalog && (
            <small className={atLimit ? "at-limit" : ""}>
              知识 {selectedKnowledgeIds.size}/{MAX_SELECTED_KNOWLEDGE} · Skill {selectedIds.size}/{MAX_SELECTED_SKILLS}
            </small>
          )}
          <button type="button" onClick={() => void scanSkills()}
            disabled={selection.scanning || !hasRepository}>
            {selection.scanning
              ? "正在读取…"
              : catalog || scanError
                ? "重新读取"
                : "读取知识与 Skill"}
          </button>
        </div>
      </div>

      {!hasRepository && (
        <div className="repository-skills-empty">
          先填写代码仓，再按需读取仓内知识；不读取也可继续。
        </div>
      )}
      {!catalog && !scanError
        && (initialNames.length > 0 || initialKnowledgeNames.length > 0) && (
        <div className="repository-skills-current">
          <strong>将沿用发起任务时的选择</strong>
          <span>{[...initialKnowledgeNames, ...initialNames].join("、")}</span>
          <small>不重新读取就保持不变；读取后可按仓调整或全部清空。</small>
        </div>
      )}
      {scanError && (
        <div className="repository-skills-error" role="alert">
          <strong>本次读取未完成</strong>
          <span>{scanError}</span>
          <small>你可以重试，也可以不改已有选择直接提交决定。</small>
        </div>
      )}
      {catalog && catalog.repositories.length === 0 && (
        <div className="repository-skills-empty">
          这些仓库没有可展示的业务知识或 Skill，不影响继续提交。
        </div>
      )}
      {catalog && catalog.repositories.length > 0 && (
        <div className="repository-skill-groups">
          {catalog.repositories.map((repository, repositoryIndex) => {
            const selectableIds = repository.skills
              .filter((skill) => skill.selectable)
              .map((skill) => skill.id);
            const allSelected = selectableIds.length > 0
              && selectableIds.every((skillId) => selectedIds.has(skillId));
            const selectedCount = selectableIds.filter(
              (skillId) => selectedIds.has(skillId)).length;
            return (
              <article className="repository-skill-group"
                key={`${repository.repository}-${repositoryIndex}`}>
                <header>
                  <div>
                    <strong title={repository.repository}>
                      {repositoryLabel(repository.repository)}
                    </strong>
                    <span title={repository.repository}>{repository.repository}</span>
                  </div>
                  {repository.revision && (
                    <code title={`版本 ${repository.revision}`}>
                      {repository.revision.length > 12
                        ? repository.revision.slice(0, 12)
                        : repository.revision}
                    </code>
                  )}
                  {selectableIds.length > 0 && (
                    <div className="repository-skill-actions">
                      <small>{selectedCount}/{selectableIds.length}</small>
                      <button type="button"
                        disabled={allSelected || (atLimit && selectedCount < selectableIds.length)}
                        onClick={() => setRepositorySkills(selectableIds, true)}>
                        全选本仓
                      </button>
                      <button type="button"
                        disabled={selectedCount === 0}
                        onClick={() => setRepositorySkills(selectableIds, false)}>
                        清空
                      </button>
                    </div>
                  )}
                </header>
                {repository.error && (
                  <div className="repository-skill-group-error">
                    {repository.error}；{presentation === "decision"
                      ? "本仓沿用原选择，可重新读取，也可继续确认。"
                      : "本仓不会加载仓内能力，可重新读取，也可继续发起。"}
                  </div>
                )}
                {!repository.error && repository.skills.length === 0
                  && repository.knowledge.length === 0 && (
                  <div className="repository-skill-none">
                    本仓未发现 docs 文档、项目规则或 Skill
                  </div>
                )}
                {repository.knowledge.length > 0 && (
                  <details className="repository-knowledge-block"
                    open={expandedSections.has(
                      `${repository.repository}\0knowledge`)}
                    onToggle={(event) => {
                      const key = `${repository.repository}\0knowledge`;
                      const open = event.currentTarget.open;
                      setExpandedSections((current) => {
                        if (current.has(key) === open) return current;
                        const next = new Set(current);
                        if (open) next.add(key); else next.delete(key);
                        return next;
                      });
                    }}>
                    <summary className="repository-resource-title">
                      <strong>业务知识</strong>
                      <small>{repository.knowledge.length} 项 · 选中文档开局加载</small>
                    </summary>
                    <div className="repository-skill-list repository-knowledge-list">
                      {repository.knowledge.map((item) => {
                        const selected = selectedKnowledgeIds.has(item.id);
                        const knowledgeItems = catalog.repositories.flatMap(
                          (entry) => entry.knowledge);
                        const bytes = knowledgeItems
                          .filter((entry) => selectedKnowledgeIds.has(entry.id))
                          .reduce((sum, entry) => sum + entry.bytes, 0);
                        const limitDisabled = !selected && (
                          selectedKnowledgeIds.size >= MAX_SELECTED_KNOWLEDGE
                          || bytes + item.bytes > MAX_KNOWLEDGE_BYTES);
                        const disabled = !item.selectable || limitDisabled;
                        return (
                          <label key={item.id}
                            className={`repository-skill-card repository-knowledge-card${
                              disabled ? " disabled" : ""}${
                              limitDisabled ? " limit-disabled" : ""}`}>
                            <input type="checkbox"
                              checked={item.auto_load || selected}
                              disabled={disabled}
                              onChange={(event) => toggleKnowledge(
                                item.id, event.target.checked)} />
                            <span className="repository-skill-check" aria-hidden />
                            <span className="repository-skill-copy">
                              <strong>{item.title}</strong>
                              <span>{item.description}</span>
                              <code title={item.relative_path}>{item.relative_path}</code>
                              <small>{item.auto_load
                                ? "项目规则 · 自动加载"
                                : item.recommended
                                  ? "项目规则提及 · 建议本单加载"
                                  : `${Math.max(1, Math.ceil(item.bytes / 1024))} KiB`}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                )}
                {repository.skills.length > 0 && (
                  <details className="repository-skill-block"
                    open={expandedSections.has(
                      `${repository.repository}\0skills`)}
                    onToggle={(event) => {
                      const key = `${repository.repository}\0skills`;
                      const open = event.currentTarget.open;
                      setExpandedSections((current) => {
                        if (current.has(key) === open) return current;
                        const next = new Set(current);
                        if (open) next.add(key); else next.delete(key);
                        return next;
                      });
                    }}>
                    <summary className="repository-resource-title">
                      <strong>Skills</strong>
                      <small>{repository.skills.length} 项 · Agent 按描述自主判断</small>
                    </summary>
                    <div className="repository-skill-list">
                    {repository.skills.map((skill) => {
                      const selected = selectedIds.has(skill.id);
                      const limitDisabled = atLimit && !selected;
                      const disabled = !skill.selectable || limitDisabled;
                      return (
                        <label key={skill.id}
                          className={`repository-skill-card${disabled ? " disabled" : ""}${
                            limitDisabled ? " limit-disabled" : ""}`}>
                          <input type="checkbox"
                            checked={selected}
                            disabled={disabled}
                            onChange={(event) => toggleSkill(
                              skill.id, event.target.checked)} />
                          <span className="repository-skill-check" aria-hidden />
                          <span className="repository-skill-copy">
                            <strong>{skill.name}</strong>
                            <span>{skill.description || "仓库未提供能力说明"}</span>
                            <code title={skill.relative_path}>{skill.relative_path}</code>
                            {!skill.selectable && skill.warning && (
                              <small>{skill.warning}</small>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    </div>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}
      {catalog && atLimit && (
        <div className="repository-skills-limit" role="status">
          每个任务最多启用 {MAX_SELECTED_SKILLS} 项；先清空部分已选项，才能选择其他 Skill。
        </div>
      )}
      {catalog && selectedKnowledgeIds.size >= MAX_SELECTED_KNOWLEDGE && (
        <div className="repository-skills-limit" role="status">
          每个任务最多加载 {MAX_SELECTED_KNOWLEDGE} 篇重点知识；项目规则不计入上限。
        </div>
      )}
    </section>
  );
}
