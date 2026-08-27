import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeTree,
  compactDirectory,
  displayDirectoryPaths,
  parseChanges,
} from "../web/src/gitDiffTree.ts";

function changed(paths: string[]) {
  return parseChanges([
    "## 未暂存",
    ...paths.flatMap((path) => [
      `diff --git a/${path} b/${path}`,
      "@@ -1 +1 @@",
      "-old",
      "+next",
    ]),
  ].join("\n"));
}

test("单链目录合成一级缩进，深层文件名不会被目录层级吃光", () => {
  const tree = changeTree(changed([
    "src/main/java/com/acme/FooService.java",
    "src/main/java/com/acme/BarService.java",
  ]));
  const compacted = compactDirectory(tree.directories[0]);

  assert.equal(compacted.label, "src/main/java/com/acme");
  assert.equal(compacted.directory.path, "src/main/java/com/acme");
  assert.deepEqual(compacted.directory.files.map((file) => file.path), [
    "src/main/java/com/acme/BarService.java",
    "src/main/java/com/acme/FooService.java",
  ]);
});

test("存在分叉时停止合并，main 与 test 仍是可分别折叠的目录", () => {
  const tree = changeTree(changed([
    "src/main/java/com/acme/FooService.java",
    "src/test/java/com/acme/FooServiceTest.java",
  ]));
  const compacted = compactDirectory(tree.directories[0]);

  assert.equal(compacted.label, "src");
  assert.deepEqual(compacted.directory.directories.map((item) => item.name), [
    "main",
    "test",
  ]);
  assert.deepEqual(displayDirectoryPaths(tree), [
    "src",
    "src/main/java/com/acme",
    "src/test/java/com/acme",
  ], "一键展开/折叠只操作界面真正显示的压缩目录行");
});
