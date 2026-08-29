/**
 * 进度条阶段弹层:点进度条上的阶段名,看"这个阶段怎么干"。
 *
 * 两层事实,如实区分,绝不混淆:
 * - 当前阶段:内核 execution-plan 编译出的活方案(含定制层与选择
 *   理由),整卡展示——这是唯一"真实作用于 Agent"的方案;
 * - 其他阶段:内核 playbooks.json 的标准方案底版。未到的阶段要到达
 *   时才结合定制编译出最终方案;已过的阶段活方案不留存。底版就说
 *   自己是底版,不冒充"当时/届时实际执行的方案"。
 *
 * 样式全部复用 OverlayDialog(预热浮层同款)与 execution-plan-card,
 * 不新增 CSS(style.css 正在被并行迭代,避免碰撞)。
 */

import { useEffect, useState } from "react";
import {
  getLaunchOptions,
  type ExecutionPlan,
  type ExecutionPlaybookOption,
} from "./api";
import { ExecutionPlanCard } from "./ExecutionPlanCard";
import { OverlayDialog } from "./WarmupPanel";
import type { ExecutionPlanFeedbackDraft } from "./executionPlanFeedback";

export function StagePlanDialog({
  phase,
  currentPhase,
  plan,
  planWarning,
  onSuggest,
  onClose,
}: {
  phase: string;
  /** 任务此刻所在阶段;用于把"已过/未到"说清楚。 */
  currentPhase: string;
  plan?: ExecutionPlan;
  planWarning?: string;
  onSuggest?: (draft: ExecutionPlanFeedbackDraft) => void;
  onClose: () => void;
}) {
  const live = !!plan && plan.step.phase === phase;
  const [catalog, setCatalog] = useState<ExecutionPlaybookOption[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (live) return;
    let alive = true;
    getLaunchOptions().then((options) => {
      if (!alive) return;
      setCatalog(options.execution_playbooks
        .filter((item) => item.phase === phase));
    }).catch((reason) => {
      if (alive) {
        setError(reason instanceof Error
          ? reason.message : "方案目录读取失败");
      }
    });
    return () => { alive = false; };
  }, [live, phase]);

  return (
    <OverlayDialog ariaLabel={`${phase} 阶段执行方案`}
      title={`${phase} · 执行方案`} onClose={onClose}>
      {live ? (
        <ExecutionPlanCard plan={plan!} warning={planWarning}
          onSuggest={onSuggest} />
      ) : (
        <div className="execution-plan-card">
          <div className="execution-plan-why">
            <strong>{phase === currentPhase
              ? "本阶段的编译方案暂不可读"
              : "这是标准方案底版"}</strong>
            <span>
              {phase === currentPhase
                ? "内核暂未给出本阶段的编译方案;以下为标准方案目录。"
                : "活方案只在任务到达该阶段时结合定制编译产生,已过阶段"
                  + "也不留存;以下底版仅供了解该阶段默认怎么干。"}
            </span>
          </div>
          {error && <p className="execution-plan-warning" role="status">
            {error}</p>}
          {!error && !catalog && <p className="execution-plan-warning">
            正在读取方案目录…</p>}
          {catalog?.length === 0 && (
            <p className="execution-plan-warning">该阶段没有可展示的方案目录。</p>
          )}
          {catalog?.map((playbook) => (
            <section key={playbook.id}>
              <div className="execution-plan-why">
                <strong>{playbook.title} <small>v{playbook.version}</small></strong>
                <span>{playbook.summary}</span>
              </div>
              <div className="execution-plan-activities">
                {playbook.activities.map((activity) => (
                  <article key={activity.id}>
                    <i aria-hidden>✓</i>
                    <div><strong>{activity.title}</strong>
                      <p>{activity.description}</p></div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </OverlayDialog>
  );
}
