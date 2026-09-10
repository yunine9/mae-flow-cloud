/** 未取得服务端事实时，不把未知状态误判成没有部署。 */
export function memorySearchPresentation(
  sidecar?: "ready" | "unavailable" | "absent", failed = false,
): { label: string; title: string; state: string } {
  if (failed) return { state: "unknown", label: "检索状态读取失败", title: "暂时无法确认检索状态，请刷新重试。" };
  if (sidecar === "ready") return { state: sidecar, label: "语义检索在线", title: "Agent 可按语义查找相关任务记忆。" };
  if (sidecar === "unavailable") return { state: sidecar, label: "语义检索暂不可用", title: "检索已启用但尚未就绪或运行异常；记忆记录仍保留。" };
  if (sidecar === "absent") return { state: sidecar, label: "语义检索未启用", title: "当前服务未配置语义检索；记忆仍可记录、浏览和按索引推送。启用请联系管理员。" };
  return { state: "unknown", label: "正在读取检索状态…", title: "等待服务返回检索状态。" };
}

/** 模板/模型描述记录如何形成；只有服务端的在途作业事实代表“正在整理”。 */
export function memoryPreparation(row: {
  source: string;
  draft?: "template" | "model" | "failed";
  drafting?: boolean;
}): { label: string; title: string } {
  if (row.source === "agent_note") return { label: "已记录", title: "Agent 主动保存的经验，未经人工或流水线确认。" };
  if (row.source === "user_note") {
    return { label: "已记录", title: "已按你写下的内容入库，无需模型整理。" };
  }
  if (row.drafting) {
    return { label: "整理中", title: "记忆已入库；模型正在整理触发条件和适用范围，不影响使用。" };
  }
  if (row.draft === "model") {
    return { label: "已整理", title: "记忆已入库，触发条件和适用范围已由模型整理。" };
  }
  if (row.draft === "failed") {
    return { label: "整理失败", title: "模型整理失败，已保留模板记录，仍可用于检索和推送。" };
  }
  return { label: "已记录", title: "已按模板入库，可用于检索和推送；当前没有模型整理作业。" };
}
