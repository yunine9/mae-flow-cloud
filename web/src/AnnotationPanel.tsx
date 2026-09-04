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

import { useEffect, useRef, useState } from "react";
import {
  dropAnnotation,
  editAnnotation,
  judgeAnnotation,
  replyToAnnotation,
  sendAnnotations,
  decide,
  TASK_REQUIREMENT_ARTIFACT,
  type Annotation,
  type AnchorCheck,
  type AnnotationClosure,
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

/** 批注与检视抽屉顶部筛选条的三档:等我确认 / 处理与验证 / 已闭环。
 * 批注、CodeHub 意见、机器告警三节共用,人一眼看到"此刻压在我这的有几条"。 */
export type ReviewFilter = "all" | "mine" | "agent" | "closed";

/** 账号是权限主键，不是给人看的称呼；没有配置姓名时才退回账号。 */
export function displayPersonName(
  username: string,
  people: readonly { username: string; display_name?: string }[] = [],
): string {
  return people.find((person) => person.username === username)
    ?.display_name?.trim() || username;
}

export function AnnotationPanel({
  taskId,
  viewerUsername,
  items,
  checks,
  closures,
  reply,
  canOperate,
  taskStatus,
  reviewReady = false,
  reviewAnnotationIds = [],
  requirementReview = false,
  requirementRevisionRunning = false,
  mergeRequestOpen,
  evidenceAwaiting = false,
  filter = "all",
  focus,
  people = [],
  reworkChoice,
  canDecide = false,
  onChanged,
  onLocate,
}: {
  /** 当前决定卡上"需要调整"那一项。有它且 canDecide 时,提交就是一步到位
   * 的"提交并返工"——直接以这个选项提交决定卡,意见随之送给 Agent。 */
  reworkChoice?: {
    waitingId: string;
    stateVersion: number;
    question: string;
    option: string;
  };
  /** 提交人就是决定人(责任人/管理员)。检视人不是,只能排队等责任人返工。 */
  canDecide?: boolean;
  /** 抽屉顶部筛选条选中的档;非 all 时只列该档的批注。 */
  filter?: ReviewFilter;
  /** 从文档/代码行反向定位过来；request 保证连续点同一行也会重新闪。 */
  focus?: { ids: readonly string[]; request: number };
  /** 平台账号到显示姓名的窄视图；权限判断始终仍使用稳定账号。 */
  people?: readonly { username: string; display_name?: string }[];
  taskId: string;
  viewerUsername: string;
  items: Annotation[];
  checks: AnchorCheck[];
  /** 每条意见此刻的处境:服务端 feedbackPolicy 算好的唯一结论。
   * 页面只渲染 text/hint、只按 can_* 开按钮,不再自己推。 */
  closures: readonly AnnotationClosure[];
  /** 旧任务的总体回复兼容展示；新检视以每条 response 为权威。 */
  reply?: { texts: string[]; truncated: boolean };
  canOperate: boolean;
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
  const listRef = useRef<HTMLOListElement>(null);
  const personName = (username: string) => displayPersonName(username, people);
  // 结论按 id 取。服务端为每条可见意见都下发一条;真缺了就当"还在
  // 处理"(不可操作),绝不在这里补一套推断把不一致藏起来。
  const closureMap = new Map(closures.map((one) => [one.id, one]));
  const closureOf = (item: Annotation): AnnotationClosure =>
    closureMap.get(item.id) ?? {
      id: item.id, tone: "waiting", text: "处理中", bucket: "agent",
      delivery_text: "", verdict_ready: false, actionable: false,
      can_verify: false, can_override_verify: false,
      can_override_drop: false, can_route: false,
      needs_clarification: false, receipt_missing: false,
    };
  // 每个人只提交自己的草稿。其他人的草稿既不应被代交，也不能成为
  // 暗中锁住任务的全局门禁。
  const drafts = items.filter((item) =>
    item.status === "draft" && item.author === viewerUsername);
  const routedDrafts = items.filter((item) => closureOf(item).can_route);
  const overrideReviewCount = items.filter((item) =>
    closureOf(item).can_override_drop).length;
  const ordinaryReviewCount = items.filter((item) =>
    closureOf(item).can_verify
    && routeOf(item) !== "owner_reply"
    && item.sent_via !== "review_repair").length;
  const ownerReplyReviewCount = items.filter((item) =>
    closureOf(item).can_verify && routeOf(item) === "owner_reply").length;
  const authorActionable = (item: Annotation) => closureOf(item).can_verify;
  const overrideActionable = (item: Annotation) =>
    closureOf(item).can_override_verify;
  const authorActionableCount = items.filter(authorActionable).length;
  const overrideActionableCount = items.filter((item) =>
    !authorActionable(item) && overrideActionable(item)).length;
  const actionableReviewCount = authorActionableCount + overrideActionableCount
    + routedDrafts.length;
  const currentReviewIds = new Set(reviewAnnotationIds);
  const missingReceiptCount = items.filter((item) =>
    closureOf(item).receipt_missing).length;
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
  const visibleItems = filter === "all" ? orderedItems
    : orderedItems.filter((item) => closureOf(item).bucket === filter);
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
  // 责任人自己提意见时,"抽屉里提交、再回卡上选返工"是同一个意图拆成两步
  // (内网实锤:点了"提交给 Agent"以为送到了,其实要点返工才送)。决定人
  // 在这里直接以返工选项提交决定卡,一步到位;检视人仍走排队。
  const oneStepRework = queueable && !requirementReview && canDecide
    && !!reworkChoice;
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

  useEffect(() => {
    if (!focus?.ids.length) return;
    setOpen(true);
    let secondFrame = 0;
    let clearTimer = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const wanted = new Set(focus.ids);
        const matches = [...(listRef.current
          ?.querySelectorAll<HTMLElement>("[data-annotation-id]") ?? [])]
          .filter((node) => wanted.has(node.dataset.annotationId ?? ""));
        if (!matches.length) return;
        matches.forEach((node) => node.classList.add("annot-panel-focus"));
        matches[0].scrollIntoView({ block: "center", behavior: "smooth" });
        matches[0].focus({ preventScroll: true });
        clearTimer = window.setTimeout(() => matches.forEach((node) =>
          node.classList.remove("annot-panel-focus")), 1800);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [focus?.request, filter]);

  if (!items.length) return null;
  const checkOf = (id: string) => checks.find((check) => check.id === id);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (oneStepRework && reworkChoice) {
        // 服务端 decide 会把本人全部草稿 + 等待期排队的意见一并渲进
        // 决定正文,再 resume Agent——和在卡上手点"需要调整"完全同一条路。
        const result = await decide(taskId, reworkChoice.stateVersion,
          { [reworkChoice.question]: reworkChoice.option }, {}, undefined,
          drafts.map((item) => item.id), undefined, undefined, undefined,
          undefined, reworkChoice.waitingId);
        if (result.conflict) setError(result.conflict);
      } else {
        const result = await sendAnnotations(taskId,
          drafts.map((item) => item.id));
        if (result.error) setError(result.error);
      }
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
    const access = closureOf(item);
    if (action === "drop"
      ? !access.can_override_drop : !access.can_override_verify) {
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
            {busy ? "提交中…"
              : oneStepRework ? `提交 ${drafts.length} 条并返工`
              : drafts.every((item) => routeOf(item) === "owner_reply")
              ? `提交 ${drafts.length} 条给责任人答复`
              : drafts.every((item) => routeOf(item) === "owner_decision")
                ? `提交 ${drafts.length} 条给责任人决策`
              : drafts.some((item) => routeOf(item) !== "agent")
                ? `提交 ${drafts.length} 条检视意见`
              : reviewSendable
              ? `提交 ${drafts.length} 条并继续修改`
              : evidenceAwaiting ? `回灌 ${drafts.length} 条报错`
                : requirementReview ? `提交 ${drafts.length} 条给 Agent 修改需求`
                : queueable ? `提交 ${drafts.length} 条（排队，等责任人返工时送达）`
                : `提交 ${drafts.length} 条批注`}
          </button>
          {reviewSendable && (
            <p>继续使用当前分支和 MR；Agent 修改并提交后，系统会重新跑验证。MR 合入前可以反复提交。</p>
          )}
          {queueable && !reviewSendable && (
            <p>{requirementReview
              ? "Agent 会按这些意见修改当前需求文档；完成后请在本工作台逐条复检，全部闭环后再确认进入需求分析。"
              : oneStepRework
                ? `会直接以「${reworkChoice!.option.replace(/[（(].*$/, "")}」提交当前决定卡，意见随之送给 Agent，不必再回卡上点返工。`
                : `任务正等一张决定卡。提交只是先登记成待闭环事实（阻止直接放行），正文要等责任人在卡上选「${reworkChoice?.option.replace(/[（(].*$/, "") ?? "需要调整"}」后才随决定送给 Agent。`}</p>
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
      <ol className="annot-list" ref={listRef}>
        {visibleItems.map((item) => {
          const check = checkOf(item.id);
          const archival = taskStatus === "completed"
            && item.status === "draft";
          const isAuthor = item.author === viewerUsername;
          const editing = editingId === item.id;
          const closure = closureOf(item);
          const dropArmed = overrideArm?.annotationId === item.id
            && overrideArm.action === "drop";
          const verifyArmed = overrideArm?.annotationId === item.id
            && overrideArm.action === "verify";
          const authorCanJudge = closure.can_verify;
          const actionable = closure.actionable;
          const progress = closure;
          return (
            <li key={item.id} data-annotation-id={item.id} tabIndex={-1}
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
                  ? ` · ${personName(item.assignee)}` : ""}
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
                  <small>{personName(item.owner_reply.author)} · {relativeTime(item.owner_reply.replied_at)}</small>
                </div>
              )}
              {closure.can_route && routeOf(item) === "agent" && (
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
              {(item.status === "sent"
                  || (item.status === "draft" && closure.can_route))
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
                  {closure.delivery_text} · 批注作者 {personName(item.author)} · {relativeTime(item.created_at)}
                  {item.sent_by && item.sent_by !== item.author
                    && ` · 由 ${personName(item.sent_by)} 原样转交`}
                  {item.edited_at && " · 已编辑"}
                  {/* 记忆条目是快照,不参与重锚定:原文以后变了也不追。 */}
                  {check && check.state !== "hit" && routeOf(item) !== "memory"
                    && ` · ${ANCHOR_TEXT[check.state]}`}
                </small>
                {/* 记忆没有编辑面:改就是再圈一次;撤回在「本任务知识」里。
                    这里的编辑/删除只改批注台账,记忆不会跟着变,露出来就是骗人。 */}
                {routeOf(item) !== "memory"
                  && (isAuthor || closure.can_override_drop) && !editing && (
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
                                  ? `再次点击后，将由 ${personName(viewerUsername)} 代 ${personName(item.author)} 删除`
                                  : `先进入确认，再由 ${personName(viewerUsername)} 代 ${personName(item.author)} 删除`}
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
                  && closure.needs_clarification && (
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
                  && (authorCanJudge || closure.can_override_verify) && !editing
                  && !closure.needs_clarification && (
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
                                  ? `再次点击后，将由 ${personName(viewerUsername)} 代 ${personName(item.author)} 确认`
                                  : `先进入确认，再由 ${personName(viewerUsername)} 代 ${personName(item.author)} 确认`}
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
