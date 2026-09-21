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
  assert.match(COMPONENT_API_BOUNDARY,/候选也可加入审核清单，默认勾选供专家筛选/);
  assert.match(COMPONENT_API_BOUNDARY,/最佳示例必须站在组件使用方视角，推荐写法使用受支持的入口/);
  const tool = researchDocumentTool(input);
  assert.match(tool.description,/outline 登记细粒度能力及有研究价值的待核实候选/);
  assert.match(JSON.stringify(tool.parameters),/对外提供的证据/);
});

test("interface、IDL 和 POM 联合分析，候选可默认纳入审核但必须说明不确定性", () => {
  assert.match(COMPONENT_API_BOUNDARY,/重点关注 interface\/、idl\//);
  assert.match(COMPONENT_API_BOUNDARY,/POM 联合分析，不规定.*固定顺序/);
  assert.match(COMPONENT_API_BOUNDARY,/IDL、\.proto.*生成.*构建和发布产物/);
  assert.match(COMPONENT_API_BOUNDARY,/不以发布证明齐全作为准入条件/);
  assert.match(COMPONENT_API_BOUNDARY,/标题和 interfaces 必须标注‘待核实’/);
  assert.match(COMPONENT_API_BOUNDARY,/内部实现参考/);
  assert.match(COMPONENT_API_BOUNDARY,/默认勾选不等于专家已确认或推荐使用/);
  for (const mission of [jointResearchMission(input), componentResearchMission(component,"cpp","用法","sha",[component],true)]) {
    assert.doesNotMatch(mission,/只登记已确认对外|候选只记入研究记录/);
  }
});

test("开发范式共用接入示例要求：真实 include、构建依赖及库名，不强造 CMake 产物", () => {
  for (const clue of ["#include <...>", '#include "..."', "CMakeLists.txt", "find_package", "target_link_libraries", "target_include_directories", "实际 .so/.a/DLL", "Java 示例给出实际 import", "pom.xml 或 Gradle 依赖"]) {
    assert.ok(COMPONENT_API_BOUNDARY.includes(clue), `接入示例遗漏 ${clue}`);
  }
  assert.match(COMPONENT_API_BOUNDARY,/纯头文件库说明无需链接二进制库/);
  assert.match(COMPONENT_API_BOUNDARY,/非 CMake 项目.*不强造 CMake 包或 target/);
  assert.match(COMPONENT_API_BOUNDARY,/未找到时明确标注待核实，不猜名字/);
  assert.match(COMPONENT_API_BOUNDARY,/未经编译验证须注明/);
  const schema = JSON.stringify(researchDocumentTool(input).parameters);
  assert.match(schema,/#include.*CMakeLists\.txt.*target_link_libraries/);
});

test("SDK POM 必须实际读取并追踪发布关系，不把聚合或依赖清单当成对外 API", () => {
  assert.match(COMPONENT_API_BOUNDARY,/sdk\/pom\.xml；存在时必须实际读取/);
  for (const clue of ["modules", "parent", "properties", "profiles", "distributionManagement", "deploy", "groupId:artifactId:version", "packaging", "classifier"]) {
    assert.ok(COMPONENT_API_BOUNDARY.includes(clue), `发布判断遗漏 ${clue}`);
  }
  assert.match(COMPONENT_API_BOUNDARY,/modules 是需要继续核对的候选，不是对外发布白名单/);
  assert.match(COMPONENT_API_BOUNDARY,/dependencies\/dependencyManagement.*不自动成为本 SDK 对外提供的能力/);
  assert.match(COMPONENT_API_BOUNDARY,/BOM.*不能伪称可调用的运行时 JAR/);
  assert.match(COMPONENT_API_BOUNDARY,/配置不能证明某版本已实际发布/);
  assert.match(COMPONENT_API_BOUNDARY,/没有 sdk\/pom\.xml.*其他构建系统/);
  assert.match(COMPONENT_API_BOUNDARY,/不执行 Maven goal 或发布命令/);
  assert.match(JSON.stringify(researchDocumentTool(input).parameters),/sdk\/pom\.xml.*发布配置到制品坐标/);
});
