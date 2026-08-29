import type {
  ExecutionPlaybookOption,
  ExecutionStageCustomization,
} from "./api";

function stageValue(
  values: ExecutionStageCustomization[],
  playbookId: string,
): ExecutionStageCustomization {
  return values.find((item) => item.playbook_id === playbookId) ?? {
    playbook_id: playbookId,
    optional_activities: [],
    preferred_resources: [],
  };
}

function compact(values: ExecutionStageCustomization[]): ExecutionStageCustomization[] {
  return values.filter((item) => item.instructions?.trim()
    || item.optional_activities.length || item.preferred_resources.length)
    .map((item) => ({
      ...item,
      instructions: item.instructions?.trim() || undefined,
      optional_activities: [...new Set(item.optional_activities)].sort(),
      preferred_resources: [...new Set(item.preferred_resources)].sort(),
    }));
}

export function StageCustomizationEditor({
  playbooks,
  value,
  inherited = [],
  onChange,
  title = "按阶段定制执行方案",
  description = "平台必做项保持不变；这里只增加动作、设置优先能力或补充阶段要求。",
}: {
  playbooks: ExecutionPlaybookOption[];
  value: ExecutionStageCustomization[];
  inherited?: ExecutionStageCustomization[];
  onChange: (next: ExecutionStageCustomization[]) => void;
  title?: string;
  description?: string;
}) {
  const changed = value.length;

  function update(
    playbookId: string,
    transform: (current: ExecutionStageCustomization) => ExecutionStageCustomization,
  ) {
    const current = stageValue(value, playbookId);
    onChange(compact([
      ...value.filter((item) => item.playbook_id !== playbookId),
      transform(current),
    ]));
  }

  if (!playbooks.length) return null;
  return <details className="stage-customization-editor">
    <summary>
      <span><strong>{title}</strong><small>{description}</small></span>
      <em>{changed ? `已定制 ${changed} 个阶段` : "沿用平台与团队默认"}</em>
    </summary>
    <div className="stage-customization-list">
      {playbooks.map((playbook) => {
        const own = stageValue(value, playbook.id);
        const team = stageValue(inherited, playbook.id);
        const optionalActivities = playbook.activities.filter((item) => !item.required);
        const preferredResources = playbook.resources.filter((item) =>
          item.usage !== "required");
        const active = !!own.instructions || own.optional_activities.length > 0
          || own.preferred_resources.length > 0;
        return <details className={`stage-customization-item${active ? " active" : ""}`}
          key={playbook.id}>
          <summary>
            <span><small>{playbook.phase}</small><strong>{playbook.title}</strong></span>
            <em>{active ? "本任务有调整" : team.instructions
              || team.optional_activities.length || team.preferred_resources.length
              ? "含团队默认" : "平台默认"}</em>
          </summary>
          <div className="stage-customization-body">
            <p>{playbook.summary}</p>
            <div className="stage-fixed-contract">
              <strong>平台必做</strong>
              <span>{playbook.activities.filter((item) => item.required)
                .map((item) => item.title).join("、")}</span>
            </div>
            {team.instructions && <div className="stage-inherited-note">
              <strong>团队阶段补充</strong><span>{team.instructions}</span>
            </div>}
            {optionalActivities.length > 0 && <fieldset>
              <legend>增加可选动作</legend>
              {optionalActivities.map((activity) => {
                const inheritedChoice = team.optional_activities.includes(activity.id);
                const checked = inheritedChoice
                  || own.optional_activities.includes(activity.id);
                return <label key={activity.id}>
                  <input type="checkbox" checked={checked}
                    disabled={inheritedChoice}
                    onChange={(event) => update(playbook.id, (current) => ({
                      ...current,
                      optional_activities: event.target.checked
                        ? [...current.optional_activities, activity.id]
                        : current.optional_activities.filter((id) => id !== activity.id),
                    }))} />
                  <span><strong>{activity.title}</strong>
                    <small>{activity.description}</small></span>
                  {inheritedChoice && <em>团队默认</em>}
                </label>;
              })}
            </fieldset>}
            {preferredResources.length > 0 && <fieldset>
              <legend>本阶段优先能力</legend>
              <div className="stage-resource-options">
                {preferredResources.map((resource) => {
                  const inheritedChoice = team.preferred_resources.includes(resource.id);
                  const checked = inheritedChoice
                    || own.preferred_resources.includes(resource.id);
                  return <label key={resource.id}>
                    <input type="checkbox" checked={checked}
                      disabled={inheritedChoice}
                      onChange={(event) => update(playbook.id, (current) => ({
                        ...current,
                        preferred_resources: event.target.checked
                          ? [...current.preferred_resources, resource.id]
                          : current.preferred_resources.filter((id) => id !== resource.id),
                      }))} />
                    <span>{resource.name}</span>
                    {inheritedChoice && <em>团队默认</em>}
                  </label>;
                })}
              </div>
            </fieldset>}
            <label className="stage-instructions-field">
              <span>阶段补充</span>
              <textarea rows={3} maxLength={2000}
                value={own.instructions ?? ""}
                placeholder={`例如：进入“${playbook.title}”时要特别关注什么、先做什么；不重复需求正文。`}
                onChange={(event) => update(playbook.id, (current) => ({
                  ...current,
                  instructions: event.target.value,
                }))} />
              <small>{(own.instructions ?? "").length}/2000</small>
            </label>
          </div>
        </details>;
      })}
    </div>
    <footer>
      阶段、退出条件、真实证据、人工决定及 Git/交付权限不可调整；冲突定制自动失效并明确提示。
    </footer>
  </details>;
}
