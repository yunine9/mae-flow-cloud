import type { Annotation, ArtifactMeta, AuthUser, ConversationItem, MemoryRecord, MemoryUsageRow, ReviewRequest, TaskSummary } from "./api";
import type { ArchitectureNode } from "../../src/architectureDetails";
import type { StoryViewCoverage } from "../../src/storyViewCoverage";
import phaseCatalog from "../../kernel/flow/phases.json";

export const TASK_DEMO_ANALYSIS_PHASE = phaseCatalog.placeholders.analysis;

export interface TaskDemoSnapshot {
  schema: "mae-flow-demo-snapshot/1";
  captured_at: string;
  source_task_id: string;
  task: TaskSummary;
  artifacts: ArtifactMeta[];
  conversation: { items: ConversationItem[]; problems?: string[] };
  annotations: { items: Annotation[] };
  reviews?: ReviewRequest[];
  memories?: Array<{ record: MemoryRecord; content: string }>;
  memoryUsage?: MemoryUsageRow[];
  phase_steps?: Record<string, string[]>;
  step_titles?: Record<string, string>;
  card_contexts?: Record<string, { context?: string; preface?: string }>;
  supplemental_cards?: Record<string, string[]>;
  problems: string[];
}

export interface TaskDemoControls {
  phase: string;
  sourceTaskId: string;
  sourceLabel: string;
  sourceStatus: string;
  preview?: boolean;
  onSelectPhase: (phase: string) => void;
  onReset: () => void;
  onExit: () => void;
  backLabel?: string;
  suggestedMessageId?: string;
  suggestedCardId?: string;
  focusKey?: number;
}

export interface TaskDemoPreviewInput {
  snapshot: TaskDemoSnapshot;
  actor: AuthUser;
  fetchRead: typeof fetch;
  architecture?: TaskDemoArchitectureFixture;
  relatedSnapshots?: TaskDemoSnapshot[];
}

/** 仅由本地 DEV 预览提供的内存图源，不从任务或远端接口加载。 */
export interface TaskDemoArchitectureFixture {
  projection: {
    renderer: string; warnings: string[];
    diagrams: Array<{ id: "demo-overview"; title: string; type: string; view: StoryViewCoverage["id"]; line?: number; nodes?: ArchitectureNode[] }>;
    views?: StoryViewCoverage[];
  };
  diagram: { html: string };
}

/** 历史卡保存的可能是步骤 ID，也可能是当时显示的步骤标题。 */
export function taskDemoPhaseSteps(task: TaskSummary, phase: string, phaseSteps?: Record<string, string[]>,
  stepTitles?: Record<string, string>): string[] {
  const fixedSteps = task.workflow_profile?.final_snapshot?.stages
    .filter(stage => stage.phase === phase).flatMap(stage => stage.steps) ?? [];
  const steps = fixedSteps.length ? fixedSteps : phaseSteps?.[phase]
    ?? phaseCatalog.phases.find(row => row.name === phase)?.steps ?? [];
  const matches = new Set(steps.flatMap(step => [step, ...(stepTitles?.[step] ? [stepTitles[step]] : [])]));
  if (phase === phaseCatalog.placeholders.queued) matches.add("cloud_requirement_analysis_confirm");
  if (phaseCatalog.phases.find(row => row.steps.includes("push"))?.name === phase) {
    for (const step of ["host_push_confirm", "cloud_push_confirm", "cloud_mr_description"]) matches.add(step);
  }
  if (task.split_escalation?.phase === phase) matches.add("cloud_split_proposal");
  if (phase === TASK_DEMO_ANALYSIS_PHASE) {
    matches.delete("cloud_requirement_analysis_confirm");
    if (task.requirement_graph) matches.add("requirement_analysis");
    // 分析主任务不运行内核，历史提问没有内核步骤标题。
    if (!task.parent_task_id && task.requirement_graph) matches.add("");
  }
  return [...matches];
}

export function taskDemoPhaseCard(snapshot: TaskDemoSnapshot, phase: string) {
  const steps = taskDemoPhaseSteps(snapshot.task, phase, snapshot.phase_steps, snapshot.step_titles);
  return [...snapshot.conversation.items].reverse().find((item): item is Extract<ConversationItem, { kind: "card" }> =>
    item.kind === "card" && steps.includes(item.step));
}

export function hasTaskDemoPhaseCard(snapshot: TaskDemoSnapshot, phase: string): boolean {
  if (taskDemoPhaseCard(snapshot, phase)) return true;
  const waiting = snapshot.task.waiting;
  return Boolean(waiting && (waiting.step !== undefined
    ? taskDemoPhaseSteps(snapshot.task, phase, snapshot.phase_steps, snapshot.step_titles).includes(waiting.step)
    : snapshot.task.progress?.current_phase === phase));
}

export function suggestedDemoMessage(snapshot: TaskDemoSnapshot, phase: string): string | undefined {
  const steps = taskDemoPhaseSteps(snapshot.task, phase, snapshot.phase_steps, snapshot.step_titles);
  if (!steps.length) return undefined;
  const items = snapshot.conversation.items;
  let card = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "card" && steps.includes(item.step)) { card = index; break; }
  }
  if (card < 0) return undefined;
  if (snapshot.supplemental_cards?.[items[card].id]) return items[card].id;
  for (let index = card - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "card") break;
    if (item.kind === "turn" && item.texts.length) return item.id;
  }
  return items[card].id;
}
