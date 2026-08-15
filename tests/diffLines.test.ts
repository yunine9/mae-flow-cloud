/**
 * diff 行 → 新文件行号。这是代码批注的定位地基:算错一位,所有代码
 * 批注都指错地方,而模型手上的文件里根本没有"diff 第几行"这回事。
 *
 * 最容易错的一处:删除行不占新文件的行号(它在新文件里已经不存在)。
 * 顺着往下数会让删除行后面的每一行都偏移。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { newFileLines } from "../web/src/diffLines.ts";

test("行号从 @@ 的新文件起点递推,删除行不占号", () => {
  const diff = [
    "diff --git a/SmsHandler.java b/SmsHandler.java",   // 0
    "index 111..222 100644",                             // 0
    "--- a/SmsHandler.java",                             // 0
    "+++ b/SmsHandler.java",                             // 0
    "@@ -18,6 +20,7 @@ class SmsHandler {",              // 0(hunk 头本身没行号)
    "     private void send() {",                        // 20 上下文
    "-        retry(3);",                                //  0 删除行不占号
    "+        retryOnGatewayFailure(3);",                // 21 新增
    "+        log.info(\"sent\");",                      // 22 新增
    "     }",                                            // 23 上下文
  ];
  assert.deepEqual(newFileLines(diff), [0, 0, 0, 0, 0, 20, 0, 21, 22, 23]);
});

test("多个 hunk 各自从自己的起点重新数", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    " a",
    "+b",
    "@@ -50,2 +60,2 @@",
    " x",
    "+y",
  ];
  assert.deepEqual(newFileLines(diff), [0, 1, 2, 0, 60, 61]);
});

test("没有 hunk 头就不给行号——宁可不可圈注,也不给错坐标", () => {
  assert.deepEqual(
    newFileLines(["?? web/src/new.ts"]), [0]);
  assert.deepEqual(
    newFileLines(["diff --git a/x b/x", "index 1..2"]), [0, 0]);
});

test("@@ 头省略行数(单行 hunk)照样认", () => {
  assert.deepEqual(newFileLines(["@@ -7 +9 @@", "+只有一行"]), [0, 9]);
});
