import { readFileSync } from "node:fs";

/** 需要集中比较组件时使用的可选分析方法，直接进入真实子会话。 */
export const COMPONENT_ANALYST = "component-plan-agent";
export const COMPONENT_ANALYST_MISSION = readFileSync(new URL("../skills/component-plan/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
export const COMPONENT_PLANNING_GUIDANCE = [
  "随着读取或修改代码，平台会提供与已观察接口、导入或原始写法相关的组件资料。先结合当前代码理解职责；同名或替代候选不代表已经确认适用，已有封装承担的责任不要在调用方重复实现。",
  "发现需要尚未了解的能力时，用 knowledge 的 search/component_context/read 查找正式指南，核对接入配置、适用条件和实际依赖。目录可翻页，未命中不等于没有组件。",
  "需要集中比较多个组件时，可用 Task(subagent_type=component-plan-agent, description=分析组件用法, prompt=实际代码入口、能力问题、仓库/语言/版本及已有实施计划路径) 执行 component-plan Skill。主 Agent 也可直接查阅；不为此新增阶段、审批或等待流程。",
].join("\n");

/** 子会话只继承统一知识与当前任务计划能力，不继承宿主动作或知识写入工具。 */
export function childKnowledgeTools(tools: unknown[] = []): unknown[] {
  return tools.filter(tool => !!tool && typeof tool === "object"
    && "name" in tool && tool.name === "knowledge");
}
