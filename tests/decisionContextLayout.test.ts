import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");

test("决策背景展开后由外层真实占位，不能与后续问题重叠", () => {
  const legacyWorkspaceRule = css.indexOf(".ws-decision .waiting-context {");
  const layoutOverride = css.lastIndexOf(".ws-decision .waiting-context {");
  assert.ok(legacyWorkspaceRule >= 0, "应覆盖工作台原有的决策背景规则");
  assert.ok(layoutOverride > legacyWorkspaceRule,
    "解除高度上限的规则必须位于旧工作台规则之后，才能赢得层叠");

  const overrideBody = css.slice(layoutOverride, layoutOverride + 120);
  assert.match(overrideBody, /max-height:\s*none/);
  assert.match(overrideBody, /overflow:\s*visible/);
});
