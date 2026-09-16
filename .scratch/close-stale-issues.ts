// 一次性运维脚本:仓内 .tasks 数据目录对应的旧 serve 实例已于 2026-09-14
// SIGTERM 下线(线上实例迁至 /home/ning/mae-flow-local),其下 8 个非终态
// 验证/模拟单走 IssueFlowService.control 正规语义统一收口。
// 用法: npx tsx .scratch/close-stale-issues.ts
import { IssueFlowService } from "../src/issueFlow/service.ts";

const dataDir = "/home/ning/code/mae-flow-cloud/.tasks";
const service = new IssueFlowService({
  dataDir,
  provider: "maeflow",
  model: "offline-cleanup",
  modelsJson: {},
  log: (message) => console.log(message),
});

const summary = "旧开发实例(.tasks)下线清理:验证/模拟单统一收口";
const toArchive = [
  "issue-1", "issue-2", "issue-3", "issue-5",
  "issue-7", "issue-9", "issue-10", "issue-11",
];
for (const id of toArchive) {
  try {
    const row = await service.control(id, { action: "archive", summary });
    console.log(`[done] ${id} -> ${row.status}`);
  } catch (error) {
    console.error(`[fail] archive ${id}: ${
      error instanceof Error ? error.message : String(error)}`);
  }
}

// failed 是死胡同终态:按 control() 的出口约定只能取消,不能归档。
try {
  const row = await service.control("issue-8", { action: "cancel" });
  console.log(`[done] issue-8 -> ${row.status}`);
} catch (error) {
  console.error(`[fail] cancel issue-8: ${
    error instanceof Error ? error.message : String(error)}`);
}

await service.shutdown();
