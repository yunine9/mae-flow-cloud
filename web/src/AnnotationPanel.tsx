/**
 * 批注清单:记录批注内容、提交状态和原位置变化。
 *
 * 进展这一栏只报**事实**,不下"已采纳"这种结论:
 * - 锚定的原文还在(不论挪没挪行)→ 它还没改这里
 * - 原文已不在 → 这处已经被改动
 * 是不是照你说的改的,你看了再说——系统替你判断"采纳了"就是推断,
 * 而推断错了比不显示更坏(你会以为提过的都落实了)。
 *
 * 踩过的坑(2026-08-19 内网实锤):moved(原文还在,只是行号变了)
 * 一度也被当"已被改动·请你确认"。agent 在跑,别处任何改动都会让
 * 行号漂移——批注打在工作区变更(diff)上时更是全文重排,刚送出的
 * 批注秒变"已修改请检视",而批的那处一个字没动。位置漂移只是定位
 * 信息(脚注里如实标),"被改动"的判据只有一个:原文没了。
 *
 * 没有"批注管理页":这块面板就长在工作台里,跟材料和决定同屏。
 */

import { useEffect, useState } from "react";
import {
  dropAnnotation,
  editAnnotation,
  judgeAnnotation,
  replyToAnnotation,
  sendAnnotations,
  TASK_REQUIREMENT_ARTIFACT,
  type Annotation,
  type AnchorCheck,
  type TaskStatus,
} from "./api";
import { shortPath } from "./paths";
import { relativeTime } from "./time";
import "./annotate.css";

const ANCHOR_TEXT: Record<AnchorCheck["state"], string> = {
  hit: "定位正常",
  moved: "原文仍在,行号有漂移(定位已跟随)",
  gone: "原位置内容已删除",
  ambiguous: "存在多个匹配位置",
};

type AnnotationRoute = NonNullable<Annotation["route"]>;

function routeOf(item: Annotation): AnnotationRoute {
  return item.route ?? "agent";
}

const ROUTE_LABEL: Record<AnnotationRoute, string> = {
  agent: "Agent 处理",
  owner_reply: "责任人答复",
  owner_decision: "决策后处理",
  memory: "记忆",
};

export interface AdminOverrideAccess {
  canDrop: boolean;
  canVerify: boolean;
}

/** 管理员旁路必须同时满足服务端下发的“当前复检”白名单和页面阶段事实。
 * 缺少任一事实时默认关闭，不能把历史意见、草稿或自己的意见暴露为代办。 */
export function adminOverrideAccess({
  item,
  viewerUsername,
  canOverride,
  reviewReady,
  reviewAnnotationIds,
}: {
  item: Annotation;
  viewerUsername: string;
  canOverride: boolean;
  reviewReady: boolean;
  reviewAnnotationIds: readonly string[];
}): AdminOverrideAccess {
  const currentPending = canOverride
    && reviewReady
    && item.author !== viewerUsername
    && item.status === "sent"
    && reviewAnnotationIds.includes(item.id);
  const currentResponse = item.response?.revision === (item.rework ?? 0);
  return {
    canDrop: currentPending,
    canVerify: currentPending
      && currentResponse
      && item.response?.outcome !== "needs_clarification",
  };
}

export type AdminOverrideAction = "drop" | "verify";

export interface AdminOverrideArm {
  annotationId: string;
  action: AdminOverrideAction;
}

/** 首次点击只武装；只有同一条意见上的同一动作再次点击才真正执行。 */
export function advanceAdminOverrideArm(
  current: AdminOverrideArm | undefined,
  annotationId: string,
  action: AdminOverrideAction,
): { execute: boolean; arm: AdminOverrideArm | undefined } {
  if (current?.annotationId === annotationId && current.action === action) {
    return { execute: true, arm: undefined };
  }
  return { execute: false, arm: { annotationId, action } };
}

/** 意见作者什么时候可以裁决一条已送达批注。
 *
 * MR 修复轮有逐条结构化回执，仍按 reviewReady 的严格门禁开放；普通
 * 需求/设计检视没有这份回执，Agent 再次举卡就是本轮已经回到人工的
 * 权威事实。旧实现把两类场景混成一类，导致普通批注已经送达、Agent
 * 也改完并再次等人后，页面仍隐藏“确认已修复 / 仍需调整”，而服务端
 * 又用这条 sent 意见阻止通过，形成无法自救的闭环死锁。
 */
