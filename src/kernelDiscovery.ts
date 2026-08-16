/**
 * 内核自动发现——serve/pilot/测试共用的唯一一条链:
 *   显式 MAE_FLOW_HOME > 开发布局的兄弟目录 ../mae-flow(活内核,
 *   开发机不用收编快照)> 仓内收编的 kernel/(部署形态:一个 clone
 *   就是完整产品,harness/sync-kernel.sh 负责刷新快照)。
 *
 * 为什么必须共用:worktree 里跑测试时 cwd 变了,各处手写的
 * `cwd()/../mae-flow` 指到不存在的位置,内核 bootstrap 起不来,
 * 门禁拦死剧本会话,一串用例超时——同一条发现链只许写一遍。
 *
 * 判定标记用 hooks/dispatch.py(内核转发壳入口,比 scripts/ 目录更
 * 不易误认);MAE_FLOW_HOME 显式指定则无条件信任,错了让它响亮地错。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function discoverKernelRoot(repoRoot: string): string | undefined {
  return process.env.MAE_FLOW_HOME
    ?? [resolve(repoRoot, "..", "mae-flow"), resolve(repoRoot, "kernel")]
      .find((candidate) => existsSync(join(candidate, "hooks", "dispatch.py")));
}
