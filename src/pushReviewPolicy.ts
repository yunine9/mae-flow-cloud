/** 推送确认保留用户选定的文件范围。内容和 SHA 变化由 Agent 说明，
 * 不自动作废决定；明确打回或范围调整仍创建新的待办。 */

import { createHash } from "node:crypto";
import { TaskControlError } from "./errors.ts";

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
    && sameOrderedValues(receipt.paths, snapshot.paths);
}

/** 同一文件范围复用待办；cycleToken 区分用户明确打回后的下一轮。 */
export function pushReviewCallId(
  snapshot: PushReviewSnapshot,
  cycleToken?: string,
): string {
  const digest = createHash("sha256")
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

/** 交付清单路径归一:去 ./ 前缀、反斜杠转正、去重排序;绝对路径、..、控制字符
 * 一律拒绝——清单是要拿去 git 操作的,不能让一条路径逃出工作区。 */
export function normalizedDeliveryPaths(values: string[]): string[] {
  const paths = values.map((value) => String(value).trim()
    .replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")).filter(Boolean);
  for (const path of paths) {
    if (path.startsWith("/") || path === ".." || path.startsWith("../")
        || path.includes("/../") || /[\0\r\n]/.test(path)) {
      throw new TaskControlError(`交付清单包含不安全路径：${path}`);
    }
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
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
 * 内按责任人既有设置续推；编译结果不代替授权，也不构成额外门禁。 */
export type SelectionPushDecision =
  | { kind: "allow" }
  | { kind: "auto_confirm"; reason: string }
  | { kind: "recard"; reason: string };

export function selectionPushDecision(input: {
  selectionStatus: string;
  selectionHead: string | undefined;
  /** 已归一化(排序去重)的清单路径与当前提交路径。 */
  expected: string[];
  current: string[];
  head: string;
  /** 惰性取:精确收据放行时原来根本不算策略(不读批注)。 */
  policy: () => PushReviewPolicy;
}): SelectionPushDecision {
  const sameScope = samePaths(input.current, input.expected);
  if (input.selectionStatus === "confirmed"
      && sameScope) {
    return { kind: "allow" };
  }
  // "全自动"关闭的是常规最终过目,不是交付白名单。Build-Fix 在同一文件
  // 集合内修出新 SHA 时可以按既定范围自动续推;新增/移除文件是范围冲突,
  // 必须强制出卡,月光也不能代答。
  const policy = input.policy();
  if (!policy.ordinaryReviewEnabled && !policy.recheckRequired
      && !policy.hasHumanFeedback && sameScope) {
    return { kind: "auto_confirm", reason: "按既定推送设置续推；当前 SHA 未改变已选交付文件范围" };
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
    return { kind: "recard", reason: "交付文件清单已整理完成，等待确认当前改动" };
  }
  return { kind: "allow" };
}

export function recardDetail(reason: string): string {
  return `需要核对交付范围：${reason}。正在展示当前文件清单；不用重跑任务。`;
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