export function authorVerdictReady(
  item: Annotation,
  taskStatus: TaskStatus,
  workspaceReviewReady: boolean,
): boolean {
  if (item.status !== "sent") {
    return false;
  }
  // 问责任人的意见不需要等 Agent 或任务阶段：责任人留下原话后，
  // 提出人即可判断是否解答。决策后处理仍必须等 Agent 真正执行。
  if (routeOf(item) === "owner_reply") return Boolean(item.owner_reply);
  if (taskStatus !== "waiting_for_human") return false;
  // 这类意见只是趁“等决定”窗口先登记为团队事实，尚未随决定真正
  // 送给 Agent；不能刚提交就让作者自称已经验收。
  if (item.sent_via === "queued_decision") return false;
  // 流水线证据用于恢复取证，不是代码/文档检视闭环。
  if (item.sent_via === "pipeline_evidence") return false;
  // MR 工作区修复必须等 Build-Fix 收敛并生成当前复检卡；有总回复也
  // 不能绕过逐条回执与 HEAD 绑定。
  if (item.sent_via === "review_repair") {
    return workspaceReviewReady
      && item.response?.revision === (item.rework ?? 0);
  }
  // decision / interrupt 以及没有 sent_via 的旧账都属于普通流程检视：
  // Agent 再次进入人工节点后，由意见作者依据最新材料亲自裁决。
  return true;
}

/** 批注与检视抽屉顶部筛选条的三档:等我确认 / Agent 处理中 / 已闭环。
 * 批注、CodeHub 意见、机器告警三节共用,人一眼看到"此刻压在我这的有几条"。 */
export type ReviewFilter = "all" | "mine" | "agent" | "closed";

/** 一条批注归筛选条的哪一档。只用现成事实(状态、作者、裁决就绪),不猜。 */
export function annotationCategory(
  item: Annotation,
  context: {
    viewerUsername: string;
    taskStatus: TaskStatus;
    reviewReady: boolean;
    canOverride: boolean;
    canRouteOthers?: boolean;
    reviewAnnotationIds: readonly string[];
  },
): Exclude<ReviewFilter, "all"> {
  if (item.status === "verified" || item.status === "dropped") return "closed";
  const isAuthor = item.author === context.viewerUsername;
  if (item.status === "draft") {
    const routable = context.canRouteOthers
      && !["completed", "canceled"].includes(context.taskStatus)
      && (routeOf(item) === "agent" || item.assignee === context.viewerUsername);
    return isAuthor || routable ? "mine" : "agent";
  }
  if (isAuthor && authorVerdictReady(item, context.taskStatus, context.reviewReady)) {
    return "mine";
  }
  return adminOverrideAccess({
    item,
    viewerUsername: context.viewerUsername,
    canOverride: context.canOverride,
    reviewReady: context.reviewReady,
    reviewAnnotationIds: context.reviewAnnotationIds,
  }).canVerify ? "mine" : "agent";
}

/** 一条批注此刻处在哪。检视闭环的五站:
 * 待提交 → 已提交 → 已被改动·请你确认 → 确认通过 / 返工(回到待提交)。 */
function progressOf(
  item: Annotation,
  check?: AnchorCheck,
  archival = false,
  verdictReady = false,
): {
  tone: "draft" | "waiting" | "review" | "done";
  text: string;
  hint?: string;
} {
  if (routeOf(item) === "memory") {
    return { tone: "done", text: "已记为记忆",
      hint: "没有发给任何人。以后有人改到这段附近时，平台会把它提醒给 Agent。" };
  }
  if (item.status === "verified") {
    const proxyVerifier = item.verified_by && item.verified_by !== item.author
      ? item.verified_by : undefined;
    return proxyVerifier
      ? { tone: "done", text: "管理员代确认",
          hint: `由管理员 ${proxyVerifier} 代替批注作者 ${item.author} 确认。` }
      : { tone: "done", text: "确认通过",
          hint: "意见作者已确认这处改动符合要求。" };
  }
  if (item.status !== "sent") {
    if (archival) {
      return { tone: "draft", text: "交付后记录",
        hint: "任务已经交付，这条记录保留在任务档案中，不会再触发 Agent 修改。" };
    }
    return item.rework
      ? { tone: "draft", text: `第 ${item.rework + 1} 轮·待提交`,
          hint: "上一轮改动没达到要求,这条已退回,提交后会再送给 AI。" }
      : { tone: "draft", text: "待提交" };
  }
  const route = routeOf(item);
  if (route !== "agent" && !item.owner_reply) {
    return {
      tone: "waiting",
      text: route === "owner_reply" ? "等待责任人答复" : "等待责任人决策",
      hint: `已指派给 ${item.assignee ?? "任务责任人"}，Agent 不会代答。`,
    };
  }
  if (route === "owner_reply" && item.owner_reply) {
    return {
      tone: "review",
      text: "等待提出人确认",
      hint: "责任人已经答复，请由意见提出人确认是否解决问题。",
    };
  }
  if (route === "owner_decision" && item.owner_reply && !verdictReady) {
    return {
      tone: "waiting",
      text: item.sent_via === "owner_pending"
        ? "决策已记录·等待继续"
        : item.sent_via === "queued_decision"
          ? "决策已记录·等待执行" : "Agent 正在按决策处理",
      hint: item.sent_via === "owner_pending"
        ? "责任人结论已经保存；当前流程暂时不能接收，恢复后可继续交给 Agent。"
        : item.sent_via === "queued_decision"
        ? "当前还有任务决定卡；提交决定后，这份责任人结论会一并交给 Agent。"
        : "责任人已经给出结论，正在等待 Agent 完成修改。",
    };
  }
  if (verdictReady) {
    return {
      tone: "review",
      text: "待你确认",
      hint: "Agent 已留下当前轮逐条回应，请核对最新材料后确认或退回。",
    };
  }
  // "被改动"只认一个判据:锚定的原文消失了。行号漂移(moved)不算——
  // 原文还在就说明它还没改这处,只是别处的改动把行挤动了。
  return check?.state === "gone"
    ? { tone: "review", text: "已被改动·请你确认",
        hint: "你批注的那段原文已经不在了。是不是照你说的改的,系统不替你判断,请回到原位看一眼。" }
    : { tone: "waiting", text: "已提交" };
}

