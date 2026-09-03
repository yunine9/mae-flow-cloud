/**
 * 问题流流水线红灯修复的公共件:
 * - repairBudget: 修复轮预算(与需求侧同一管理页旋钮 repair_rounds,
 *   同一缺省 20;0=关掉自动修复,红灯留痕请人工)。
 *
 * 只放与 TaskService 无关的纯机械;分诊/派单不出这条线——问题流的
 * 修复会话就是会话自己(容器在场),平台回合即派单。产物全文镜像的
 * 公共实现在 src/pipelineMirror.ts,直接从那里 import。
 */

/** 修复轮预算:管理页旋钮现读,缺席用需求侧同款缺省 20。 */
export function repairBudget(
  settings?: { runtime?(): { repair_rounds?: number } },
): number {
  const value = settings?.runtime?.().repair_rounds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value) : 20;
}
