import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ComponentResearch } from "../../web/src/ComponentResearch";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";

const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const repos = ["文件基础库", "异步调用库"].map((name, i) => ({id:`repo-${i}`,name,repository:`https://code.example/r${i}.git`,branch:"main",path:"",languages:["cpp"],description:"",enabled:true}));
const record: ComponentResearchRecord = {
  id:"cr-browser",mode:"all",format:"joint-document",topic:"基础组件联合使用指南",language:"cpp",operator:"专家",
  component:repos[0],components:repos,status:"done",stage:"草稿待审查",created_at:"2026-09-21T08:00:00Z",evidence:[],
  document:{overview:"文件基础库提供句柄管理，异步调用库在其上实现取消与回调。调用方先初始化资源，再提交异步操作，最后等待回调释放。",sections:["安全打开与关闭", "异步读取与取消", "批量写入与错误恢复", ...Array.from({length:32}, (_,i) => `组件能力 ${i+4}：资源管理与错误恢复`)].map((title,i) => ({
    id:`cap-${i}`,title,repository_ids:i === 1 ? ["repo-0","repo-1"] : ["repo-0"],selected:true,revision:1,
    content:Array.from({length:12}, () => "适用于需要明确资源所有权的操作。失败时先检查错误码，关闭已获得的资源；不得在回调结束前销毁句柄。").join("\n\n"),
    interfaces:"`include/file.h`：Open / Close；`include/async.h`：ReadAsync / Cancel。",
    integration:"链接 `libfile.so`，异步能力另依赖 `libasync.so`；CMake target：file、async。",
    example:"根据接口整理，未编译验证。\n```cpp\n#include <file.h>\nint main() {\n  auto handle = Open(\"sample.txt\");\n  if (!handle) return 1;\n  Close(handle);\n  return 0;\n}\n```",
    sources:"文件基础库 · include/file.h:12 · revision abc123；异步调用库 · tests/read.cpp:34。",related_ids:i === 1 ? ["cap-0"] : [],
  }))},review_turns:[],
};
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const calls: any[] = [];
window.fetch = async (url, options) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  let result: unknown;
  if (path === "/component-repositories") result = {components:repos};
  else if (path === "/business-modules") result = {modules:[]};
  else if (path === "/component-research") result = {records:[record]};
  else if (path.endsWith("/selection")) {
    calls.push({action:"selection",...body});
    for (const section of record.document!.sections) if (body.ids.includes(section.id)) section.selected = body.selected;
    result = record;
  } else if (path.endsWith("/review")) {
    calls.push({action:"review",...body});
    const section = record.document!.sections.find(s => s.id === body.section_id)!;
    const proposal = body.mode === "rework" ? { base_revision: section.revision, section: { ...section, revision: section.revision + 1, content: section.content + " 返工已补充取消时的资源释放说明。" }, status: "pending" as const } : undefined;
    record.review_turns!.push({proposal,id:`turn-${calls.length}`,...body,operator:"专家",status:"done",reply:"已核对来源，仅处理当前能力，其他组件保持原样。",created_at:new Date().toISOString()});
    result = record;
  } else if (path.endsWith("/proposal")) {
    const turn = record.review_turns!.find(t => t.id === body.turn_id)!;
    const index = record.document!.sections.findIndex(s => s.id === turn.proposal!.section.id);
    record.document!.sections[index] = turn.proposal!.section; turn.proposal!.status = "accepted"; result = record;
  } else if (path === "/component-research/cr-browser") result = record;
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result),{headers:{"Content-Type":"application/json"}});
};
const root = createRoot(document.getElementById("app")!);
root.render(<ComponentResearch open onClose={() => {}} onAdopt={() => {}} />);
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
async function click(text: string) {check(button(text),`missing button ${text}`);button(text).click();await pause();}
async function message(value: string) {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="组件讨论或返工意见"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,value);
  field.dispatchEvent(new Event("input",{bubbles:true}));await pause();
}
async function run() {
  for (let i=0;i<60 && !document.querySelector('[aria-label="组件审核工作区"]');i++) await pause();
  const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[aria-label="组件能力目录"] input[type="checkbox"]')];
  check(boxes().length === record.document!.sections.length && boxes().every(b => b.checked), "all discovered capabilities must default selected");
  await click("全不选");check(boxes().every(b => !b.checked),"unselect all");
  await click("全选");boxes()[2].click();await pause();check(!boxes()[2].checked,"single checkbox selection");
  const capability = [...document.querySelectorAll<HTMLButtonElement>('button.knowledge-outline-title')].find(b => b.textContent?.includes("异步读取"))!;
  capability.click();await pause();
  const outline = document.querySelector('[aria-label="知识主题与章节"]')!;
  check(!outline.textContent?.includes("include/file.h"), "knowledge outline excludes source paths");
  [...outline.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "公共接口")!.click(); await pause();
  check(document.activeElement?.textContent === "公共接口", "chapter navigation focuses rendered heading");
  const before = JSON.stringify(record.document!.sections[0]);
  await message("为什么取消后仍需要等待回调？");await click("仅讨论");
  check(record.document!.sections[1].revision === 1,"discussion must not mutate draft");
  await message("请补充取消后的资源释放顺序");await click("生成修订建议");
  check(record.document!.sections[1].revision === 1,"unaccepted proposal must not mutate draft");
  await click("修订差异");await click("采纳此建议");await click("正文");
  check(record.document!.sections[1].revision === 2,"target must be revised");
  check(JSON.stringify(record.document!.sections[0]) === before,"other capability must remain unchanged");
  check(calls.filter(c => c.action === "review").every(c => c.section_id === "cap-1"),"dialogue must target selected capability");
  check(document.querySelector('[aria-label="组件专家对话"]')?.textContent?.includes("为什么取消"),"conversation history retained");
  await click("完整文档");
  check(document.querySelectorAll('[aria-label="完整文档阅读区"] .knowledge-markdown').length === record.document!.sections.length,"single document includes all chapters");
  check(document.querySelector('[aria-label="文档组件目录"]'),"navigable directory");
  await click("逐项审核");
  const list = document.querySelector<HTMLElement>('[aria-label="知识主题与章节"]')!;
  const reader = document.querySelector<HTMLElement>('[aria-label="组件详细文档"]')!;
  const outer = document.querySelector("main")!;
  const outerTop = outer.scrollTop;
  check(list.scrollHeight > list.clientHeight && reader.scrollHeight > reader.clientHeight, "both long panes must have bounded independent scroll areas");
  list.scrollTop = 180;
  reader.scrollTop = 220;
  await pause();
  check(list.scrollTop === 180 && reader.scrollTop === 220 && outer.scrollTop === outerTop, "scroll positions must stay independent");
  check(getComputedStyle(list).overscrollBehaviorY === "auto" && getComputedStyle(reader).overscrollBehaviorY === "auto", "wheel at a boundary can continue scrolling the parent");
  const next = [...list.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("批量写入"))!;
  next.click();await pause();
  check(reader.scrollTop === 0 && list.scrollTop === 180, "switching component resets document only");
  list.scrollTop = 0;
  const workspace = document.querySelector('[aria-label="组件审核工作区"]')!;
  check(workspace.scrollWidth <= workspace.clientWidth + 2,"desktop workspace horizontal overflow");
  check(document.documentElement.scrollWidth <= innerWidth + 2,"desktop page horizontal overflow");
  check(!errors.length,errors.join(";"));
  document.querySelector("main")!.scrollTop = 0;
  return {passed:true,width:innerWidth,selected:boxes().filter(b => b.checked).length,turns:record.review_turns!.length};
}
if (!new URLSearchParams(location.search).has("scrollCheck")) run().then(value => {document.getElementById("result")!.textContent = JSON.stringify(value);})
  .catch(error => {document.getElementById("result")!.textContent = JSON.stringify({error:String(error)});});
