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

/** 与演示提问采用同阶段最近一张原始卡片；缺少相邻回复时留给演示者选择。 */
export function taskDemoPhaseSteps(task: TaskSummary, phase: string, phaseSteps?: Record<string, string[]>): string[] {
  const fixedSteps = task.workflow_profile?.final_snapshot?.stages
    .filter(stage => stage.phase === phase).flatMap(stage => stage.steps) ?? [];
  const steps = fixedSteps.length ? fixedSteps : phaseSteps?.[phase] ?? [];
  // 分析主任务使用 Cloud 步骤，展示阶段仍取内核 placeholder，不能另造拆分阶段。
  return phase === TASK_DEMO_ANALYSIS_PHASE
    ? [...new Set([...steps.filter(step => step !== "cloud_requirement_analysis_confirm"),
      ...(task.requirement_graph ? ["requirement_analysis"] : [])])]
    : [...steps];
}

export function suggestedDemoMessage(snapshot: TaskDemoSnapshot, phase: string): string | undefined {
  const steps = taskDemoPhaseSteps(snapshot.task, phase, snapshot.phase_steps);
  if (!steps.length) return undefined;
  const items = snapshot.conversation.items;
  let card = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "card" && steps.includes(item.step)) { card = index; break; }
  }
  if (card < 0) return undefined;
  for (let index = card - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "card") break;
    if (item.kind === "turn" && item.texts.length) return item.id;
  }
  return undefined;
}
