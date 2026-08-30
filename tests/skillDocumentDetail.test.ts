import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const apiSource = readFileSync(resolve("web/src/api.ts"), "utf-8");
const panelSource = readFileSync(
  resolve("web/src/KnowledgeFlywheel.tsx"), "utf-8");

test("Skill 正文接口前端契约同时携带正文与整包指纹", () => {
  assert.match(apiSource,
    /interface HostSkillDocument \{[\s\S]*digest: string;[\s\S]*package_digest: string;/);
});

test("Skill 清单深链同时对拍正文与整包后才展示全文", () => {
  assert.match(panelSource,
    /value\.digest !== initialAsset\.digest\s*\|\| value\.package_digest !== initialAsset\.packageDigest/);
  assert.match(panelSource,
    /value\.digest !== expected\.digest\s*\|\| value\.package_digest !== expected\.packageDigest/);
  assert.match(panelSource,
    /focusedVersionVerified \? "清单版本已对拍" : "正在对拍清单版本"/);
  assert.match(panelSource, /\{document && <pre>\{document\.content\}<\/pre>\}/,
    "未完成双指纹核对时不能先渲染正文");
});
