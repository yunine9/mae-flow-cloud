import React from "react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { flushSync } from "../../web/node_modules/react-dom";
import { ComponentKnowledgeWorkspace } from "../../web/src/ComponentKnowledgeWorkspace";
import type { ComponentGovernanceSnapshot, ComponentGovernanceItem } from "../../src/componentKnowledgeTypes";

const rule: ComponentGovernanceItem = { id: "rule-thread", kind: "rule", original: "std::thread", source_digest: "abc",
  policy: { level: "shadow", source_digest: "abc", owner: "", scope: [], reason: "新候选，尚未人工启用", operator: "", updated_at: "" },
  paradigm: { component: "线程池", title: "后台任务的提交与等待", language: "cpp", need: "执行后台任务", api: ["Pool::Submit"], applicability: "已链接 Pool v2；底层线程适配器保留原生线程。",
    replaces: { identifiers: ["std::thread"], imports: [], patterns: [] }, document_id: "kd-pool", start_line: 24,
    evidence: [{ repository_id: "base", path: "src/pool.cpp", revision: "a".repeat(40), start: 30, end: 55 }], usage_evidence: ["everycode-example"] },
  samples: [{ id: "sample", repository: "https://code.example/consumer.git", checked_at: "2026-09-29", path: "src/work.cpp", line: 42, end_line: 42, rule_id: "rule-thread", need: "执行后台任务", component: "线程池", api: ["Pool::Submit"], applicability: "普通工作线程", document_id: "kd-pool", document_revision: "v1", document_line: 24, paradigm_id: "pool-submit", context: "void start() {\n  std::thread worker(run);\n  worker.join();\n}" }],
  stats: { observed: 1, reviewed: 0, exempt: 0, exemption_rate: null }, feedback: [], needs_review: false };
const data: ComponentGovernanceSnapshot = { revision: 0, items: [rule, { ...structuredClone(rule), id: "mapping-pool", kind: "mapping", samples: [] }], warnings: [], challenges: [], retention: "按当前版本与去重样本统计；尚未判断的样本不计入误报率。" };
const calls: string[] = []; let adopted = "";
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input); calls.push(path);
  if (init?.method === "POST") {
    const value = JSON.parse(init.body as string);
    if (path.endsWith("/policy")) { if (value.revision !== data.revision || !value.reason) throw new Error("策略字段缺失"); rule.policy = { ...rule.policy, ...value, operator: "组件负责人", updated_at: String(++data.revision) }; }
    if (path.endsWith("/feedback")) { rule.needs_review = true; rule.feedback.push({ ...value, id: "feedback", item_id: rule.id, at: "today", operator: "组件负责人" }); }
    if (path.endsWith("/challenge")) data.challenges.push({ id: "challenge", status: "done", stage: "反例研究已完成，请人工判断", draft: "## 找到合理反例\n基础仓启动适配器在任务池创建前需要原生线程。请收窄规则范围。", challenge: { item_id: rule.id, source_digest: rule.source_digest } });
    return Response.json({});
  }
  return Response.json(path === "/component-knowledge" ? data : path === "/tasks" ? [] : {});
};
const delay = () => new Promise(r => setTimeout(r, 20));
function button(text: string) { const el = [...document.querySelectorAll("button")].find(e => e.textContent?.trim() === text); if (!el) throw new Error("找不到按钮 " + text); flushSync(() => el.click()); }
function type(label: string, value: string) { const el = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement; if (!el) throw new Error("找不到字段 " + label); const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; flushSync(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function main() {
  const root = createRoot(document.getElementById("app")!);
  flushSync(() => root.render(<ComponentKnowledgeWorkspace open onClose={() => {}} onAdopt={id => { adopted = id; }} />));
  for (let i = 0; i < 40 && !document.body.textContent?.includes("std::thread →"); i++) await delay();
  flushSync(() => (document.querySelector('[aria-label="组件知识条目"] button') as HTMLButtonElement).click()); await delay();
  if (!document.body.textContent?.includes("src/work.cpp:42")) throw new Error("未显示实际命中位置");
  button("已启用提示"); type("组件负责人", "线程池负责人"); type("策略变更理由", "对照样本与实现确认普通工作线程适用"); type("适用路径", "src/**");
  button("保存策略"); await delay(); await delay();
  if (rule.policy.level !== "warning" || rule.policy.scope[0] !== "src/**") throw new Error("未保存人工策略");
  button("针对这处反馈"); type("反馈依据", "启动适配器必须使用原生线程，存在合法例外"); button("记录反馈"); await delay(); await delay();
  if (!rule.feedback.some(f => f.observation_id === "sample")) throw new Error("反馈未关联实际样本");
  button("寻找合理反例"); await delay(); await delay();
  if (!calls.some(c => c.endsWith("/challenge"))) throw new Error("未启动反例研究");
  button("查看并修正源文档 · 第 24 行"); if (adopted !== "kd-pool") throw new Error("源文档导航错误");
  button("已停用"); type("策略变更理由", "存在反例，先停用并收窄范围"); button("保存策略"); await delay(); await delay();
  if (String(rule.policy.level) !== "off") throw new Error("未停用规则");
  if (document.documentElement.scrollWidth > innerWidth) throw new Error("桌面横向溢出");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
main().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
