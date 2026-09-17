import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { COMPONENT_ANALYST, childKnowledgeTools } from "../src/componentKnowledgePlanning.ts";

for (const available of [true, false]) test(`组件子会话实际调用 knowledge 并更新计划；索引${available ? "就绪" : "不可用"}均能返回`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-"));
  const doc = saveKnowledgeDocument(dir, {title:"文件组件.md",content:"# 文件组件\n使用 TeamFile 写入；创建者释放，借用者不释放。"}, "member");
  const service = new KnowledgeSearch(dir, available ? {ingest:async()=>true,search:async()=>[{id:doc.id,heading:"文件组件",score:1}]} as any : undefined);
  const uses: unknown[] = [];
  const knowledge = createKnowledgeTool({service:()=>service,context:()=>({repo:"repo",repositories:[],moduleIds:[]}),onUse:e=>uses.push(e)});
  const control = defineTool({name:"push_branch",label:"push",description:"不应继承",parameters:Type.Object({}),execute:async()=>{throw new Error("不应调用");}});
  assert.deepEqual(childKnowledgeTools([knowledge, control, null, {}]), [knowledge]);
  const plan = join(dir, "implementation.md");
  writeFileSync(plan, "# 实施计划\n## 原有任务\n导出报告\n");
  const addition = available ? "\n## 组件与规范\n导出报告使用 TeamFile，创建者释放，借用者不释放。来源："+doc.id+" 第 1–2 行。\n" : "\n## 组件与规范\n知识检索暂不可用；按已有封装分析，API 待核实，不反复等待。\n";
  const scenes: Scene[] = [
    {tool:{name:"Task",input:{subagent_type:COMPONENT_ANALYST,description:"分析组件与规范",prompt:`分析 C++ 导出报告；只更新 ${plan} 的组件与规范部分。`}}},
    {tool:{name:"knowledge",input:{action:"search",query:"C++ 写入文件 句柄释放"}}},
    ...(available ? [{tool:{name:"knowledge",input:{action:"read",id:doc.id,start_line:1,end_line:2,revision:doc.revision}}}] : []),
    {tool:{name:"write",input:{path:plan,content:readFileSync(plan,"utf8")+addition}}},
    {text:"组件计划已更新，未修改业务代码。"},
    {text:"收到，按照组件与规范执行。"},
  ];
  const model = new ScriptedModelServer(scenes, "scripted-v1", {linear:true});
  let session: CloudSession | undefined;
  try {
    await model.start();
    const agentDir = join(dir,"agent");mkdirSync(agentDir);
    writeFileSync(join(agentDir,"models.json"),JSON.stringify(model.modelsJson()));
    const events = new EventLog(join(dir,"events.jsonl"));
    session = await CloudSession.create({taskId:"component-test",workspace:dir,agentDir,provider:"maeflow",model:"scripted-v1",eventLog:events,
      transcript:new TranscriptStore(join(dir,"transcript.jsonl"),"main"),gate:new GateService({workspace:dir,cwd:dir}),humanGate:new HumanGate(join(dir,"waiting.json")),extraTools:[knowledge,control]});
    const outcome = await session.start("制定实施计划");
    assert.equal(outcome.status,"turn_finished");
    assert.equal(events.replay().find(e=>e.kind==="agent_finished")?.payload.lifecycle,"returned");
    const childRequest = model.requests[1] as any;
    const names = childRequest.tools.map((t:any)=>t.function?.name ?? t.name);
    assert.ok(names.includes("knowledge"));assert.ok(!names.includes("push_branch"));
    assert.match(JSON.stringify(childRequest),/组件与规范分析 Agent/);
    assert.match(JSON.stringify(model.requests[0]),/component-knowledge-agent/);
    assert.match(readFileSync(plan,"utf8"),/原有任务/);
    assert.match(readFileSync(plan,"utf8"),available ? /TeamFile/ : /待核实/);
    if (available) {assert.equal(uses.length,2);assert.match(JSON.stringify(model.requests[3]),/创建者释放/);}
  } finally {session?.dispose();await model.stop();rmSync(dir,{recursive:true,force:true});}
});
