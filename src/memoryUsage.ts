import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore } from "./taskMemory.ts";

export interface MemoryUsageEvent {
  moment: "launch" | "phase" | "edit" | "search" | "expand";
  ids: string[]; query?: string; phase?: string; dir?: string; digest?: boolean;
}
export function recordMemoryUsage(context: {
  workspace: string; taskId: string; store: () => MemoryStore; log?: (message: string) => void;
}, event: MemoryUsageEvent): void {
    try {
      appendFileSync(join(context.workspace, "memory-usage.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf-8");
    } catch (error) {
      context.log?.(`任务 ${context.taskId} 记忆足迹写入失败: ${String(error)}`);
    }
    // 台账是跨任务的账(排序、沉底都看它),足迹是这单的账;两边都记。
    try {
      const kind = event.moment === "search" || event.moment === "expand"
        ? event.moment : "push";
      for (const id of event.ids) {
        context.store().ledger.append({ kind, id, task: context.taskId,
          note: event.moment === "edit" ? event.dir : event.phase ?? event.moment });
      }
    } catch (error) {
      context.log?.(`记忆台账写入失败: ${String(error)}`);
    }
}

export function readMemoryUsage(workspace: string): Array<Record<string, unknown>> {
  const path = join(workspace, "memory-usage.jsonl");
  return existsSync(path) ? readAppendOnlyJsonl<Record<string, unknown>>(path,
    { middleCorrupt: "skip" }) : [];
}
