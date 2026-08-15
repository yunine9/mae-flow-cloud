/**
 * 类图解析。这块是"用户以为模型没干活"的直接成因:内置渲染器只认时序图,
 * 模型按批注画了类图,页面上落到"暂时无法安全绘制"——渲染缺口冒充成模型
 * 失职,是最坏的一种误导。
 *
 * 认不出的语法一律忽略,绝不猜:画错的图比不画更害人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { layerClasses, parseClassDiagram } from "../web/src/classModel.ts";

const REAL = `@startuml
skinparam packageStyle rectangle

package "notify-model" {
  enum ChannelType {
    EMAIL
    PUSH
  }
  class Notification
  class SendResult {
    +ok(detail): SendResult
    +isOk(): boolean
  }
}

package "notify-service" {
  interface ChannelHandler {
    +handle(notification, auditLog): SendResult
  }
  package "handler" {
    class PushChannelHandler {
      -MAX_BODY_LENGTH = 500
    }
    class NotifyRenderer {
      ~render(n, maxBodyLength): Rendered
    }
  }
}

PushChannelHandler ..|> ChannelHandler
PushChannelHandler ..> NotifyRenderer : render / allVariablesMissing
NotifyRenderer *-- Rendered : 渲染文本 + 降级标志
Notification --> ChannelType

note right of NotifyRenderer
  唯一实现的具体 final 类
end note
@enduml`;

test("类图:类/接口/枚举、成员、嵌套包全部认出来", () => {
  const model = parseClassDiagram(REAL)!;
  const find = (name: string) => model.nodes.find((n) => n.name === name)!;

  assert.equal(find("ChannelType").kind, "enum");
  assert.equal(find("ChannelHandler").kind, "interface");
  assert.equal(find("PushChannelHandler").kind, "class");

  // 嵌套包用 / 连接:handler 在 notify-service 里面
  assert.equal(find("PushChannelHandler").pkg, "notify-service/handler");
  assert.equal(find("SendResult").pkg, "notify-model");

  assert.deepEqual(find("ChannelType").members, ["EMAIL", "PUSH"]);
  assert.deepEqual(find("SendResult").members,
    ["+ok(detail): SendResult", "+isOk(): boolean"]);
  // 无花括号的类照样是节点,只是没成员
  assert.deepEqual(find("Notification").members, []);
});

test("类图:四种关系分得清,标签留住", () => {
  const model = parseClassDiagram(REAL)!;
  const edge = (from: string, to: string) =>
    model.edges.find((e) => e.from === from && e.to === to)!;

  // ..|> 同时含 `..` 和 `|>`,判断顺序错了就会被当成普通依赖
  assert.equal(edge("PushChannelHandler", "ChannelHandler").kind, "implements");
  assert.equal(edge("PushChannelHandler", "NotifyRenderer").kind, "uses");
  assert.equal(edge("NotifyRenderer", "Rendered").kind, "composes");
  assert.equal(edge("Notification", "ChannelType").kind, "uses");
  assert.equal(edge("PushChannelHandler", "NotifyRenderer").label,
    "render / allVariablesMissing");
});

test("类图:内部类 `+--` 认得出,且不当成组合", () => {
  // `+` 不在箭头字符集里时,`ConnPool +-- Connection` 整行不匹配、静静丢掉:
  // 源里 21 条关系图上只画 20 条,少一条没有任何提示,比画错还难发现。
  // 认出来之后也不能并进组合:内部类是"语法上嵌在里面",组合是"生命周期
  // 归它管",同一种线型会把两件事说成一件。
  const model = parseClassDiagram(`@startuml
class ConnPool
class Connection
class Holder
class Part
ConnPool +-- Connection : 内嵌占位连接
Holder *-- Part
@enduml`)!;
  assert.equal(model.edges.length, 2, "两条关系一条都不许丢");
  const nested = model.edges.find((e) => e.to === "Connection")!;
  assert.equal(nested.kind, "nests");
  assert.equal(nested.label, "内嵌占位连接");
  assert.equal(model.edges.find((e) => e.to === "Part")!.kind, "composes");
});

test("类图:只在关系里出现的类型补成节点——漏一个整张图就断", () => {
  const model = parseClassDiagram(REAL)!;
  const rendered = model.nodes.find((n) => n.name === "Rendered");
  assert.ok(rendered, "Rendered 只在关系里出现过,也必须是节点");
});

test("类图:note 块与 skinparam 一律跳过,不当成成员吞进来", () => {
  const model = parseClassDiagram(REAL)!;
  const renderer = model.nodes.find((n) => n.name === "NotifyRenderer")!;
  assert.ok(!renderer.members.some((line) => line.includes("唯一实现")),
    "note 正文不许混进类成员");
  assert.ok(!model.nodes.some((n) => n.name.includes("skinparam")));
});

test("类图:不是类图的源码返回 undefined,交给上层兜底", () => {
  assert.equal(parseClassDiagram("@startuml\nAlice -> Bob: hi\n@enduml"),
               undefined);
});

test("分层:被依赖的在上,依赖别人的在下;成环也不许转死", () => {
  const model = parseClassDiagram(`@startuml
class A
class B
class C
A --> B
B --> C
@enduml`)!;
  const laid = layerClasses(model);
  const layer = (name: string) => laid.find((n) => n.name === name)!.layer;
  assert.ok(layer("A") < layer("B"), "A 依赖 B,A 该在上面");
  assert.ok(layer("B") < layer("C"));

  const cyclic = parseClassDiagram(`@startuml
class X
class Y
X --> Y
Y --> X
@enduml`)!;
  const done = layerClasses(cyclic);      // 不抛错、不无限递归就算过
  assert.equal(done.length, 2);
});

test("分层:接口画在实现之上——按依赖方向直接排会读成倒的", () => {
  // UML 约定父类与接口在上、实现在下。按"谁依赖谁"直接排会把接口压到
  // 实现类底下:图没错,但读着是倒的,而类图的第一价值恰恰是一眼看出
  // 谁是抽象、谁是落地。
  const model = parseClassDiagram(`@startuml
class NotifyService
interface ChannelHandler
class PushChannelHandler
class EmailChannelHandler
NotifyService ..> ChannelHandler
PushChannelHandler ..|> ChannelHandler
EmailChannelHandler ..|> ChannelHandler
@enduml`)!;
  const laid = layerClasses(model);
  const layer = (name: string) => laid.find((n) => n.name === name)!.layer;

  assert.ok(layer("ChannelHandler") < layer("PushChannelHandler"),
    "接口必须在实现之上");
  assert.equal(layer("PushChannelHandler"), layer("EmailChannelHandler"),
    "同一个接口的实现应当并排在同一层");
  assert.ok(layer("NotifyService") < layer("ChannelHandler"),
    "调用方仍在被调用的抽象之上");
});
