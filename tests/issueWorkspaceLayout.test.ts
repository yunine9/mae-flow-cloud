/**
 * 问题工作台(v2 studio 骨架)左栏高度契约:ws-evidence 是滚动容器,
 * 左栏面板必须生长吃满余量——否则短内容下方整段留白(2026-09-09 用户
 * 报告:对话现场只占上半屏)。ADR-0018 骨架重排把旧 issue-two-pane 的
 * 拉伸链留在死代码里,这里把新骨架的契约钉住,防止再被重排丢掉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const style = readFileSync(
  join(process.cwd(), "web/src/style.css"), "utf8");

test("问题工作台 v2:左栏面板在 ws-evidence 里生长吃满余量", () => {
  const rule = style.match(
    /\.issue-workspace\.task-workspace-v2 \.ws-evidence \.issue-main-pane \{[^}]*\}/);
  assert.ok(rule, "v2 骨架的 issue-main-pane 规则必须在场");
  assert.match(rule[0], /flex:\s*1\s*1\s*auto/,
    "面板必须 flex 生长,否则短内容下方整段留白");
});

test("问题工作台 v2:四个材料页签根节点同构拉伸并自滚", () => {
  const rule = style.match(
    /\.issue-workspace\.task-workspace-v2 \.issue-main-pane > \.issue-materials \{[^}]*\}/);
  assert.ok(rule, "材料页签的拉伸规则必须在场");
  assert.match(rule[0], /flex:\s*1/, "材料根必须吃满面板");
  assert.match(rule[0], /overflow-y:\s*auto/, "材料根自滚,长文档不撑破面板");
});

test("对话现场的直播流保持内滚链:面板体与流都是 flex 且流不设帽", () => {
  const body = style.match(
    /\.issue-main-pane > \.event-panel-body \{[^}]*\}/);
  assert.ok(body, "event-panel-body 规则必须在场");
  assert.match(body[0], /flex:\s*1/, "面板体吃满左栏");
  const stream = style.match(
    /\.issue-main-pane > \.event-panel-body > \.event-stream \{[^}]*\}/);
  assert.ok(stream, "event-stream 规则必须在场");
  assert.match(stream[0], /flex:\s*1/, "直播流吃满面板体");
  assert.match(stream[0], /max-height:\s*none/,
    "工作台内直播流不设 540px 帽(贴底跟随依赖吃满)");
});
