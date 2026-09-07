/** 模板/模型描述记录如何形成；只有服务端的在途作业事实代表“正在整理”。 */
export function memoryPreparation(row: {
  source: string;
  draft?: "template" | "model" | "failed";
  drafting?: boolean;
}): { label: string; title: string } {
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
