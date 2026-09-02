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
  sendAnnotations,
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
  if (taskStatus !== "waiting_for_human" || item.status !== "sent") {
    return false;
  }
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
  if (item.status === "verified") {
    return item.verified_by && item.verified_by !== item.author
      ? `管理员 ${item.verified_by} 代确认`
      : "意见作者已确认";
  }
  if (item.status !== "sent") return archival ? "交付后记录" : "尚未提交";
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
  canOverride = false,
  taskStatus,
  reviewReady = false,
  reviewAnnotationIds = [],
  requirementReview = false,
  requirementRevisionRunning = false,
  mergeRequestOpen,
  evidenceAwaiting = false,
  onChanged,
  onLocate,
}: {
  taskId: string;
  viewerUsername: string;
  items: Annotation[];
  checks: AnchorCheck[];
  /** 旧任务的总体回复兼容展示；新检视以每条 response 为权威。 */
  reply?: { texts: string[]; truncated: boolean };
  canOperate: boolean;
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
  const [error, setError] = useState("");
  const [overrideArm, setOverrideArm] = useState<AdminOverrideArm>();
  // 每个人只提交自己的草稿。其他人的草稿既不应被代交，也不能成为
  // 暗中锁住任务的全局门禁。
  const drafts = items.filter((item) =>
    item.status === "draft" && item.author === viewerUsername);
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
    && item.sent_via !== "review_repair").length;
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
  const actionableReviewCount = authorActionableCount + overrideActionableCount;
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
        || overrideActionable(left.item);
      const rightActionable = authorActionable(right.item)
        || overrideActionable(right.item);
      if (leftActionable !== rightActionable) return rightActionable ? 1 : -1;
      const leftCurrent = currentReviewIds.has(left.item.id);
      const rightCurrent = currentReviewIds.has(right.item.id);
      if (leftCurrent !== rightCurrent) return rightCurrent ? 1 : -1;
      return left.index - right.index;
    }).map(({ item }) => item);
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
      {overrideReviewCount > 0 && (
        <div className="annot-panel-note admin-override" role="note">
          当前复检有 {overrideReviewCount} 条他人意见仍待作者闭环。
          仅在作者不在场时使用管理员代办；第一次点击只会进入确认，
          必须再次点击才会执行，结果会显示实际管理员。
        </div>
      )}
      {actionableReviewCount > 0 && (
        <div className="annot-review-queue" role="heading" aria-level={3}>
          <div><strong>待我确认</strong><span>先逐条核对，再做整体交付决定</span></div>
          <em>{actionableReviewCount} 项</em>
        </div>
      )}
      {canOperate && drafts.length > 0 && canSend && (
        <div className="annot-panel-actions">
          <button type="button" className="primary" disabled={busy}
                  onClick={() => void send()}>
            {busy ? "提交中…" : reviewSendable
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

      <ol className="annot-list">
        {orderedItems.map((item) => {
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
                  <code>{shortPath(item.file)}:{check?.line ?? item.line}</code>
                </button>
                <span className={`annot-progress ${progress.tone}`}
                      title={progress.hint}>
                  {progress.text}
                </span>
              </div>
              {editing ? (
                <div className="annot-inline-editor">
                  <textarea value={editingNote} autoFocus rows={3}
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
              ) : <p className="annot-note">{item.note}</p>}
              <blockquote className="annot-anchor"><span>针对</span>{item.anchor}</blockquote>
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
              <div className="annot-item-foot">
                <small>
                  {deliveryText(item, archival)} · 批注作者 {item.author} · {relativeTime(item.created_at)}
                  {item.edited_at && " · 已编辑"}
                  {check && check.state !== "hit"
                    && ` · ${ANCHOR_TEXT[check.state]}`}
                </small>
                {(isAuthor || overrideAccess.canDrop) && !editing && (
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
                      仍需调整
                    </button>}
                    {isAuthor ? (
                      <button type="button" className="approve"
                              disabled={!!mutationBusy}
                              onClick={() => void mutateAnnotation(item.id,
                                () => judgeAnnotation(taskId, item.id, "verify"))}>
                        确认已修复
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
