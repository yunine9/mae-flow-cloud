/**
 * 服务端 PlantUML 出图的契约。真件优先:本机有 Java 就真渲;没有就显式
 * skip 并明说(静默跳过等于假装测过)。没有 Java 时仍能验的两条不 skip:
 * 出不了图必须给原因、不许抛;空源码不起进程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findJava, renderPlantUml, PLANTUML_JAR } from "../src/plantumlRender.ts";
import { existsSync } from "node:fs";

const java = findJava();
const SKIP = java ? false : "本机没有 Java(生产宿主有):真渲染用例跳过,只验 fail-open";

test("空源码与缺失运行库:直接给原因,不起进程、不抛", async () => {
  assert.deepEqual(await renderPlantUml("   "), { error: "没有 PlantUML 源码" });
  const missing = await renderPlantUml("A -> B", { jar: "/nonexistent/plantuml.jar" });
  assert.match(missing.error ?? "", /运行库缺失/);
  assert.ok(existsSync(PLANTUML_JAR), "vendor 里的 jar 必须随仓库在");
});

test("没有 Java 时 fail-open:返回原因,页面显示源码", { skip: java ? "本机有 Java,此用例不适用" : false }, async () => {
  const result = await renderPlantUml("A -> B");
  assert.equal(result.svg, undefined);
  assert.match(result.error ?? "", /没有 Java/);
});

test("真渲染:组件图含中文出 SVG;第二次命中缓存", { skip: SKIP }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mfc-puml-"));
  const source = [
    "@startuml", 'package "notify-service" {', "  [MessageAssembler]", "  [Notification]", "}",
    "[notify-web] --> [Notification] : 解析 tenantId", "@enduml",
  ].join("\n");
  const first = await renderPlantUml(source, { cacheDir });
  assert.equal(first.error, undefined, first.error);
  assert.match(first.svg ?? "", /^<(\?xml|svg)/);
  assert.match(first.svg ?? "", /tenantId/);
  assert.equal(first.syntax_error, undefined);
  const second = await renderPlantUml(source, { cacheDir });
  assert.equal(second.cached, true);
  assert.equal(readdirSync(cacheDir).length, 1);
});

test("真渲染:语法错误照样给图(标出错行)并标 syntax_error", { skip: SKIP }, async () => {
  const result = await renderPlantUml("@startuml\n[Notification] : 六字段含 tenantId\n@enduml");
  assert.equal(result.syntax_error, true);
  assert.match(result.svg ?? "", /^<(\?xml|svg)/);
});

test("真渲染:预算到期终止,不无限等", { skip: SKIP }, async () => {
  const result = await renderPlantUml("A -> B", { timeoutMs: 1 });
  assert.match(result.error ?? "", /超过 .* 秒/);
});
