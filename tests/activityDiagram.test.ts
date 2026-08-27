import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { PlantUml } from "../web/src/PlantUml.tsx";
import {
  inspectActivity, looksLikeActivity, parseActivity, type ActivityItem,
} from "../web/src/activityModel.ts";

// 根测试运行器按 classic JSX 装载 web 组件；生产 Vite 使用 automatic。
// 补上同一个 React 实例后即可做服务端静态渲染断言。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const STORY_FLOW = `@startuml
title checkDbCrossRat 校验流程（修改后）

start
:遍历 ratFreqMap 各 RAT;

partition "loadDbFreqMap（含neKey）" {
  :通过 RatStrategy.loadDbFreqData\\n查询 DB freq+featureId+neKey;
  :遍历 DB 行，调用\\ndbMap.put(freq, featureId, neKey);
  note right: neKey 传入 FreqBidirectionalMap\\nNR NSA 第二组同理
}

partition "DB+import 交叉冲突检测" {
  :mergedMap = new FreqBidirectionalMap;
  :mergedMap.merge(importMap);
  :mergedMap.merge(dbMap);

  :one2nViolations = mergedMap.checkOneToN();
  :n2oneViolations = mergedMap.checkNToOne();

  :对每个 Violation v;
  if (v.conflictNeKeys 非空?) then (是 — DB侧有冲突网元)
    :格式化 neKey 列表\\n（上限10 + "等N个"）;
    :使用新消息键\\nprobe.validation.freq.db.conflict\\n生成 ValidationError;
  else (否 — 仅batch内冲突)
    :使用原有消息键\\nprobe.validation.freq.one2n / n2one\\n生成 ValidationError;
  endif
}

stop
@enduml`;

const ACTOR_SEQUENCE_WITH_END = `@startuml
actor user
participant system
user -> system: request
alt success
  system --> user: done
else failed
  system --> user: retry
end
@enduml`;

function flatten(items: ActivityItem[]): ActivityItem[] {
  return items.flatMap((item) => item.kind === "partition"
    ? [item, ...flatten(item.items)]
    : item.kind === "decision"
      ? [item, ...flatten(item.thenItems), ...flatten(item.elseItems)]
      : [item]);
}

test("story 活动图完整识别 partition、注释和 if/else，不再降级成源码", () => {
  assert.ok(looksLikeActivity(STORY_FLOW));
  const model = parseActivity(STORY_FLOW)!;
  assert.equal(model.title, "checkDbCrossRat 校验流程（修改后）");
  assert.deepEqual(model.items.map((item) => item.kind),
    ["start", "action", "partition", "partition", "stop"]);

  const all = flatten(model.items);
  const partitions = all.filter((item) => item.kind === "partition");
  assert.deepEqual(partitions.map((item) => item.label),
    ["loadDbFreqMap（含neKey）", "DB+import 交叉冲突检测"]);
  const note = all.find((item) => item.kind === "note");
  assert.equal(note?.kind === "note" ? note.text : "",
    "neKey 传入 FreqBidirectionalMap\\nNR NSA 第二组同理");
  const decision = all.find((item) => item.kind === "decision");
  assert.equal(decision?.kind === "decision" ? decision.condition : "",
    "v.conflictNeKeys 非空?");
  assert.equal(decision?.kind === "decision" ? decision.thenItems.length : 0, 2);
  assert.equal(decision?.kind === "decision" ? decision.elseItems.length : 0, 1);
});

test("story 活动图走活动图组件，关键步骤、分区和图注都进入 SVG", () => {
  const html = renderToStaticMarkup(React.createElement(PlantUml, {
    source: STORY_FLOW,
  }));
  assert.match(html, /aria-label="PlantUML 活动图"/);
  assert.match(html, /活动图 · 内置渲染/);
  assert.match(html, /loadDbFreqMap（含neKey）/);
  assert.match(html, /probe\.validation\.freq\.db\.conflict/);
  assert.doesNotMatch(html, /暂时无法安全绘制/);
});

test("actor + alt/end 是时序图，bare end 不能把它误判成活动图", () => {
  assert.equal(looksLikeActivity(ACTOR_SEQUENCE_WITH_END), false);
  const html = renderToStaticMarkup(React.createElement(PlantUml, {
    source: ACTOR_SEQUENCE_WITH_END,
  }));
  assert.match(html, /aria-label="PlantUML 时序图"/);
  assert.match(html, /时序图 · 内置渲染/);
  assert.doesNotMatch(html, /检测到活动图/);
  assert.doesNotMatch(html, /暂时无法安全绘制/);
});

test("活动图仍可用 end 作为 stop，只是不拿 end 单独判图型", () => {
  const source = `@startuml
start
:执行校验;
end
@enduml`;
  assert.equal(looksLikeActivity(source), true);
  const model = parseActivity(source);
  assert.deepEqual(model?.items.map((item) => item.kind),
    ["start", "action", "stop"]);
});

test("活动图不认识的语法明确给出行号，不静默丢掉后继续画", () => {
  const result = inspectActivity(`@startuml
start
:已支持;
fork
:不能被悄悄忽略;
stop
@enduml`);
  assert.equal(result.model, undefined);
  assert.equal(result.issue?.line, 4);
  assert.match(result.issue?.message ?? "", /暂不支持.*fork/);
});

test("活动图结构没闭合时明确指出 if，而不是画半张图", () => {
  const result = inspectActivity(`@startuml
start
if (ok?) then (是)
  :继续;
stop
@enduml`);
  assert.equal(result.model, undefined);
  assert.equal(result.issue?.line, 3);
  assert.match(result.issue?.message ?? "", /if 缺少 endif/);
});
