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

test("真仓实测逼出的两条:测试文件降权、通用词不算引用信号", () => {
  // 内核仓上第一版地图前排全是 tests/ 与 check/write/state 刷出来的
  // 假扇入,模型拿到手根本找不到实现。这里把那两条修正钉成契约。
  const dir = mkdtempSync(join(tmpdir(), "mfc-map-rank-"));
  const src = join(dir, "src");
  const tests = join(dir, "tests");
  mkdirSync(src, { recursive: true });
  mkdirSync(tests, { recursive: true });
  // 实现:名字独特,被两个同伴引用
  writeFileSync(join(src, "InvoiceReconciler.java"), [
    "public class InvoiceReconciler {",
    "  public void reconcile() {}",
    "}",
  ].join("\n"));
  for (const name of ["BillingJob", "LedgerSync"]) {
    writeFileSync(join(src, `${name}.java`), [
      `public class ${name} {`,
      "  private InvoiceReconciler invoiceReconciler;",
      `  public void run${name}() {}`,
      `  public void stop${name}() {}`,
      "}",
    ].join("\n"));
  }
  // 测试文件:主符号是 check/write/state 这类通用词(真仓里 Python
  // 模块级函数就长这样),词频高到"全仓都提到我"——不剔通用词的话
  // 它们扇入满分直接霸榜。数量要够多,否则词频到不了阈值。
  for (const name of ["AlphaTest", "BetaTest", "GammaTest", "DeltaTest",
                      "EpsilonTest", "ZetaTest", "EtaTest"]) {
    writeFileSync(join(tests, `${name}.java`), [
      `public class ${name} {`,
      "  public void check() {}",
      "  public void write() {}",
      "  public void state() {}",
      "  public void verifyAlphaTest() { check(); write(); state(); }",
      "}",
    ].join("\n"));
  }
  const map = buildRepoMap(dir);
  const lines = map.markdown.split("\n").filter((l) => l.startsWith("- "));
  assert.match(lines[0], /InvoiceReconciler\.java/,
    "被引用的实现要排在测试前面");
  assert.ok(lines.slice(0, 3).every((line) => !line.includes("Test.java")),
    `测试文件不该霸占前排:${lines.slice(0, 3).join(" | ")}`);
  // 降权不是剔除:测试仍在地图上,只是靠后
  assert.ok(map.markdown.includes("AlphaTest.java"), "测试仍要在地图上");
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
