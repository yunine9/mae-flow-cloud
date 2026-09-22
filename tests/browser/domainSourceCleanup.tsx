import { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeSourceCleanup } from "../../web/src/KnowledgeSourceCleanup";
import type { KnowledgeSourceCleanupState } from "../../src/domainKnowledgeTypes";
let started = false;
const calls: string[] = [];
let task = { source_cleanup: { repositories: [1, 2].map(i => ({ id: `repo-${i}`, name: `业务仓 ${i}`, repository: `https://example.test/repo${i}.git`, branch: "master", path: "", docs_path: "docs/old" })), plans: [], publications: [] } as KnowledgeSourceCleanupState };
window.fetch = async (input, init) => {
  const action = String(input).split("/").at(-1)!, body = JSON.parse(String(init?.body ?? "{}")); calls.push(action);
  const state = task.source_cleanup;
  if (action === "preview") state.plans = [...state.plans.filter(p => p.target_id !== body.target_id), { id: body.target_id, target_id: body.target_id, directories: body.no_cleanup ? [] : body.paths, target_revision: "a".repeat(40), target_entries: body.no_cleanup ? [] : [{ path: "docs/old/rules.md", mode: "100644", oid: "b".repeat(40) }, { path: "AGENTS.md", mode: "100644", oid: "c".repeat(40) }], document_versions: [], confirmed: false }];
  if (action === "confirm") { const plan = state.plans.find(p => p.id === body.plan_id)!; plan.confirmed = body.confirmed; plan.preserve_paths = body.preserve_paths ?? plan.preserve_paths; }
  if (action === "publish") for (const repo of state.repositories.filter(repo => Array.isArray(body.paths_by_target?.[repo.id]))) {
    state.publications = [...state.publications.filter(p => p.target_id !== repo.id), { target_id: repo.id, branch: "codex/cleanup", state: "opened", documents: [], url: `https://example.test/mr/${repo.id}`, mr_attempted: true }];
  }
  if (action === "start") { state.started = true; started = true; }
  return new Response(JSON.stringify(task), { headers: { "content-type": "application/json" } });
};
function App() { const [value, setValue] = useState(structuredClone(task)); return <div className="tw-root"><KnowledgeSourceCleanup task={value} endpoint="/domain-extraction/dkx" onChange={setValue} onStarted={() => {}} /></div>; }
createRoot(document.getElementById("app")!).render(<App />);
const pause = () => new Promise(r => setTimeout(r, 120));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function button(text: string) { const b = [...document.querySelectorAll("button")].find(b => b.textContent === text); assert(b, `Missing ${text}`); return b; }
async function click(text: string) { const b = button(text); assert(!b.disabled, `Disabled ${text}`); b.click(); await pause(); }
async function run() {
  await pause(); assert(!button("开始萃取").disabled, "Optional cleanup must not block extraction");
  assert(!document.querySelector('button[data-action="refresh"]'), "No MR gate control");
  assert(!button("一键创建所有清理 MR").disabled, "Default paths allow immediate creation without preview or confirmation");
  await click("一键创建所有清理 MR"); assert(!button("开始萃取").disabled, "Opened MR must not block manual start");
  assert(document.querySelector('a[href="https://example.test/mr/repo-1"]'), "MR link available");
  assert(document.querySelector('a[href="https://example.test/mr/repo-2"]'), "Every repository gets its own MR");
  await click("开始萃取");
  assert(started && calls.filter(c => c === "start").length === 1, "Exactly one extraction start");
  assert([...document.querySelectorAll<HTMLTextAreaElement>("textarea")].every(textarea => textarea.disabled), "Scope frozen after extraction start");
  assert(document.documentElement.scrollWidth <= innerWidth, "No horizontal overflow");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true });
}
run().catch(e => document.getElementById("result")!.textContent = JSON.stringify({ error: e.message }));
