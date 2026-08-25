import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { PlantUml } from "../web/src/PlantUml.tsx";
import {
  inspectTopology, looksLikeTopology, parseTopology, type TopologyView,
} from "../web/src/topologyModel.ts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const VIEWS: Array<{ view: TopologyView; caption: RegExp; source: string }> = [
  {
    view: "component",
    caption: /组件\/开发视图/,
    source: `@startuml
title 开发视图
package "probe-service" {
  component "CrossRatValidator" as Validator
  component "FreqBidirectionalMap" as Map
}
Validator --> Map : merge / conflict check
@enduml`,
  },
  {
    view: "deployment",
    caption: /部署\/物理视图/,
    source: `@startuml
title 物理视图
node "应用节点" as App {
  artifact "probe-service.jar" as Jar
}
database "配置库" as DB
cloud "上游网管" as NMS
NMS --> App : import
App --> DB : query
@enduml`,
  },
  {
    view: "usecase",
    caption: /用例\/场景视图/,
    source: `@startuml
left to right direction
actor "审核人" as Reviewer
rectangle "小鲁班" {
  usecase "查看全部待办" as View
  usecase "自由回复" as Reply
}
Reviewer --> View
View --> Reply
@enduml`,
  },
  {
    view: "state",
    caption: /状态视图/,
    source: `@startuml
[*] --> Draft
state Draft
state Waiting
state Done
Draft --> Waiting : submit
Waiting --> Done : approve
Waiting --> Waiting : retry
Done --> [*]
@enduml`,
  },
];

const FOUR_PLUS_ONE = [
  {
    name: "逻辑视图",
    caption: /类图 · 内置渲染/,
    source: "@startuml\nclass Validator\nclass FrequencyMap\nValidator --> FrequencyMap\n@enduml",
  },
  {
    name: "进程视图",
    caption: /时序图 · 内置渲染/,
    source: "@startuml\nparticipant Importer\nparticipant Validator\nImporter -> Validator: check\n@enduml",
  },
  { name: "开发视图", caption: VIEWS[0].caption, source: VIEWS[0].source },
  { name: "物理视图", caption: VIEWS[1].caption, source: VIEWS[1].source },
  { name: "+1 场景视图", caption: VIEWS[2].caption, source: VIEWS[2].source },
];

test("4+1 五种视图在 Story 中都有确定的内置渲染路径", () => {
  for (const sample of FOUR_PLUS_ONE) {
    const html = renderToStaticMarkup(React.createElement(PlantUml, {
      source: sample.source,
    }));
    assert.match(html, sample.caption, sample.name);
    assert.doesNotMatch(html, /暂时无法安全绘制/, sample.name);
  }
});

test("4+1 缺失视图：组件、部署、用例和状态图都能完整解析", () => {
  for (const sample of VIEWS) {
    assert.ok(looksLikeTopology(sample.source), sample.view);
    const model = parseTopology(sample.source);
    assert.ok(model, sample.view);
    assert.equal(model.view, sample.view);
    assert.ok(model.nodes.length >= 3, sample.view);
    assert.ok(model.edges.length >= 1, sample.view);
  }
});

test("4+1 缺失视图全部进入架构 SVG，并显示对应视图名称", () => {
  for (const sample of VIEWS) {
    const html = renderToStaticMarkup(React.createElement(PlantUml, {
      source: sample.source,
    }));
    assert.match(html, /aria-label="PlantUML 架构拓扑图"/, sample.view);
    assert.match(html, sample.caption, sample.view);
    assert.doesNotMatch(html, /暂时无法安全绘制/, sample.view);
  }
});

test("组件图不会再被宽松的时序解析器抢去画", () => {
  const component = VIEWS[0].source;
  const html = renderToStaticMarkup(React.createElement(PlantUml, {
    source: component,
  }));
  assert.doesNotMatch(html, /时序图 · 内置渲染/);
  assert.match(html, /组件\/开发视图 · 内置渲染/);
});

test("组件依赖数据库仍是开发视图，不能仅凭 database 猜成物理部署", () => {
  const model = parseTopology(`@startuml
component Service
database Store
Service --> Store
@enduml`);
  assert.equal(model?.view, "component");
});

test("状态自循环画成可见回环，不退化成零长度路径", () => {
  const html = renderToStaticMarkup(React.createElement(PlantUml, {
    source: VIEWS[3].source,
  }));
  assert.match(html, /retry/);
  assert.match(html, /class="topology-edge" d="M[^"]+C[^"]+"/);
});

test("架构图未知语法和未闭合分组都给准确行号", () => {
  const unknown = inspectTopology(`@startuml
component A
together {
component B
}
A --> B
@enduml`);
  assert.equal(unknown.model, undefined);
  assert.equal(unknown.issue?.line, 3);
  assert.match(unknown.issue?.message ?? "", /暂不支持.*together/);

  const unclosed = inspectTopology(`@startuml
node "应用节点" as App {
  component Service
@enduml`);
  assert.equal(unclosed.model, undefined);
  assert.equal(unclosed.issue?.line, 2);
  assert.match(unclosed.issue?.message ?? "", /缺少右大括号/);
});
