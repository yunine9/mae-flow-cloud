/**
 * serveConfig part 1:配置来源与容器边界:HOME 指定/坏配置拒启/isolate-user 拒 root/npm 源注入。
 * 共享夹具在 tests/serveConfig.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServe } from "./support/serveProcess.ts";
import {
  run,
} from "./serveConfig.helpers.ts";


test("标准镜像 HOME 可通过配置文件指定，命令行覆盖配置文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-native-home-config-"));
  const config = join(dir, "serve.json");
  writeFileSync(config, JSON.stringify({ "isolate-image": "fixture/builder:test", "isolate-home": "/home/huawei" }));
  for (const [args, expected] of [[[], "/home/huawei"], [["--isolate-home", "/home/other"], "/home/other"]] as const) {
    const result = await run(["--config", config, "--data", join(dir, expected.split("/").at(-1)!), "--port", "0", ...args],
      (line) => line.startsWith("[serve] http://127.0.0.1:"));
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(`容器 HOME: ${expected}`));
  }
});



test("配置文件坏了拒绝启动,不静默忽略", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-cfg-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ 这不是 JSON");
  const { code, output } = await run([
    "--config", bad, "--data", join(dir, "tasks"),
  ], () => false, 15_000);
  assert.notEqual(code, 0, "坏配置必须非零退出");
  assert.match(output, /配置文件读取失败,拒绝启动/);

  const missing = await run([
    "--config", join(dir, "no-such.json"), "--data", join(dir, "tasks"),
  ], () => false, 15_000);
  assert.notEqual(missing.code, 0);
});



test("小鲁班回复能力不能只凭文案开启，必须同时准备回调 Token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-luban-replies-"));
  const result = await run([
    "--luban-plugin-replies",
    "--data", join(dir, "tasks"),
    "--port", "0",
  ], () => false, 15_000);
  assert.equal(result.code, 2);
  assert.match(result.output, /需要同时配置.*luban-plugin-token-file/);
  assert.match(result.output, /真实入站插件验收通过后/);
});



test("--isolate-user 拒绝 root uid/gid，不能把容器隔离变成 root 执行", async () => {
  for (const user of ["root", "root:root", "0", "0:0", "10001:0"]) {
    const dir = mkdtempSync(join(tmpdir(), "mfc-root-user-"));
    const result = await run([
      "--data", join(dir, "tasks"),
      "--isolate-image", "fixture/builder:test",
      "--isolate-user", user,
    ], () => false, 15_000);
    assert.equal(result.code, 2, `用户 ${user} 必须拒绝启动`);
    assert.match(result.output, /禁止使用 root\/0/);
  }
});

