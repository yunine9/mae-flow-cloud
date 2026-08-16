/**
 * repo map 的契约:
 * - 排序讲扇入:被全仓引用的核心类排最前(模型先看骨架);
 * - 三道预算帽(文件数/输出字符/时间)都如实 truncated,绝不无限扫;
 * - fail-open:不是仓、读不动,返回空地图不炸——地图是加餐不是主食。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap } from "../src/repoMap.ts";

function makeJavaRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-map-"));
  const src = join(dir, "src", "main", "java", "com", "demo");
  mkdirSync(src, { recursive: true });
  // 核心类:被其余所有文件引用
  writeFileSync(join(src, "NotifyService.java"), [
    "package com.demo;",
    "public class NotifyService {",
    "  public void deliverMessage(String account) {}",
    "  public boolean retryDelivery(String account) { return true; }",
    "}",
  ].join("\n"));
  // 三个引用者
  for (const name of ["OrderHandler", "UserHandler", "ReportHandler"]) {
    writeFileSync(join(src, `${name}.java`), [
      "package com.demo;",
      `public class ${name} {`,
      "  private NotifyService notifyService;",
      `  public void handle${name}() { notifyService.deliverMessage("x"); }`,
      "}",
    ].join("\n"));
  }
  // 入口:引用三个 handler,让"被引用程度"有梯度(否则 handler 与
  // 边角文件同为零扇入,平局排序碰运气)
  writeFileSync(join(src, "AppEntry.java"), [
    "package com.demo;",
    "public class AppEntry {",
    "  public void boot() { new OrderHandler(); new UserHandler(); new ReportHandler(); }",
    "}",
  ].join("\n"));
  // 无人引用的边角文件
  writeFileSync(join(src, "LegacyUtil.java"), [
    "package com.demo;",
    "public class LegacyUtil {",
    "  public static String pad(String s) { return s; }",
    "}",
  ].join("\n"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}

test("扇入排序:被全仓引用的核心类排最前,符号点得出来", () => {
  const repo = makeJavaRepo();
  const map = buildRepoMap(repo);
  const lines = map.markdown.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(map.fileCount, 6);
  assert.match(lines[0], /NotifyService\.java/, "核心类该排第一");
  assert.match(lines[0], /deliverMessage/, "方法符号要在地图上");
  // 无人引用的边角排最后
  assert.match(lines[lines.length - 1], /LegacyUtil/);
});

test("预算帽:输出字符帽截断如实 truncated;文件数帽同理", () => {
  const repo = makeJavaRepo();
  const tight = buildRepoMap(repo, { maxOutputChars: 150 });
  assert.equal(tight.truncated, true);
  assert.ok(tight.markdown.length <= 220, "截断后不许超帽太多");
  assert.match(tight.markdown, /按预算截断/, "截断要明说,不装完整");

  const few = buildRepoMap(repo, { maxFiles: 2 });
  assert.equal(few.truncated, true);
  assert.equal(few.fileCount <= 2, true);
});

test("fail-open:不存在的目录返回空地图,不炸", () => {
  const map = buildRepoMap("/不存在的/路径");
  assert.equal(map.markdown, "");
  assert.equal(map.fileCount, 0);
  assert.equal(map.truncated, true);
});

test("非 git 目录退目录遍历,跳过 node_modules 之流", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-map-plain-"));
  writeFileSync(join(dir, "app.py"), "class AppMain:\n  def run(self): pass\n");
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "junk", "x.js"),
    "function shouldNotAppear() {}");
  const map = buildRepoMap(dir);
  assert.match(map.markdown, /app\.py: AppMain, run/);
  assert.ok(!map.markdown.includes("shouldNotAppear"),
    "node_modules 不进地图");
});
