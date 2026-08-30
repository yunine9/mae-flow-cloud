/**
 * 清扫脚本自身的极小契约(issue #34):只删超窗的、不动新鲜的、
 * 单条失败告警继续。全用假目录 + utimes 改 mtime,不依赖 /tmp 里
 * 碰巧有什么残留,也不会往真 /tmp 留东西(finally 连根拔)。
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepStaleMfcTmp } from "../scripts/clean-test-tmp.ts";

const HOUR = 60 * 60 * 1000;

/** 在隔离的假根里跑断言,结束后连根拔掉——假根本身也是个 mfc-*,别自己变残留。 */
function withFakeRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mfc-sweep-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("清扫只删 mtime 超过 24h 的 mfc-* 目录,新鲜目录与非 mfc- 前缀不碰", () => {
  withFakeRoot((root) => {
    const stale = join(root, "mfc-stale-case");
    const fresh = join(root, "mfc-fresh-case");
    const foreign = join(root, "not-mfc");
    for (const dir of [stale, fresh, foreign]) mkdirSync(dir);
    // 超窗残留里有真实内容:验证递归整棵拔掉。
    writeFileSync(join(stale, "leftover.txt"), "残骸");
    // 把 stale 的 mtime 拨到 25h 前,跨过安全窗。
    const longAgo = new Date(Date.now() - 25 * HOUR);
    utimesSync(stale, longAgo, longAgo);

    const result = sweepStaleMfcTmp({ root });

    assert.ok(!existsSync(stale), "超窗残留应连内容一起删除");
    assert.ok(existsSync(fresh), "安全窗内的新目录不能动(并行会话在用)");
    assert.ok(existsSync(foreign), "非 mfc- 前缀的目录不归清扫管");
    assert.deepEqual(result.removed, ["mfc-stale-case"]);
    assert.equal(result.failed.length, 0);
    assert.equal(result.kept, 1); // 台账只数 mfc-*:新鲜目录 1 个,not-mfc 不入账
  });
});

const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("删除失败单条告警继续,不炸也不殃及台账", { skip: AS_ROOT && "root 下 chmod 拦不住删除,模拟不了失败" }, () => {
  withFakeRoot((root) => {
    const staleA = join(root, "mfc-stale-a");
    const staleB = join(root, "mfc-stale-b");
    for (const dir of [staleA, staleB]) mkdirSync(dir);
    const longAgo = new Date(Date.now() - 25 * HOUR);
    utimesSync(staleA, longAgo, longAgo);
    utimesSync(staleB, longAgo, longAgo);
    // 拔掉父目录写权限:删子目录必然 EACCES,模拟权限/竞态类失败。
    chmodSync(root, 0o500);
    try {
      const result = sweepStaleMfcTmp({ root });
      assert.equal(result.removed.length, 0);
      assert.deepEqual(result.failed.sort(), ["mfc-stale-a", "mfc-stale-b"]);
      assert.ok(existsSync(staleA) && existsSync(staleB), "失败的条目原地保留");
    } finally {
      chmodSync(root, 0o700); // 还原权限,withFakeRoot 的 finally 才清得了场
    }
  });
});
