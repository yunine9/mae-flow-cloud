import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILD_CACHE_METADATA,
  buildCacheKey,
  cacheKeyFromPath,
  inspectBuildCaches,
  reclaimBuildCaches,
  touchBuildCache,
} from "../src/buildCache.ts";
import { TaskService } from "../src/taskService.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-08-28T12:00:00Z");

function root(): string {
  return mkdtempSync(join(tmpdir(), "mfc-build-cache-life-"));
}

function populate(cacheRoot: string, repository: string, usedAt: number,
                  bytes = 4096): { key: string; base: string } {
  const touched = touchBuildCache(cacheRoot, repository, usedAt);
  mkdirSync(join(touched.base, "ccache"), { recursive: true });
  writeFileSync(join(touched.base, "ccache", "object.bin"), "x".repeat(bytes));
  return touched;
}

test("挂载即登记最后使用时间，同仓沿用既有分区且元数据不含凭据", () => {
  const cacheRoot = root();
  const repository = "https://token:secret@code.example/team/app.git?access=leak";
  const first = touchBuildCache(cacheRoot, repository, NOW - DAY);
  mkdirSync(join(first.base, "maven"));
  const second = touchBuildCache(cacheRoot, repository, NOW);
  assert.equal(first.key, second.key);
  assert.equal(first.key, buildCacheKey(repository), "升级不能让既有哈希算法失效");
  assert.ok(existsSync(join(second.base, "maven")), "登记使用不能清空已焐热内容");
  const metadata = readFileSync(join(second.base, BUILD_CACHE_METADATA), "utf-8");
  assert.doesNotMatch(metadata, /token|secret|access=leak/);
  assert.match(metadata, /code\.example\/team\/app\.git/);
  assert.match(metadata, /2026-08-28T12:00:00\.000Z/);
  assert.equal(cacheKeyFromPath(cacheRoot, join(second.base, "ccache")), first.key);
  assert.equal(cacheKeyFromPath(cacheRoot, join(cacheRoot, "outside")), undefined);
});

test("自动回收只清超期未占用缓存，活任务缓存即使很老也不碰", async () => {
  const cacheRoot = root();
  const stale = populate(cacheRoot, "https://code/team/stale.git", NOW - 40 * DAY);
  const active = populate(cacheRoot, "https://code/team/active.git", NOW - 80 * DAY);
  const fresh = populate(cacheRoot, "https://code/team/fresh.git", NOW - 2 * DAY);
  const activeKeys = new Set([active.key]);
  const result = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => activeKeys,
    retentionDays: 30,
    maxBytes: 0,
    now: NOW,
  });
  assert.equal(result.reclaimed, 1);
  assert.equal(existsSync(stale.base), false);
  assert.equal(existsSync(active.base), true);
  assert.equal(existsSync(fresh.base), true);
  assert.deepEqual(result.status.entries.map((entry) => entry.key).sort(),
    [active.key, fresh.key].sort());
});

test("容量超限按最后使用时间清理，0 表示关闭对应自动策略", async () => {
  const cacheRoot = root();
  const old = populate(cacheRoot, "https://code/team/old.git", NOW - 10 * DAY, 8192);
  const recent = populate(cacheRoot, "https://code/team/recent.git", NOW - DAY, 8192);
  const before = await inspectBuildCaches({
    cacheRoot, activeKeys: new Set(), retentionDays: 0, maxBytes: 0,
  });
  const recentSize = before.entries.find((entry) => entry.key === recent.key)!.size_bytes;
  const result = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => new Set(),
    retentionDays: 0,
    maxBytes: recentSize,
    now: NOW,
  });
  assert.equal(result.reclaimed, 1);
  assert.equal(existsSync(old.base), false, "应先清最久未用分区");
  assert.equal(existsSync(recent.base), true);

  const disabled = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => new Set(),
    retentionDays: 0,
    maxBytes: 0,
    now: NOW + 365 * DAY,
  });
  assert.equal(disabled.reclaimed, 0, "两项都为 0 时不自动删除");
});

