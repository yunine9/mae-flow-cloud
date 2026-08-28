/**
 * 任务的扫读焦点。
 *
 * 它只把已有任务事实翻译成“现在发生什么 / 下一步是谁做”，不参与
 * 状态迁移、门禁或恢复。TaskService 在读侧现算，旧 task.json 无需迁移，
 * 前端也不再各自解释同一组 delivery/status 字段。
 */

export type TaskFocusKind =
  | "human_action"
  | "blocked"
  | "machine"
  | "external"
  | "done"
  | "inactive";

export type TaskFocusOwner = "responsible" | "agent" | "platform" | "none";

export interface TaskFocus {
  kind: TaskFocusKind;
  headline: string;
  next_action: string;
  owner: TaskFocusOwner;
  needs_attention: boolean;
  /** 只用于同一列表的稳定排序；数值越大越应先看到。 */
  priority: number;
}

interface FocusTask {
  status: string;
  detail?: string;
  /** 执行队列位次(1 起,投影字段):排队真相必须压过陈旧 detail。 */
  queue_position?: number;
  blocked_by?: string[];
  waiting?: { question?: { questions?: unknown[] } };
  progress?: {
    current_phase?: string;
    step?: string;
    milestone?: { event?: string; title?: string; reason?: string };
  };
  delivery?: {
    mr_state?: string;
    pipeline?: string;
    waiting_on?: string;
    stalled?: string;
    prepush?: { state?: string; round?: number; message?: string };
    loop?: { state?: string; round?: number; max?: number; diagnosis?: string };
  };
}

function focus(
  kind: TaskFocusKind,
  headline: string,
  nextAction: string,
  owner: TaskFocusOwner,
  priority: number,
  needsAttention = false,
): TaskFocus {
  return {
    kind,
    headline,
    next_action: nextAction,
    owner,
    needs_attention: needsAttention,
    priority,
  };
}

function repairRound(task: FocusTask): string {
  const loop = task.delivery?.loop;
  if (!loop?.round) return "";
  return `（第 ${loop.round}${loop.max !== undefined ? `/${loop.max}` : ""} 轮）`;
}

/** 从服务端已有事实生成唯一的扫读口径；任何未知状态都安全降级。 */
export function projectTaskFocus(task: FocusTask): TaskFocus {
  const delivery = task.delivery;
  const loop = delivery?.loop;
  const prepush = delivery?.prepush;

  if (task.status === "waiting_for_human") {
    const questions = task.waiting?.question?.questions?.length ?? 0;
    return focus(
      "human_action",
      questions > 0 ? `需要确认 ${questions} 个决策项` : "需要负责人确认",
      "提交决定后 Agent 自动继续",
      "responsible",
      100,
      true,
    );
  }
  if (task.status === "failed") {
    return focus(
      "blocked",
      task.detail?.trim() || "任务执行失败",
      "查看失败现场，处理后重跑",
      "responsible",
      95,
      true,
    );
  }
  if (task.status === "paused") {
    return focus(
      "blocked",
      "任务已暂停，现场已经保留",
      "需要继续时从当前现场恢复",
      "responsible",
      90,
      true,
    );
  }
  if (delivery?.stalled || loop?.state === "halted"
      || loop?.state === "exhausted") {
    return focus(
      "blocked",
      delivery?.stalled || loop?.diagnosis || "自动验证已停止",
      "查看失败原因并重跑续推",
      "responsible",
      92,
      true,
    );
  }
  if (prepush?.state === "environment_error" || prepush?.state === "blocked") {
    return focus(
      "blocked",
      prepush.message?.trim() || "推送前验证暂时无法继续",
      prepush.state === "environment_error"
        ? "等待平台恢复编译环境"
        : "查看编译或 UT 失败现场",
      prepush.state === "environment_error" ? "platform" : "agent",
      85,
      true,
    );
  }
  if (task.status === "canceled") {
    return focus("inactive", "任务已取消", "无需继续处理", "none", 0);
  }
  if (task.status === "completed") {
    return focus("done", "交付已经完成", "可在交付历史中复盘", "none", 5);
  }
  if (task.status === "await_merge") {
    return focus(
      "external",
      delivery?.mr_state ? `合入请求：${delivery.mr_state}` : "验证通过，等待合入",
      "在 CodeHub 完成检视与合入",
      "responsible",
      20,
    );
  }
  if (task.status === "pausing") {
    return focus(
      "machine",
      "正在安全暂停当前会话",
      "保存现场后自动进入暂停状态",
      "platform",
      55,
    );
  }
  if (loop?.state === "repairing") {
    return focus(
      "machine",
      `Agent 正在修复流水线问题${repairRound(task)}`,
      "产生新提交后自动重新验证",
      "agent",
      60,
    );
  }
  if (prepush && [
    "queued", "preparing", "compiling", "testing", "unit_testing", "ut",
    "repairing",
  ].includes(prepush.state ?? "")) {
    return focus(
      "machine",
      prepush.message?.trim()
        || `正在进行推送前编译与 UT${prepush.round ? `（第 ${prepush.round} 轮）` : ""}`,
      "两项通过后才会推送代码",
      "agent",
      58,
    );
  }
  if (task.status === "verifying") {
    return focus(
      "external",
      delivery?.waiting_on?.trim() || "权威流水线正在验证当前提交",
      "验证通过后进入等待合入",
      "platform",
      45,
    );
  }
  if (task.status === "queued" && (task.blocked_by?.length ?? 0) > 0) {
    return focus(
      "external",
      `等待 ${task.blocked_by!.length} 个前置任务完成`,
      "依赖满足后自动开始",
      "platform",
      35,
    );
  }
  if (task.status === "queued") {
    return focus(
      "machine",
      // 排队真相压过 detail:重跑后 detail 是"人工重跑…",拿它当标题
      // 会让排队的单看起来像在推进(实锤:并发 2 跑 3 单,用户找不到
      // 哪单在排队)。
      task.queue_position
        ? `排队等待执行资源(第 ${task.queue_position} 位)`
        : "任务正在执行队列中等待",
      task.detail?.trim() || "获得执行资源后自动开始",
      "platform",
      30,
    );
  }
  if (task.status === "running") {
    const milestone = task.progress?.milestone;
    const label = milestone?.title || task.progress?.step
      || task.progress?.current_phase;
    if (milestone?.event === "blocked") {
      return focus(
        "machine",
        milestone.reason?.trim() || `${label ?? "当前实现任务"}遇到阻塞`,
        "Agent 正在定位并尝试解除阻塞",
        "agent",
        65,
      );
    }
    return focus(
      "machine",
      label ? `Agent 正在推进：${label}` : "Agent 正在推进任务",
      "当前工作完成后自动进入下一步",
      "agent",
      40,
    );
  }
  return focus(
    "inactive",
    task.detail?.trim() || "等待新的任务状态",
    "无需人工操作",
    "none",
    0,
  );
}
