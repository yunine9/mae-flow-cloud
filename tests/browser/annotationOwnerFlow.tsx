import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { AnnotationPanel } from "../../web/src/AnnotationPanel";
import { annotationClosures } from "../../src/feedbackPolicy";
import type { Annotation } from "../../src/annotations";

let rows: Annotation[] = [{ id: "one", author: "reviewer", created_at: new Date().toISOString(), artifact: "design.md",
  file: "design.md", line: 1, anchor: "订单同步", note: "请明确上游超时后的处理方式", kind: "doc", route: "owner_reply", assignee: "owner", status: "draft" }];
let refresh = () => {};
let viewer = "owner";
window.fetch = async (input, init) => {
  const url = String(input), item = rows[0], body = JSON.parse(String(init?.body || "{}"));
  if (init?.method === "DELETE") rows = [];
  else if (url.endsWith("/reply")) { item.owner_reply = { author: "owner", text: body.text, replied_at: new Date().toISOString() }; item.status = "sent"; item.sent_via = "owner_pending"; }
  else if (url.endsWith("/resolve")) { item.status = "verified"; item.resolution = { ...body, by: "owner", at: new Date().toISOString() }; }
  else if (url.endsWith("/reopen")) { item.status = "draft"; item.resolution = undefined; item.owner_reply = undefined; item.sent_via = undefined; item.rework = (item.rework || 0) + 1; }
  else if (url.endsWith("/send")) { if (body.context !== "保留接口兼容性") throw Error("补充说明没有随原意见发送"); item.agent_context = { text: body.context, by: "owner", at: new Date().toISOString(), revision: item.rework ?? 0 }; item.status = "sent"; item.sent_via = "interrupt"; item.agent_assigned = true; }
  return new Response(JSON.stringify({ sent: ["one"] }));
};
function App() {
  const [, update] = useState(0); refresh = () => update((n) => n + 1);
  const closures = annotationClosures(rows, { task_status: "running", task_owner: "owner", owner_controlled: true,
    review_ready: false, review_annotation_ids: [], archival: false }, { username: viewer, can_override: false, can_route_others: viewer === "owner" });
  return <AnnotationPanel taskId="task" viewerUsername={viewer} items={rows} checks={[]} closures={closures}
    canOperate={viewer === "owner"} taskStatus="running" onChanged={refresh} />;
}
createRoot(document.getElementById("app")!).render(<App />);
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label);
async function run() {
  await pause();
  if (!button("删除") || !button("交给 Agent") || !button("自行答复") || button("确认闭环")) throw Error("待处理按钮不正确");
  button("自行答复")!.click(); await pause();
  const input = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "超时保持原数据，允许稍后重试");
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  button("保存答复")!.click(); await pause();
  if (!button("确认闭环")) throw Error("答复后未出现闭环");
  button("确认闭环")!.click(); await pause();
  if (!button("重新处理")) throw Error("闭环后不能变卦");
  button("重新处理")!.click(); await pause();
  if (!button("交给 Agent") || button("确认闭环")) throw Error("重新处理未回到待处理");
  viewer = "reviewer"; refresh(); await pause();
  if (button("删除") || button("自行答复") || button("交给 Agent")) throw Error("非责任人出现操作入口");
  viewer = "owner"; refresh(); await pause();
  button("交给 Agent")!.click(); await pause();
  if (!button("发送给 Agent")) throw Error("未显示补充说明入口");
  const context = document.querySelector<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(context, "保留接口兼容性");
  context.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  button("发送给 Agent")!.click(); await pause();
  if (button("删除") || button("确认闭环")) throw Error("Agent 处理中仍可删除或闭环");
  rows = [{ ...rows[0], id: "two", status: "draft", agent_assigned: false, sent_via: undefined }]; refresh(); await pause();
  button("删除")!.click(); await pause();
  if (document.querySelector(".annot-item")) throw Error("删除后意见仍留在列表");
  rows = [{ id: "preview", author: "reviewer", created_at: new Date().toISOString(), artifact: "design.md", file: "design.md",
    line: 12, anchor: "订单同步", note: "请明确上游超时后的处理方式", kind: "doc", route: "owner_reply", assignee: "owner",
    status: "sent", sent_via: "owner_pending", owner_reply: { author: "owner", text: "超时保持原数据，允许稍后重试。", replied_at: new Date().toISOString() } }];
  refresh(); await pause();
  return "passed";
}
run().then((result) => document.getElementById("result")!.textContent = result)
  .catch((error) => document.getElementById("result")!.textContent = String(error));
