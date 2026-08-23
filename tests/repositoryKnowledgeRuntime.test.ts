import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeRepositoryKnowledge,
  validRepositoryKnowledgePath,
  type SelectedRepositoryKnowledge,
} from "../src/repositoryKnowledgeRuntime.ts";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): {
  root: string;
  workspace: string;
  selected: SelectedRepositoryKnowledge;
  content: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mfc-repository-knowledge-"));
  const workspace = join(root, "repo");
  mkdirSync(join(workspace, "docs", "domain"), { recursive: true });
  const content = "# 订单状态\n\n状态迁移必须经过领域服务。\n";
  writeFileSync(join(workspace, "docs", "domain", "orders.md"), content);
  return {
    root,
    workspace,
    content,
    selected: {
      id: "knowledge-1",
      repository: "https://codehub/team/orders.git",
      revision: "abc",
      title: "订单状态",
      description: "订单领域规则",
      relative_path: "docs/domain/orders.md",
      kind: "document",
      digest: hash(content),
      bytes: Buffer.byteLength(content),
    },
  };
}

test("只把本单选中的 docs 文档物化为只读快照", () => {
  const item = fixture();
  const result = materializeRepositoryKnowledge({
    selected: [item.selected],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: join(item.root, "snapshots"),
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].relative_path, item.selected.relative_path);
  assert.equal(readFileSync(result.entries[0].path, "utf-8"), item.content);
  assert.deepEqual(result.warnings, []);
});

test("版本漂移、软链、越界和错误仓只告警跳过，不形成任务门禁", () => {
  const item = fixture();
  const outside = join(item.root, "outside.md");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, join(item.workspace, "docs", "linked.md"));
  const result = materializeRepositoryKnowledge({
    selected: [
      { ...item.selected, digest: hash("old") },
      { ...item.selected, id: "linked", relative_path: "docs/linked.md" },
      { ...item.selected, id: "wrong", repository: "other" },
    ],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: join(item.root, "snapshots"),
  });
  assert.deepEqual(result.entries, []);
  assert.match(result.warnings.join("\n"), /版本不一致|软链接|不属于当前仓库/);
  assert.equal(validRepositoryKnowledgePath("docs/domain/orders.mdx"), true);
  assert.equal(validRepositoryKnowledgePath("../docs/orders.md"), false);
  assert.equal(validRepositoryKnowledgePath("src/orders.md"), false);
});
