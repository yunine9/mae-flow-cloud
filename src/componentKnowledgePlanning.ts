import { readFileSync } from "node:fs";

/** issue 446 skill 是唯一的组件分析工作方法，直接进入真实子会话。 */
export const COMPONENT_ANALYST = "component-plan-agent";
export const COMPONENT_ANALYST_MISSION = readFileSync(new URL("../skills/component-plan/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
export const COMPONENT_PLANNING_GUIDANCE = [
  "制定 implementation 实施计划、尚未写业务代码时，需要组件选型则用 Task(subagent_type=component-plan-agent, description=制定组件使用计划, prompt=完整任务上下文) 执行 component-plan Skill；纯文案或无组件变化的小修复可跳过。",
  "任务卡提供需求、实际仓库/模块/语言/版本、相关代码入口、已有 implementation 的准确路径；只更新其中组件使用计划，保留其他内容。派发期间不同时编辑该文件，可以继续独立勘察。",
  "子 Agent 返回后读取同一计划，把组件选择与设计约束落实到实施任务；需求未变不重复派发。实现完成后用 knowledge(action=plan, operation=check_impl, plan_path=实施计划路径) 对照。不能派发时主 Agent 用 knowledge 的 component_context/search/read/plan 完成同样工作，不新建阶段或等待流程。",
].join("\n");

/** 子会话只继承统一知识与当前任务计划能力，不继承宿主动作或知识写入工具。 */
export function childKnowledgeTools(tools: unknown[] = []): unknown[] {
  return tools.filter(tool => !!tool && typeof tool === "object"
    && "name" in tool && tool.name === "knowledge");
}