test("手动清理全部闲置缓存，但删除前新出现的租约会被二次检查拦下", async () => {
  const cacheRoot = root();
  const cache = populate(cacheRoot, "https://code/team/race.git", NOW - DAY);
  let reads = 0;
  const result = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => {
      reads += 1;
      return reads >= 2 ? new Set([cache.key]) : new Set();
    },
    retentionDays: 30,
    maxBytes: 0,
    allUnused: true,
    now: NOW,
  });
  assert.equal(result.reclaimed, 0);
  assert.equal(result.skipped_active, 1);
  assert.equal(existsSync(cache.base), true);
});

test("不把 cacheRoot 下的软链接或杂项当成可删除缓存", async () => {
  const cacheRoot = root();
  const outside = root();
  const key = "a".repeat(20);
  writeFileSync(join(outside, "keep.txt"), "do not delete");
  symlinkSync(outside, join(cacheRoot, key));
  writeFileSync(join(cacheRoot, "README.txt"), "operator note");
  const result = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => new Set(),
    retentionDays: 1,
    maxBytes: 1,
    allUnused: true,
    now: NOW,
  });
  assert.equal(result.reclaimed, 0);
  assert.ok(existsSync(join(outside, "keep.txt")));
  assert.ok(existsSync(join(cacheRoot, key)), "不受管软链连链接本身也不碰");
  assert.ok(existsSync(join(cacheRoot, "README.txt")));
});

test("升级前缓存没有最后使用账本时先纳管，不在新版本首次启动就误删", async () => {
  const cacheRoot = root();
  const key = "b".repeat(20);
  const base = join(cacheRoot, key);
  mkdirSync(join(base, "maven"), { recursive: true });
  writeFileSync(join(base, "maven", "artifact.jar"), "legacy cache");
  const old = new Date(NOW - 365 * DAY);
  utimesSync(base, old, old);

  const adopted = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => new Set(),
    retentionDays: 30,
    maxBytes: 0,
    now: NOW,
  });
  assert.equal(adopted.reclaimed, 0);
  assert.ok(existsSync(join(base, BUILD_CACHE_METADATA)));
  assert.equal(adopted.status.entries[0].tracked, true);
  assert.equal(adopted.status.entries[0].last_used_at,
    new Date(NOW).toISOString());

  const expired = await reclaimBuildCaches({
    cacheRoot,
    activeKeys: () => new Set(),
    retentionDays: 30,
    maxBytes: 0,
    now: NOW + 31 * DAY,
  });
  assert.equal(expired.reclaimed, 1, "完整宽限期过去后应正常回收");
  assert.equal(existsSync(base), false);
});

test("TaskService 用非终态任务作缓存租约，任务取消后才允许手动清理", async () => {
  const cacheRoot = root();
  const dataDir = root();
  const repository = "https://code.example/team/inflight.git";
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    buildCacheRetentionDays: 1,
    buildCacheMaxGb: 0,
    isolation: { image: "fixture/build:test", cacheRoot },
  });
  const workspace = join(dataDir, "task-1");
  const cwd = join(workspace, "inflight");
  mkdirSync(cwd, { recursive: true });
  const state = {
    summary: {
      id: "task-1",
      requirement: "等待执行的任务",
      status: "queued",
      workspace,
      repo_url: repository,
      created_at: new Date(NOW).toISOString(),
    },
    cwd,
  };
  (service as any).tasks.set("task-1", state);
  (service as any).taskContainerMounts({
    cwd,
    summary: { id: "task-1", repo_url: repository },
  }, []);
  const base = join(cacheRoot, buildCacheKey(repository));

  const protectedResult = await service.reclaimIdleBuildCaches({
    allUnused: true,
    now: NOW + 90 * DAY,
  });
  assert.equal(protectedResult.reclaimed, 0);
  assert.equal(protectedResult.status.active, 1);
  assert.ok(existsSync(base));

  state.summary.status = "canceled";
  const cleared = await service.reclaimIdleBuildCaches({ allUnused: true });
  assert.equal(cleared.reclaimed, 1);
  assert.equal(existsSync(base), false);
});
