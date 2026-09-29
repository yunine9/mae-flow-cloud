import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DomainKnowledgeExtraction } from "../../web/src/DomainKnowledgeExtraction";

const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const calls: any[] = [];
const job = { id: "dkx-probe", issue_no: "SKILL-PROBE", title: "无线 / 邻区发现", scope: "仅验证邻区发现", probe: { module: "邻区发现" },
  operator: "test", created_at: "2026-09-28", repositories: [{ id: "repo-1", name: "radio", repository: "https://example.test/radio.git", branch: "master", path: "", docs_path: "docs" }],
  knowledge_target: { id: "domain", name: "领域", repository: "", branch: "master", path: "", docs_path: "domains" },
  material_ids: [], ar_codes: [], use_wxdoubao: true, status: "done", stage: "验证完成", revisions: {}, turns: [], evidence: [], publications: [],
  documents: [{ id: "result", title: "邻区发现约束", layer: "domain", target_id: "domain", path: "domains/result.md", content: "# 邻区发现\n\n这里显示本次验证草稿。", sources: "源码、上传业务资料及无线豆包", selected: true, revision: 1, history: [] }] };
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined; let result: unknown;
  if (path === "/business-modules") result = { modules: [{ id: "wireless", name: "无线领域", status: "active", repositories: ["https://example.test/radio.git"] }] };
  else if (path === "/domain-extraction/probes" && !input) result = { records: [job] };
  else if (path === "/domain-extraction") { if (input) { calls.push(input); result = { ...job, probe: undefined, instructions: input.instructions }; } else result = { records: [] }; }
  else if (path === "/domain-extraction/dkx-probe") result = job;
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text && b.getClientRects().length);
async function click(text: string) { const b = button(text); check(b && !b.disabled, `missing/disabled ${text}`); b!.click(); await pause(); }
createRoot(document.getElementById("app")!).render(<DomainKnowledgeExtraction />);
async function run() {
  for (let i = 0; i < 50 && !button("＋ 新建萃取任务"); i++) await pause();
  check(!document.body.textContent?.includes("Skill 效果验证（临时）"), "old URL uses the unified entry");
  for (let i = 0; i < 50 && !document.querySelector('[aria-label="萃取任务列表"] button'); i++) await pause();
  const old = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="萃取任务列表"] button')].find(b => b.textContent?.includes(job.title))!;
  check(old, "historical probe remains in task list"); old.click(); await pause();
  await click("查看验证草稿");
  check(document.body.textContent?.includes("这里显示本次验证草稿"), "old draft remains readable");
  check(!button("入库与更新") && !button("清理旧知识") && !button("仅讨论"), "historical probe remains draft only");
  await click("＋ 新建萃取任务");
  check(document.querySelector('[aria-label="本次萃取要求"]'), "new task has free text instructions");
  check(document.querySelector('[aria-label="领域萃取关联单号"]') && !document.querySelector('[aria-label="仅验证的模块"]'), "new task always uses the standard form");
  check(!button("开始单模块验证") && button("开始萃取"), "no separate temporary creation action");
  check(document.documentElement.scrollWidth <= innerWidth + 1, "desktop has no horizontal overflow");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
