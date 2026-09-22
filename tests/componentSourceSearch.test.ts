import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { languageComponentSourceTool } from "../src/componentResearchTools.ts";

test("源码搜索支持多词任意命中、短语、大小写与逐仓范围", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-search-"));
  try {
    const sources = new Map<string, { root: string; revision: string }>();
    for (const id of ["repo-1", "repo-2"]) {
      const dir = join(root, id); mkdirSync(join(dir, "src"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      git("init");
      writeFileSync(join(dir, "src/code.txt"), id === "repo-1" ? "CODC module\npci policy\nMRO feature\nfull phrase\n-e literal\n" : "SECOND_ONLY\n");
      writeFileSync(join(dir, "outside.txt"), "OUTSIDE_ONLY\n");
      git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
      sources.set(id, { root: dir, revision: git("rev-parse", "HEAD") });
    }
    const components = [...sources.keys()].map(id => ({ id, name: id, description: "fixture", repository: `https://example.test/${id}`, branch: "master", path: "src", languages: ["cpp"], enabled: true }));
    const tool = languageComponentSourceTool(components, async c => sources.get(c.id)!, () => {});
    const search = async (input: object) => {
      const result = await tool.execute("test", { action: "search", component_id: "repo-1", ...input }, undefined, undefined, {} as never);
      return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
    };
    const multiple = await search({ keywords: ["CODC", "PCI", "MRO"] });
    assert.match(multiple, /CODC module/); assert.match(multiple, /pci policy/); assert.match(multiple, /MRO feature/);
    assert.match(multiple, /repo-1.*example.test\/repo-1/); assert.match(multiple, /范围：src/); assert.match(multiple, /多关键词任意命中；忽略大小写/);
    assert.match(await search({ query: "CODC PCI MRO mro pci codc" }), /没有命中.*keywords/);
    assert.match(await search({ query: "full phrase" }), /full phrase/);
    assert.match(await search({ keywords: ["PCI"], ignore_case: false }), /没有命中/);
    assert.match(await search({ keywords: ["-e"] }), /-e literal/);
    assert.match(await search({ keywords: ["SECOND_ONLY"] }), /没有命中/);
    assert.match(await search({ component_id: "repo-2", keywords: ["SECOND_ONLY"] }), /SECOND_ONLY/);
    assert.match(await search({ keywords: ["OUTSIDE_ONLY"] }), /没有命中/);
    assert.match(await search({ query: "CODC", keywords: ["PCI"] }), /只能填写一个/);
    assert.match(await search({ keywords: [""] }), /非空字符串/);
    assert.match(await search({ keywords: ["CODC\nPCI"] }), /不能包含换行/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
