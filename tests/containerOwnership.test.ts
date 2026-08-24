/** Root 守护进程把实际 bind 工作区交给非 root 容器用户的回归。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareContainerHostPaths,
  repairContainerKernelOwnership,
  repairContainerMutationOwnership,
  rootContainerOwner,
} from "../src/containerOwnership.ts";

test("只有 Linux root 宿主需要 chown，且必须给数字非 root uid:gid", () => {
  assert.equal(rootContainerOwner("10001:10001", {
    platform: "linux", effectiveUid: 1000,
  }), undefined);
  assert.equal(rootContainerOwner("10001:10001", {
    platform: "darwin", effectiveUid: 0,
  }), undefined);
  assert.deepEqual(rootContainerOwner("10001:10002", {
    platform: "linux", effectiveUid: 0,
  }), { uid: 10001, gid: 10002 });
  for (const invalid of [undefined, "builder:builder", "10001", "0:10001", "10001:0"]) {
    assert.throws(() => rootContainerOwner(invalid, {
      platform: "linux", effectiveUid: 0,
    }), /数字 uid:gid|正整数/);
  }
});

test("工作区与四类缓存统一交给容器用户，符号链接不跟随到外部", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-"));
  const workspace = join(root, "repo");
  const nested = join(workspace, "src");
  const outside = join(root, "outside.txt");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "main.ts"), "export {};\n");
  writeFileSync(outside, "do not follow\n");
  symlinkSync(outside, join(workspace, "outside-link"));
  const cache = join(root, "cache");
  const markerRoot = join(root, "ownership-markers");
  const volumes: string[] = [];
  for (const name of ["maven", "npm", "ccache", "xdg"]) {
    const path = join(cache, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "seed"), name);
    volumes.push(`${path}:/cache/${name}`);
  }

  const currentUid = process.getuid?.();
  const currentGid = process.getgid?.();
  assert.notEqual(currentUid, undefined);
  assert.notEqual(currentGid, undefined);
  // 普通开发机只能 chown 给自己；root CI 则故意换一个 uid/gid，证明
  // 外部文件不会被工作区里的软链连带修改。
  const uid = currentUid === 0 ? 12345 : currentUid!;
  const gid = currentGid === 0 ? 12345 : currentGid!;
  const outsideBefore = statSync(outside);
  const prepared = prepareContainerHostPaths({
    workspace,
    volumes,
    markerRoot,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(prepared.active, true);
  assert.equal(prepared.cacheTrees, 4);
  assert.equal(statSync(workspace).uid, uid);
  assert.equal(statSync(join(nested, "main.ts")).uid, uid);
  assert.equal(lstatSync(join(workspace, "outside-link")).uid, uid);
  assert.equal(statSync(outside).uid, outsideBefore.uid,
    "工作区软链不能把 chown 带到宿主其他文件");
  for (const name of ["maven", "npm", "ccache", "xdg"]) {
    assert.equal(statSync(join(cache, name, "seed")).uid, uid);
  }

  const repeated = prepareContainerHostPaths({
    workspace,
    volumes,
    markerRoot,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(repeated.cacheTrees, 0, "缓存属主正确后不应每单递归重扫");
});

test("bind 工作区根本身是软链时拒绝，不能把宿主路径偷换出去", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-link-"));
  const outside = join(root, "outside");
  const linked = join(root, "workspace");
  mkdirSync(outside);
  symlinkSync(outside, linked, "dir");
  assert.throws(() => prepareContainerHostPaths({
    workspace: linked,
    volumes: [],
    markerRoot: join(root, "markers"),
    user: "10001:10001",
    runtime: { platform: "linux", effectiveUid: 0 },
  }), /挂载根不能是符号链接/);
});

test("宿主 Write/Edit 后只修实际工作区文件与父目录，不碰仓外材料", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-write-"));
  const workspace = join(root, "repo");
  const source = join(workspace, "src", "new", "Main.java");
  const outside = join(root, "pipeline.log");
  mkdirSync(join(workspace, "src", "new"), { recursive: true });
  writeFileSync(source, "class Main {}\n");
  writeFileSync(outside, "failed\n");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const outsideBefore = statSync(outside);
  assert.equal(repairContainerMutationOwnership({
    workspace,
    path: "src/new/Main.java",
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  }), true);
  assert.equal(statSync(source).uid, uid);
  assert.equal(statSync(join(workspace, "src", "new")).uid, uid);
  assert.equal(repairContainerMutationOwnership({
    workspace,
    path: "../pipeline.log",
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  }), false);
  assert.equal(statSync(outside).uid, outsideBefore.uid);
});

test("宿主内核原子换新的状态文件会立即交还容器用户", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-container-owner-kernel-"));
  mkdirSync(join(workspace, ".mae-flow", "evidence"), { recursive: true });
  writeFileSync(join(workspace, ".mae-flow.json"), "{}\n");
  writeFileSync(join(workspace, ".mae-flow", "evidence", "state.json"), "{}\n");
  writeFileSync(join(workspace, "README.md"), "business\n");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const readmeBefore = statSync(join(workspace, "README.md"));
  repairContainerKernelOwnership({
    workspace,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(statSync(join(workspace, ".mae-flow.json")).uid, uid);
  assert.equal(statSync(join(workspace, ".mae-flow", "evidence", "state.json")).uid,
    uid);
  assert.equal(statSync(join(workspace, "README.md")).uid, readmeBefore.uid,
    "内核收口不能顺带遍历业务源码");
});
