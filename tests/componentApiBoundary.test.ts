import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPONENT_API_BOUNDARY } from "../src/componentApiBoundary.ts";
import { componentResearchMission } from "../src/componentResearchAgent.ts";
import { jointResearchMission, researchDocumentTool } from "../src/componentResearchDocumentTool.ts";
import type { ResearchExecution } from "../src/componentResearch.ts";

const component = {id:"repo",name:"SDK",repository:"https://code.example/sdk.git",branch:"main",path:"",languages:["cpp","java"],enabled:true,
  description:"本仓重点分析 interface/，impl/ 只读实现，不是对外接口"};
const input: ResearchExecution = {
  record:{id:"cr-boundary",mode:"all",format:"joint-document",component,components:[component],language:"cpp",topic:"联合研究",operator:"expert",key:"test",
    status:"running",stage:"研究中",created_at:"2026-09-21",evidence:[],document:{overview:"",sections:[]}},
  root:"/unused",signal:new AbortController().signal,update:() => {},evidence:() => {},
};

test("全量、主题、历史逐仓研究以及专家讨论/返工共用对外接口边界", () => {
  for (const language of ["cpp","java"]) for (const discover of [false,true]) {
    const mission = componentResearchMission(component,language,"用法","sha",[component],discover);
    assert.ok(mission.includes(COMPONENT_API_BOUNDARY));
    assert.ok(mission.includes(component.description),"按仓保留灵活的接口目录提示");
  }
  for (const mode of [undefined,"discuss","rework"] as const) {
    const mission = jointResearchMission({...input,review:mode ? {id:"r",section_id:"api",mode,message:"核对对外边界",operator:"expert",status:"running",created_at:"2026-09-21"} : undefined});
    assert.ok(mission.includes(COMPONENT_API_BOUNDARY));
    assert.match(mission,/而非让每个内部模块都成为一项/);
    if (mode) assert.match(mission,/本轮只处理组件 api/);
  }
});

test("interface 是优先线索而非固定白名单，可见性、已调用与发布支持分开判断", () => {
  assert.match(COMPONENT_API_BOUNDARY,/不是 public 的都能用/);
  assert.match(COMPONENT_API_BOUNDARY,/interface 是优先线索，不是固定白名单/);
  assert.match(COMPONENT_API_BOUNDARY,/不能排除其他目录中有发布依据的接口/);
  assert.match(COMPONENT_API_BOUNDARY,/跨仓调用可能是历史违规用法/);
  assert.match(COMPONENT_API_BOUNDARY,/不能把 JAR 中所有 public 类当 API/);
  assert.match(COMPONENT_API_BOUNDARY,/提示不能授权越界/);
  assert.match(COMPONENT_API_BOUNDARY,/候选只记入研究记录，不作为默认全选/);
  assert.match(COMPONENT_API_BOUNDARY,/最佳示例必须站在组件使用方视角，只用已确认对外的入口/);
  const tool = researchDocumentTool(input);
  assert.match(tool.description,/outline 只登记已确认对外提供/);
  assert.match(JSON.stringify(tool.parameters),/对外提供的证据/);
});
