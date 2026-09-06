/**
 * push 前最终检视的纯领域规则。
 *
 * 它不认识 TaskService、Git 或页面，只判断一张授权收据是否精确覆盖
 * 此刻准备推送的 HEAD 与文件集合。第一次 push、流水线修复后的第二次
 * push、检视返工后的第三次 push 都用同一把尺：HEAD 变了就重新检视；
 * 完全相同的 HEAD 重试则幂等复用，不重复打扰人。
 */

import { createHash } from "node:crypto";

export interface PushReviewSnapshot {
  head: string;
  paths: string[];
}

export interface PushReviewReceipt {
  status: "requested" | "confirmed";
  head: string;
  paths: string[];
}

function sameOrderedValues(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** 调用方先按自己的安全规则归一化路径；这里刻意只做精确对拍。 */
export function pushReviewReceiptCovers(
  receipt: PushReviewReceipt | undefined,
  snapshot: PushReviewSnapshot,
): boolean {
  return receipt?.status === "confirmed"
    && receipt.head === snapshot.head
    && sameOrderedValues(receipt.paths, snapshot.paths);
}

/** 卡身份绑定最终 HEAD。cycleToken 只用来区分同一 HEAD 上明确打回后
 * 的下一轮复检，避免 HumanGate 复活上一张已经 resolved 的卡。 */
export function pushReviewCallId(
  snapshot: PushReviewSnapshot,
  cycleToken?: string,
): string {
  const digest = createHash("sha256")
    .update(snapshot.head)
    .update("\0")
    .update(snapshot.paths.join("\0"))
    .update(cycleToken ? `\0cycle:${cycleToken}` : "")
    .digest("hex");
  return `push-confirm-${digest.slice(0, 12)}`;
}

// ── 2026-09-06 绞杀第三块:push 前确认与交付范围的决策(从 taskService 搬来)。
// 下面全是纯函数:该不该出卡、能不能全自动续推、越界怎么算、给人看的话
// 怎么说。Git 快照、批注读取、举卡、持久化留在 TaskService 的薄壳里。
// 行为零变更;决策表见 tests/pushReviewPolicy.test.ts。

/** 脏路径给人看的形态:前几条点名,余量说总数——三万个产物文件不能
 * 整版倒进 detail,但"哪个目录在渗产物"必须一眼可见。 */
export function describeDirtyPaths(paths: string[]): string {
  const shown = paths.slice(0, 5).join("、");
  return paths.length > 5 ? `${shown} 等 ${paths.length} 个路径` : shown;
}

/** 两份已归一化的路径清单是否同一集合(调用方保证已排序去重)。 */
export function samePaths(left: string[], right: string[]): boolean {
  return sameOrderedValues(left, right);
}

export interface PushReviewPolicy {
  /** 三个来源任一成立就要人过目。 */
  required: boolean;
  /** 常规最终过目:任务级设置 > 个人默认 > 有交付清单即保守复检。 */
  ordinaryReviewEnabled: boolean;
  /** 工作台意见返工后的复检:不是按 push 次数重复问。 */
  recheckRequired: boolean;
  /** 未闭环的人工意见是安全例外,月光/全自动偏好吞不掉。 */
  hasHumanFeedback: boolean;
}

export function pushReviewPolicyFor(input: {
  reviewSource: "platform" | "workspace" | undefined;
  workspaceRecheckRequired: boolean | undefined;
  unresolvedAnnotations: number;
  taskSetting: boolean | undefined;
  /** 个人默认惰性取:任务级设置在时原来根本不查个人设置。 */
  accountDefault: () => boolean | undefined;
  hasSelection: boolean;
}): PushReviewPolicy {
  const recheckRequired = input.reviewSource === "workspace"
    && input.workspaceRecheckRequired === true;
  const hasHumanFeedback = input.unresolvedAnnotations > 0;
  const ordinaryReviewEnabled = input.taskSetting
    ?? input.accountDefault()
    ?? input.hasSelection;
  return {
    required: recheckRequired || hasHumanFeedback || ordinaryReviewEnabled,
    ordinaryReviewEnabled,
    recheckRequired,
    hasHumanFeedback,
  };
}

/** 已有交付清单、又到了推送点:精确收据放行;"全自动"只在同一文件集合
 * 内且有 Build-Fix 收据时代为确认;没收据如实停下;其余重新出卡。 */
export type SelectionPushDecision =
  | { kind: "allow" }
  | { kind: "auto_confirm"; reason: string }
  | { kind: "stall"; reason: string }
  | { kind: "recard"; reason: string };

export function selectionPushDecision(input: {
  selectionStatus: string;
  selectionHead: string | undefined;
  /** 已归一化(排序去重)的清单路径与当前提交路径。 */
  expected: string[];
  current: string[];
  head: string;
  prepushEnabled: boolean;
  prepushSha: string | undefined;
  prepushState: string | undefined;
  /** 惰性取:精确收据放行时原来根本不算策略(不读批注)。 */
  policy: () => PushReviewPolicy;
}): SelectionPushDecision {
  const sameScope = samePaths(input.current, input.expected);
  if (input.selectionStatus === "confirmed"
      && input.selectionHead === input.head && sameScope) {
    return { kind: "allow" };
  }
  // "全自动"关闭的是常规最终过目,不是交付白名单。Build-Fix 在同一文件
  // 集合内修出新 SHA 时可以按既定范围自动续推;新增/移除文件是范围冲突,
  // 必须强制出卡,月光也不能代答。
  const policy = input.policy();
  const verified = !input.prepushEnabled
    || Boolean(input.prepushSha === input.head
      && ["passed", "user_skipped"].includes(input.prepushState ?? ""));
  if (!policy.ordinaryReviewEnabled && !policy.recheckRequired
      && !policy.hasHumanFeedback && sameScope && verified) {
    return { kind: "auto_confirm",
      reason: input.prepushState === "user_skipped"
        ? "用户已跳过 Build-Fix；当前 SHA 未改变已选交付文件范围"
        : "Build-Fix 已覆盖当前 SHA；未改变已选交付文件范围" };
  }
  if (!verified) {
    return { kind: "stall",
      reason: `当前 HEAD ${input.head.slice(0, 12)} 尚无有效 Build-Fix 收据，`
        + "不能自动确认交付范围" };
  }
  if (!sameScope) {
    const unexpected = input.current.filter((path) => !input.expected.includes(path));
    const missing = input.expected.filter((path) => !input.current.includes(path));
    return { kind: "recard", reason: [
      unexpected.length
        ? `新增了未确认文件 ${describeDirtyPaths(unexpected)}` : "",
      missing.length
        ? `已确认文件不再提交 ${describeDirtyPaths(missing)}` : "",
    ].filter(Boolean).join("；") || "提交文件集合已经变化" };
  }
  if (input.selectionStatus !== "confirmed") {
    return { kind: "recard", reason: "交付文件清单已整理完成，等待确认最新 Build-Fix 结果" };
  }
  return { kind: "recard",
    reason: `交付清单确认绑定的是 ${(input.selectionHead ?? "").slice(0, 12)}，`
      + `当前待推送提交是 ${input.head.slice(0, 12)}` };
}

export function recardDetail(reason: string): string {
  return `最终确认后现场又发生变化：${reason}。旧确认已自动作废，`
    + "正在按最新 HEAD 重新生成检视卡；不用重跑任务。";
}

/** 重复确认时把文件范围变化说成人话:只补了一个 .gitignore 时人看一行就能
 * 拍板,不用整单重看;"增量 diff"这类实现词不露出。没有上次确认或范围
 * 没变就不说。 */
export function scopeDeltaLine(
  previous: string[] | undefined,
  committed: string[],
): string | undefined {
  if (!previous) return undefined;
  const addedPaths = committed.filter((path) => !previous.includes(path));
  const removedPaths = previous.filter((path) => !committed.includes(path));
  if (!addedPaths.length && !removedPaths.length) return undefined;
  return `**文件范围变化：${[
    addedPaths.length ? `新增 ${describeDirtyPaths(addedPaths)}` : "",
    removedPaths.length ? `移除 ${describeDirtyPaths(removedPaths)}` : "",
  ].filter(Boolean).join(";")};其余 ${
    committed.filter((path) => previous.includes(path)).length
  } 个文件与上次确认一致,可只检视变化部分。**`;
}

export function pushWaitingDetail(
  recheckRequired: boolean,
  pendingReviewItems: number,
): string {
  return recheckRequired
    ? pendingReviewItems
      ? `等待 ${pendingReviewItems} 条检视意见由提出人确认`
      : "检视意见已闭环，等待责任人确认推送"
    : "等待确认最终交付范围";
}

/** 前缀按路径段闭合:src/filter 匹配 src/filter 与 src/filter/**,不吞
 * src/filterX(裸 startsWith 会把邻居目录错认成面内)。 */
export function pathWithinScope(path: string, scopePaths: readonly string[]): boolean {
  return scopePaths.some((prefix) => {
    const clean = prefix.replace(/\/+$/, "");
    return path === clean || path.startsWith(`${clean}/`);
  });
}

/** 越界=不在负责面、没被主责任人豁免、也不是内核流程自己要求写的规格
 * (docs/specs 等:每个单元都得写,是全仓共用的流程真相,不是谁的文件面;
 * 内网实锤 pnp-deploy-contract 单元因 docs/specs/index.md 被判越界)。 */
export function deliveryScopeViolations(input: {
  committed: readonly string[];
  scopePaths: readonly string[];
  exempt: ReadonlySet<string>;
  processArtifact: (path: string) => boolean;
}): string[] {
  return input.committed.filter((path) => !pathWithinScope(path, input.scopePaths)
    && !input.exempt.has(path) && !input.processArtifact(path));
}

export function listedPaths(paths: readonly string[]): string {
  return paths.slice(0, 20).join("、")
    + (paths.length > 20 ? ` 等 ${paths.length} 个` : "");
}

/** 分支上有外来提交时越界文件很可能根本不是本单元干的:不点名这件事,
 * 裁决人会对着别人的改动追问本单元责任人。 */
export function scopeViolationDetail(
  scopeName: string,
  listed: string,
  foreignCount: number | undefined,
): string {
  return `本单元(${scopeName})的提交改动越出负责文件面:`
    + `${listed}。可能是实现确有需要(如修改接口契约),也可能是`
    + "拆分方案有误;请主责任人裁决:放行(改动随本单元 MR 一起检视)"
    + "或打回(撤出越界改动)。"
    + (foreignCount
      ? `另外:本分支上有 ${foreignCount} 条别人直接推的提交,`
        + "越界文件可能来自它们,不一定是本单元的改动。" : "");
}
