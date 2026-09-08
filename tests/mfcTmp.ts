/**
 * 测试临时目录的自清理(2026-09-07,/tmp 反复打满的治理):重型家族
 * (issue 与 assistant 两个家族)的 mkdtemp 改走 mfcTemp(),文件跑完由
 * 顶层 after 当场删掉——不再把清理指望在"下一轮测试开头的清道夫"上
 * (强杀常态化的套件里下一轮不一定来,而清道夫的 24h 安全窗又永远
 * 收不走当天的残留,只进不出,一天就能塞满 tmpfs)。
 *
 * 归属精确:只删本进程经 mfcTemp 建出来的目录,并行的套件互不误伤。
 * after 在本模块被 import 时(测试文件的收集期)注册,总是执行——
 * 要留红灯案发现场时用 MFC_TEST_KEEP_TMP=1 保留。清道夫
 * (clean-test-tmp.ts)退居异常兜底:强杀/崩溃时 after 不会执行,
 * 那部分残留仍由它在 24h 后收走。
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const created = new Set<string>();

/** 删一棵目录树:git 产物里有只读目录挡 unlink(清道夫手册同款坑),
 * 先把沿途目录全放开再删一遍——删文件只需父目录可写,文件本身不用动。
 * 测试自身的 finally 清理也走这里(裸 rmSync 会撞只读目录直接炸)。 */
export function forceRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 只读目录挡路,放开权限走重试。
  }
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) forceRm(join(dir, entry.name));
    }
  } catch {
    // 树可能已被并发清掉,最后一刀 force 会给出真相。
  }
  rmSync(dir, { recursive: true, force: true });
}

after(() => {
  if (process.env.MFC_TEST_KEEP_TMP) return;
  for (const dir of created) forceRm(dir);
});

/** mkdtempSync 的自清理替身:前缀照旧(mfc-<家族>-),多记一笔账。 */
export function mfcTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}