function deliveryText(item: Annotation, archival = false): string {
  if (routeOf(item) === "memory") return "已记为记忆，不发给任何人";
  if (item.status === "verified") {
    return item.verified_by && item.verified_by !== item.author
      ? `管理员 ${item.verified_by} 代确认`
      : "意见作者已确认";
  }
  if (item.status !== "sent") return archival ? "交付后记录" : "尚未提交";
  if (item.sent_via === "owner_pending") {
    return routeOf(item) === "owner_reply" ? "已交给责任人答复" : "已交给责任人决策";
  }
  if (item.sent_via === "decision") return "通过审批提交";
  if (item.sent_via === "pipeline_evidence") return "作为流水线证据提交";
  if (item.sent_via === "review_repair") return "已交给当前 MR 的修复 Agent";
  return "执行中发送";
}

export function AnnotationPanel({
  taskId,
  viewerUsername,
  items,
  checks,
  reply,
  canOperate,
  canRouteOthers = false,
  canOverride = false,
  taskStatus,
  reviewReady = false,
  reviewAnnotationIds = [],
  requirementReview = false,
  requirementRevisionRunning = false,
  mergeRequestOpen,
  evidenceAwaiting = false,
  filter = "all",
  onChanged,
  onLocate,
}: {
  /** 抽屉顶部筛选条选中的档;非 all 时只列该档的批注。 */
  filter?: ReviewFilter;
  taskId: string;
  viewerUsername: string;
  items: Annotation[];
  checks: AnchorCheck[];
  /** 旧任务的总体回复兼容展示；新检视以每条 response 为权威。 */
  reply?: { texts: string[]; truncated: boolean };
  canOperate: boolean;
  /** 任务责任人可以原样转交他人的草稿；不因此获得编辑或闭环权。 */
  canRouteOthers?: boolean;
  /** 管理员应急旁路:作者不在场时可代删/代确认,服务端会记录操作人。 */
  canOverride?: boolean;
  /** 点一条回到材料里那一行——改批注前人几乎总要再看一眼上下文。 */
  onLocate?: (item: Annotation) => void;
  taskStatus: TaskStatus;
  /** 人工意见修复与 Build-Fix 都已完成，当前真的轮到意见作者裁决。 */
  reviewReady?: boolean;
  /** 当前工作区复检仍待闭环的意见 ID；缺席时管理员旁路按关闭处理。 */
  reviewAnnotationIds?: readonly string[];
  /** 需求确认卡中的批注会立即驱动 Agent 修改当前需求正本。 */
  requirementReview?: boolean;
  /** Agent 正在修改需求时禁止重复提交同一批草稿。 */
  requirementRevisionRunning?: boolean;
  /** MR 已创建且未合入/关闭：没有活会话也能开启下一轮 review 修复。 */
  mergeRequestOpen: boolean;
  /** 流水线缺具体报错时，批注直接回灌证据并自动恢复，不需要活会话。 */
  evidenceAwaiting?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [mutationBusy, setMutationBusy] = useState("");
  const [replyingId, setReplyingId] = useState("");
  const [ownerReply, setOwnerReply] = useState("");
  const [error, setError] = useState("");
  const [overrideArm, setOverrideArm] = useState<AdminOverrideArm>();
  // 每个人只提交自己的草稿。其他人的草稿既不应被代交，也不能成为
  // 暗中锁住任务的全局门禁。
  const drafts = items.filter((item) =>
    item.status === "draft" && item.author === viewerUsername);
  const routedDrafts = items.filter((item) =>
    item.status === "draft" && item.author !== viewerUsername
    && canRouteOthers && !["completed", "canceled"].includes(taskStatus)
    && (routeOf(item) === "agent" || item.assignee === viewerUsername));
  const overrideReviewCount = items.filter((item) => adminOverrideAccess({
    item,
    viewerUsername,
    canOverride,
    reviewReady,
    reviewAnnotationIds,
  }).canDrop).length;
  const ordinaryReviewCount = items.filter((item) =>
    item.author === viewerUsername
    && authorVerdictReady(item, taskStatus, reviewReady)
    && routeOf(item) !== "owner_reply"
    && item.sent_via !== "review_repair").length;
  const ownerReplyReviewCount = items.filter((item) =>
    item.author === viewerUsername
    && routeOf(item) === "owner_reply"
    && authorVerdictReady(item, taskStatus, reviewReady)).length;
  const authorActionable = (item: Annotation) => item.author === viewerUsername
    && authorVerdictReady(item, taskStatus, reviewReady);
  const overrideActionable = (item: Annotation) => adminOverrideAccess({
    item,
    viewerUsername,
    canOverride,
    reviewReady,
    reviewAnnotationIds,
  }).canVerify;
  const authorActionableCount = items.filter(authorActionable).length;
  const overrideActionableCount = items.filter((item) =>
    !authorActionable(item) && overrideActionable(item)).length;
  const actionableReviewCount = authorActionableCount + overrideActionableCount
    + routedDrafts.length;
  const currentReviewIds = new Set(reviewAnnotationIds);
  const missingReceiptCount = reviewReady ? items.filter((item) =>
    currentReviewIds.has(item.id)
    && item.status === "sent"
    && item.author === viewerUsername
    && item.response?.revision !== (item.rework ?? 0)).length : 0;
  // 真正要人操作的卡永远置顶；保留原始顺序作为同优先级内的稳定顺序。
  // 过去提示在顶端、按钮却埋在历史记录中，用户会合理地认为按钮丢了。
  const orderedItems = items.map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftActionable = authorActionable(left.item)
        || overrideActionable(left.item) || routedDrafts.includes(left.item);
      const rightActionable = authorActionable(right.item)
        || overrideActionable(right.item) || routedDrafts.includes(right.item);
      if (leftActionable !== rightActionable) return rightActionable ? 1 : -1;
      const leftCurrent = currentReviewIds.has(left.item.id);
      const rightCurrent = currentReviewIds.has(right.item.id);
      if (leftCurrent !== rightCurrent) return rightCurrent ? 1 : -1;
      return left.index - right.index;
    }).map(({ item }) => item);
  const visibleItems = filter === "all" ? orderedItems : orderedItems.filter(
    (item) => annotationCategory(item, {
      viewerUsername, taskStatus, reviewReady, canOverride, canRouteOthers,
      reviewAnnotationIds,
    }) === filter);
  // 默认展开。"只在有草稿/待办时才展开"是它还嵌在侧栏里时的省地方策略;
  // 现在它是「批注与检视」弹层的正文,人点开弹层就是来看批注的,再让人
  // 多点一下标题才见内容,用户实锤"为啥默认折叠"。
  const [open, setOpen] = useState(true);
  const running = taskStatus === "running";
  const reviewSendable = mergeRequestOpen && [
    "queued", "running", "verifying", "await_merge", "failed",
  ].includes(taskStatus);
  // 等决定期间也能提交:服务端把意见先记成团队事实(阻塞放行),正文
  // 随下一次决定送达。检视人(批注作者≠决定人)在这窗口里从此有合法
  // 路径,不再依赖"责任人替你带上"的假承诺(MFC-022)。
  const queueable = taskStatus === "waiting_for_human";
  const canSend = !requirementRevisionRunning
    && (running || evidenceAwaiting || reviewSendable || queueable);
  const reviewScopeKey = (reviewReady ? "ready:" : "closed:")
    + reviewAnnotationIds.join("\u0000");

  useEffect(() => {
    if (drafts.length > 0 || actionableReviewCount > 0
        || missingReceiptCount > 0) {
      setOpen(true);
    }
  }, [drafts.length, actionableReviewCount, missingReceiptCount]);

  useEffect(() => {
    setOverrideArm(undefined);
  }, [taskId, reviewScopeKey]);

  useEffect(() => {
    if (!overrideArm) return;
    const timer = window.setTimeout(() => setOverrideArm(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [overrideArm]);

  if (!items.length) return null;
  const checkOf = (id: string) => checks.find((check) => check.id === id);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await sendAnnotations(taskId,
        drafts.map((item) => item.id));
      if (result.error) setError(result.error);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "批注提交失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function mutateAnnotation(
    annotationId: string,
    operation: () => Promise<{ error?: string }>,
  ) {
    if (mutationBusy) return;
    setMutationBusy(annotationId);
    setError("");
    try {
      const result = await operation();
      if (result.error) setError(result.error);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationBusy("");
      setOverrideArm(undefined);
    }
  }

  async function requestAdminOverride(
    item: Annotation,
    action: AdminOverrideAction,
  ) {
    const access = adminOverrideAccess({
      item,
      viewerUsername,
      canOverride,
      reviewReady,
      reviewAnnotationIds,
    });
    if (action === "drop" ? !access.canDrop : !access.canVerify) {
      setOverrideArm(undefined);
      setError("这条意见已不属于当前复检，管理员代办已取消；请刷新后再检查。");
      return;
    }
    const next = advanceAdminOverrideArm(overrideArm, item.id, action);
    setOverrideArm(next.arm);
    if (!next.execute) return;
    await mutateAnnotation(item.id, action === "drop"
      ? () => dropAnnotation(taskId, item.id)
      : () => judgeAnnotation(taskId, item.id, "verify"));
  }

  async function submitOwnerReply(item: Annotation, retryText?: string) {
    const text = (retryText ?? ownerReply).trim();
    if (!text || mutationBusy) return;
    setMutationBusy(item.id);
    setError("");
    try {
      const result = await replyToAnnotation(taskId, item.id, text);
      if (result.error) setError(result.error);
      else {
        setReplyingId("");
        setOwnerReply("");
      }
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationBusy("");
    }
  }

  async function routeDraftToAgent(item: Annotation) {
    await mutateAnnotation(item.id, async () => {
      const result = await sendAnnotations(taskId, [item.id]);
      return { error: result.error };
    });
  }

  return (
    <details className="annot-panel" aria-label="批注" open={open}
             onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="annot-panel-head">
        <div>
          {/* 三节同一口径:来自 Cloud 工作台 / 来自 CodeHub / 来自流水线与
              机器门禁。原来只叫"批注",和第二节并排时读不出它就是"Cloud
              平台上的检视意见"(用户实锤)。 */}
          <span>CLOUD WORKSPACE REVIEW</span>
          <strong>来自 Cloud 工作台的检视意见</strong>
        </div>
        <div className="annot-panel-summary-side">
          <div className="annot-panel-counts">
            <span>{items.length} 条</span>
            {drafts.length > 0 && <em>{drafts.length} 条
              {taskStatus === "completed" ? "交付后记录" : "待提交"}</em>}
          </div>
          <i className="annot-panel-chevron" aria-hidden />
        </div>
      </summary>
      {reviewReady && authorActionableCount > 0 && (
        <div className="annot-panel-note review-ready" role="status">
          Agent 已处理你提出的 {authorActionableCount} 条意见，Build-Fix 也已通过。
          请看最新代码后，逐条选择“确认已修复”或“仍需调整”；没有全部闭环前不会推送。
        </div>
      )}
      {reviewReady && missingReceiptCount > 0 && (
        <div className="annot-panel-note receipt-pending" role="alert">
          另有 {missingReceiptCount} 条意见的当前轮逐条回执尚未就绪，暂不能确认。
          系统会保留这些意见并阻止推送；刷新后仍未恢复时，请查看执行现场中的回执诊断。
        </div>
      )}
      {ordinaryReviewCount > 0 && (
        <div className="annot-panel-note review-ready" role="status">
          Agent 已再次回到人工检视。请核对最新材料后，逐条选择
          “确认已修复”或“仍需调整”；没有全部闭环前不会继续。
        </div>
      )}
      {ownerReplyReviewCount > 0 && (
        <div className="annot-panel-note review-ready" role="status">
          责任人已答复你提出的 {ownerReplyReviewCount} 条意见。
          请核对原文和答复，逐条选择“确认已解答”或“仍有疑问”。
        </div>
      )}
      {overrideReviewCount > 0 && (
        <div className="annot-panel-note admin-override" role="note">
          当前复检有 {overrideReviewCount} 条他人意见仍待作者闭环。
          仅在作者不在场时使用管理员代办；第一次点击只会进入确认，
          必须再次点击才会执行，结果会显示实际管理员。
        </div>
      )}
      {actionableReviewCount > 0 && (
        <div className="annot-review-queue" role="heading" aria-level={3}>
          <div><strong>{routedDrafts.length ? "待我处理" : "待我确认"}</strong>
            <span>先逐条核对，再做整体交付决定</span></div>
          <em>{actionableReviewCount} 项</em>
        </div>
      )}
      {canOperate && drafts.length > 0 && canSend && (
        <div className="annot-panel-actions">
          <button type="button" className="primary" disabled={busy}
                  onClick={() => void send()}>
            {busy ? "提交中…" : drafts.every((item) => routeOf(item) === "owner_reply")
              ? `提交 ${drafts.length} 条给责任人答复`
              : drafts.every((item) => routeOf(item) === "owner_decision")
                ? `提交 ${drafts.length} 条给责任人决策`
              : drafts.some((item) => routeOf(item) !== "agent")
                ? `提交 ${drafts.length} 条检视意见`
              : reviewSendable
              ? `提交 ${drafts.length} 条并继续修改`
              : evidenceAwaiting ? `回灌 ${drafts.length} 条报错`
                : requirementReview ? `提交 ${drafts.length} 条给 Agent 修改需求`
                : queueable ? `提交 ${drafts.length} 条（随决定送达）`
                : `提交 ${drafts.length} 条批注`}
          </button>
          {reviewSendable && (
            <p>继续使用当前分支和 MR；Agent 修改并提交后，系统会重新跑验证。MR 合入前可以反复提交。</p>
          )}
          {queueable && !reviewSendable && (
            <p>{requirementReview
              ? "Agent 会按这些意见修改当前需求文档；完成后请在本工作台逐条复检，全部闭环后再确认进入需求分析。"
              : "任务正等一张决定卡。提交后意见立即成为待闭环事实（阻止直接放行），正文会随下一次决定一起交给 Agent。"}</p>
          )}
        </div>
      )}

      {drafts.length > 0 && taskStatus === "completed" && (
        <p className="annot-panel-note">
          任务已经交付；这些批注已保存在本任务档案中，不会自动触发修改。
          需要继续改代码时，请创建后续任务。
        </p>
      )}
      {drafts.length > 0 && taskStatus === "canceled" && (
        <p className="annot-panel-note">
          任务已由用户停止；已有批注仍保留，但不会再触发修改。
        </p>
      )}
      {!canOperate && drafts.length > 0
        && !["completed", "canceled"].includes(taskStatus) && (
        <p className="annot-panel-note">
          批注已保存在你的清单中。你目前只有记录权限；成为受邀协作者或本次检视人后，
          才能提交给 Agent。
        </p>
      )}
      {canOperate && drafts.length > 0 && !canSend
        && !["completed", "canceled"].includes(taskStatus) && (
        <p className="annot-panel-note">
          {requirementRevisionRunning
            ? "Agent 正在根据上一批检视意见修改需求文档；完成后即可继续提交。"
            : taskStatus === "paused" || taskStatus === "pausing"
              ? `有 ${drafts.length} 条批注已保存。恢复任务后即可交给 Agent 继续修改。`
              : mergeRequestOpen === false && taskStatus === "await_merge"
                    ? "MR 当前已关闭。批注已经保存；重新打开 MR 后即可继续提交修改。"
                : `有 ${drafts.length} 条批注待提交；当前没有可接收意见的执行会话。`}
        </p>
      )}
      {error && <div className="alert">{error}</div>}

      {filter !== "all" && !visibleItems.length && items.length > 0 && (
        <p className="annot-panel-note">这一档下没有批注；切回“全部”看完整清单。</p>
      )}
      <ol className="annot-list">
        {visibleItems.map((item) => {
          const check = checkOf(item.id);
          const archival = taskStatus === "completed"
            && item.status === "draft";
          const isAuthor = item.author === viewerUsername;
          const editing = editingId === item.id;
          const overrideAccess = adminOverrideAccess({
            item,
            viewerUsername,
            canOverride,
            reviewReady,
            reviewAnnotationIds,
          });
          const dropArmed = overrideArm?.annotationId === item.id
            && overrideArm.action === "drop";
          const verifyArmed = overrideArm?.annotationId === item.id
            && overrideArm.action === "verify";
          const authorCanJudge = isAuthor
            && authorVerdictReady(item, taskStatus, reviewReady);
          const actionable = authorCanJudge || overrideAccess.canVerify;
          const progress = progressOf(item, check, archival, actionable);
          return (
            <li key={item.id}
                className={`annot-item ${progress.tone}${actionable
                  ? " actionable" : ""}`}>
              <div className="annot-item-head">
                <button type="button" className="annot-where"
                        onClick={() => onLocate?.(item)}
                        title={`回到 ${item.file}:${check?.line ?? item.line}`}>
                  {/* 需求原文是虚拟产物,内部名 __task_requirement__ 不该露给人
                      (2026-09-02 演示截图逮住)。 */}
                  <code>{item.file === TASK_REQUIREMENT_ARTIFACT
                    ? "需求原文" : shortPath(item.file)}:{check?.line ?? item.line}{
                      item.line_end && item.line_end > item.line ? `–${item.line_end}` : ""}</code>
                </button>
                {/* 锚定原文接在位置后面收一行:它是"这条批注指着哪儿"的补充,
                    不是内容本身。原来它单占左栏一整块,把批注正文和 Agent
                    回应挤成两条窄柱(用户实测:760px 抽屉里两栏只剩 304 和
                    357)。整段仍在 title 里,点位置也能直接回到那一行。 */}
                {(item.quote || item.anchor) && <blockquote
                  className={`annot-anchor${item.quote ? " has-quote" : ""}`}
                  title={item.quote ?? item.anchor}>
                  {item.quote ?? item.anchor}
                </blockquote>}
                <span className={`annot-progress ${progress.tone}`}
                      title={progress.hint}>
                  {progress.text}
                </span>
              </div>
              <div className={`annot-route-badge ${routeOf(item)}`}>
                {ROUTE_LABEL[routeOf(item)]}
                {routeOf(item) !== "agent" && item.assignee
                  ? ` · ${item.assignee}` : ""}
              </div>
              {editing ? (
                <div className="annot-inline-editor">
                  <textarea value={editingNote} autoFocus rows={5}
                            aria-label="修改批注意见"
                            onChange={(event) => setEditingNote(event.target.value)} />
                  <div>
                    <span>{item.status === "draft"
                      ? archival
                        ? "保存后仍作为交付后记录保留。"
                        : "保存后仍在待提交清单中。"
                      : taskStatus === "completed"
                        ? "修改后会成为交付后记录，不会再次送给 Agent。"
                        : "修改后会回到待提交，避免新内容被误认为已经送达。"}</span>
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => { setEditingId(""); setEditingNote(""); }}>
                      取消
                    </button>
                    <button type="button" className="primary"
                            disabled={!editingNote.trim() || !!mutationBusy}
                            onClick={async () => {
                              setMutationBusy(item.id);
                              setError("");
                              const result = await editAnnotation(
                                taskId, item.id, editingNote);
                              setMutationBusy("");
                              if (result.error) setError(result.error);
                              else { setEditingId(""); setEditingNote(""); }
                              onChanged();
                            }}>
                      {mutationBusy === item.id ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              ) : (
                // 左边这块原来是一段裸文字,右边 Agent 回应却是带标题的
                // 色块,看上去像"正文 vs 卡片"而不是"一问一答"。给它同样
                // 的块形和标题,明说这是检视意见原文,两边才对得起来。
                <div className="annot-note">
                  <strong>检视意见原文</strong>
                  <p>{item.note || "（只记了原文，没另写一句）"}</p>
                  {/* 追问留档:作者已经补充过什么问题,人和 Agent 看到的是同一份历史。 */}
                  {item.clarifications?.length ? <small className="annot-clarified">
                    已答复 Agent 的追问：{item.clarifications.at(-1)!.question}
                  </small> : null}
                </div>
              )}
              {item.response && (
                <div className={`annot-response ${item.response.outcome}`}>
                  <strong>{item.response.outcome === "fixed"
                    ? "Agent：已处理"
                    : item.response.outcome === "not_fixed"
                      ? "Agent：没有修改"
                      : "Agent：需要你补充说明"}</strong>
                  <p>{item.response.summary}</p>
                  {item.response.evidence.length > 0 && (
                    <small>依据：{item.response.evidence.join("；")}</small>
                  )}
                  {item.response.fixed_sha && (
                    <small>对应提交：{item.response.fixed_sha.slice(0, 12)}</small>
                  )}
                </div>
              )}
              {item.owner_reply && (
                <div className="annot-owner-reply">
                  <strong>责任人答复</strong>
                  <p>{item.owner_reply.text}</p>
                  <small>{item.owner_reply.author} · {relativeTime(item.owner_reply.replied_at)}</small>
                </div>
              )}
              {item.status === "draft" && !isAuthor && canRouteOthers
                && routeOf(item) === "agent" && (
                <div className="annot-owner-reply-action">
                  <button type="button" className="primary"
                    disabled={!canSend || !!mutationBusy}
                    title={canSend ? undefined : "当前没有可接收意见的执行会话"}
                    onClick={() => void routeDraftToAgent(item)}>
                    {mutationBusy === item.id ? "转交中…" : "原样交给 Agent"}
                  </button>
                </div>
              )}
              {item.status === "sent" && routeOf(item) === "owner_decision"
                && item.owner_reply && item.sent_via === "owner_pending"
                && item.assignee === viewerUsername && (
                <div className="annot-owner-reply-action">
                  <button type="button" className="primary"
                    disabled={!!mutationBusy}
                    onClick={() => {
                      void submitOwnerReply(item, item.owner_reply?.text);
                    }}>
                    {mutationBusy === item.id ? "继续中…" : "继续交给 Agent"}
                  </button>
                </div>
              )}
              {(item.status === "sent" || (item.status === "draft"
                  && canRouteOthers
                  && !["completed", "canceled"].includes(taskStatus)))
                && routeOf(item) !== "agent"
                && !item.owner_reply && item.assignee === viewerUsername && (
                replyingId === item.id ? (
                  <div className="annot-owner-reply-editor">
                    <textarea rows={3} autoFocus value={ownerReply}
                      placeholder={routeOf(item) === "owner_decision"
                        ? "写下明确决定；提交后系统会交给 Agent 执行"
                        : "直接回答检视人的问题"}
                      onChange={(event) => setOwnerReply(event.target.value)} />
                    <div>
                      <button type="button" className="ghost"
                        onClick={() => { setReplyingId(""); setOwnerReply(""); }}>
                        取消
                      </button>
                      <button type="button" className="primary"
                        disabled={!ownerReply.trim() || !!mutationBusy}
                        onClick={() => void submitOwnerReply(item)}>
                        {mutationBusy === item.id ? "提交中…"
                          : routeOf(item) === "owner_decision"
                            ? "提交决定并交给 Agent" : "提交答复"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="annot-owner-reply-action">
                    <button type="button" className="primary"
                      onClick={() => { setReplyingId(item.id); setOwnerReply(""); }}>
                      {routeOf(item) === "owner_decision" ? "作出决定" : "回答这条意见"}
                    </button>
                  </div>
                )
              )}
              <div className="annot-item-foot">
                <small>
                  {deliveryText(item, archival)} · 批注作者 {item.author} · {relativeTime(item.created_at)}
                  {item.sent_by && item.sent_by !== item.author
                    && ` · 由 ${item.sent_by} 原样转交`}
                  {item.edited_at && " · 已编辑"}
                  {/* 记忆条目是快照,不参与重锚定:原文以后变了也不追。 */}
                  {check && check.state !== "hit" && routeOf(item) !== "memory"
                    && ` · ${ANCHOR_TEXT[check.state]}`}
                </small>
                {/* 记忆没有编辑面:改就是再圈一次;撤回在「本任务知识」里。
                    这里的编辑/删除只改批注台账,记忆不会跟着变,露出来就是骗人。 */}
                {routeOf(item) !== "memory"
                  && (isAuthor || overrideAccess.canDrop) && !editing && (
                  <span className="annot-owner-actions">
                    {isAuthor && <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => {
                              setEditingId(item.id);
                              setEditingNote(item.note);
                            }}>编辑</button>}
                    {isAuthor ? (
                      <button type="button" className="ghost danger"
                              disabled={!!mutationBusy}
                              onClick={() => void mutateAnnotation(item.id,
                                () => dropAnnotation(taskId, item.id))}>
                        删除
                      </button>
                    ) : (
                      <>
                        <button type="button" className="ghost danger"
                                aria-pressed={dropArmed}
                                title={dropArmed
                                  ? `再次点击后，将由 ${viewerUsername} 代 ${item.author} 删除`
                                  : `先进入确认，再由 ${viewerUsername} 代 ${item.author} 删除`}
                                disabled={!!mutationBusy}
                                onClick={() => void requestAdminOverride(item, "drop")}>
                          {dropArmed ? "再次点击确认代删" : "管理员代删"}
                        </button>
                        {dropArmed && (
                          <button type="button" className="ghost"
                                  disabled={!!mutationBusy}
                                  onClick={() => setOverrideArm(undefined)}>
                            取消代办
                          </button>
                        )}
                      </>
                    )}
                  </span>
                )}
                {/* 检视闭环的裁决:提过的意见不能停在"请你确认"没有下文。
                    通过=收口;返工=退回待提交,下一次提交再送给 AI。 */}
                {item.status === "sent" && isAuthor && !editing
                  && authorCanJudge
                  && item.response?.outcome === "needs_clarification" && (
                  <span className="annot-verdict">
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => {
                              setEditingId(item.id);
                              setEditingNote(item.note);
                            }}>补充说明后重提</button>
                  </span>
                )}
                {item.status === "sent"
                  && (authorCanJudge || overrideAccess.canVerify) && !editing
                  && item.response?.outcome !== "needs_clarification" && (
                  <span className="annot-verdict">
                    {isAuthor && <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => void mutateAnnotation(item.id,
                              () => judgeAnnotation(taskId, item.id, "reopen"))}>
                      {routeOf(item) === "owner_reply" ? "仍有疑问" : "仍需调整"}
                    </button>}
                    {isAuthor ? (
                      <button type="button" className="approve"
                              disabled={!!mutationBusy}
                              onClick={() => void mutateAnnotation(item.id,
                                () => judgeAnnotation(taskId, item.id, "verify"))}>
                        {routeOf(item) === "owner_reply" ? "确认已解答" : "确认已修复"}
                      </button>
                    ) : (
                      <>
                        <button type="button" className="approve"
                                aria-pressed={verifyArmed}
                                title={verifyArmed
                                  ? `再次点击后，将由 ${viewerUsername} 代 ${item.author} 确认`
                                  : `先进入确认，再由 ${viewerUsername} 代 ${item.author} 确认`}
                                disabled={!!mutationBusy}
                                onClick={() => void requestAdminOverride(item, "verify")}>
                          {verifyArmed ? "再次点击确认代确认" : "管理员代确认"}
                        </button>
                        {verifyArmed && (
                          <button type="button" className="ghost"
                                  disabled={!!mutationBusy}
                                  onClick={() => setOverrideArm(undefined)}>
                            取消代办
                          </button>
                        )}
                      </>
                    )}
                  </span>
                )}
              </div>
              {/* 靶子变了要说清:意见可能已经过期,送过去轻则白烧一轮,
                  重则让它改回去。撤不撤是人的判断,这里只把事实摊开。 */}
              {item.status === "draft" && check?.state === "gone" && (
                <div className="annot-stale">
                  原位置内容已经删除{check.now ? `，当前位置内容为「${check.now}」` : ""}。
                  请确认这条批注是否仍然有效。
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* AI 收到批注后的原话。护栏要求它逐条回复"改了什么/为什么不改",
          那段话原来只躺在会话流里——不同意的批注在面板上就永远停在
          "已提交",人干等一个不会来的改动。这里原样摆出来,对应关系
          人自己看:从自由文本里猜"第几段对第几条",配错了更害人。 */}
      {reply && reply.texts.length > 0 && (
        <details className="annot-reply">
          <summary>送出之后 AI 说了什么({reply.texts.length} 段)</summary>
          <p className="annot-reply-note">
            原话未做逐条对应,请对照各条自行核对;不服就点那条的「返工」。
          </p>
          {reply.texts.map((text, at) => (
            <blockquote key={at}>{text}</blockquote>
          ))}
          {reply.truncated && <p className="annot-reply-note">(太长截断,完整内容见“执行现场”)</p>}
        </details>
      )}
    </details>
  );
}
