import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
import type { TaskSummary } from "../../web/src/api";

const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async input => {
  const path = String(input);
  let value: unknown;
  if (/\/artifacts(?:\?|$)/.test(path) || path.endsWith("/reviews") || path === "/auth/committers") value = [];
  else if (path.endsWith("/conversation")) value = { items: [], problems: [], events_seen: 0 };
  else if (path.endsWith("/annotations")) value = { items: [], checks: [], closures: [] };
  else if (path === "/auth/people") value = [{ username: "owner" }, { username: "admin" }, { username: "observer" }];
  else if (path.endsWith("/developer-assistant")) value = {
    state: "idle", messages: [], tools: [],
    availability: { available: false, code: "core_unavailable", mode: "unavailable", reason: "界面验证" },
  };
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
};

const scenarios: { name: string; viewer: string; canOperate: boolean; status?: TaskSummary["status"]; mrState?: string; retry: boolean }[] = [
  { name: "owner-open", viewer: "owner", canOperate: true, retry: true },
  { name: "admin-other-task", viewer: "admin", canOperate: true, retry: false },
  { name: "observer", viewer: "observer", canOperate: false, retry: false },
  { name: "owner-readonly", viewer: "owner", canOperate: false, retry: false },
  { name: "completed", viewer: "owner", canOperate: true, status: "completed", retry: false },
  { name: "canceled", viewer: "owner", canOperate: true, status: "canceled", retry: false },
  ...["merged", "closed", "已合入", "已关闭"].map(mrState => ({
    name: mrState, viewer: "owner", canOperate: true, mrState, retry: false,
  })),
];
const root = createRoot(document.getElementById("app")!);
const buttons = (within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")];
const retryButtons = (within: ParentNode = document) => buttons(within)
  .filter(button => button.textContent?.trim() === "重试设置人员");
async function until(test: () => unknown, message: string) {
  for (let i = 0; i < 70 && !test(); i++) await pause();
  check(test(), message);
}

async function run() {
  for (const scenario of scenarios) {
    const task: TaskSummary = {
      id: `task-479-${scenario.name}`, title: `MR 人员重试 ${scenario.name}`, requirement: "核对人员设置",
      status: scenario.status ?? "verifying", luban_account: "owner",
      created_at: "2026-10-13T08:00:00Z", updated_at: "2026-10-13T08:00:00Z",
      progress: { phases: [], current_index: -1, current_phase: "交付验证", step: "核对人员设置" },
      delivery: { mr_url: "https://codehub.example.test/merge_requests/479", mr_state: scenario.mrState ?? "opened",
        mr_participants: { status: "failed", requested: { reviewers: ["reviewer"], approval_approvers: [] }, message: "账号未添加" } },
    };
    root.render(<TaskWorkspace key={task.id} task={task} viewerUsername={scenario.viewer}
      canOperate={scenario.canOperate} canOverride={scenario.viewer === "admin"} canCollaborate={false}
      canRequestReview={false} onChanged={() => {}} onClose={() => {}} />);
    await until(() => document.getElementById("app")?.textContent?.includes(task.title!), `${scenario.name}: workspace missing`);
    check(retryButtons().length === Number(scenario.retry), `${scenario.name}: wrong workspace retry permission`);
    const details = buttons().find(button => button.textContent?.trim().startsWith("任务详情"));
    check(details, `${scenario.name}: details action missing`);
    details!.click();
    await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes("MR 人员"), `${scenario.name}: MR details missing`);
    const dialog = document.querySelector('[role="dialog"]')!;
    check(retryButtons(dialog).length === Number(scenario.retry), `${scenario.name}: wrong inspector retry permission`);
    if (scenario.name === "admin-other-task") {
      check(buttons(dialog).some(button => button.textContent?.trim() === "纠正单号"), "MR permission changed unrelated administrator actions");
    }
    root.render(null);
    await until(() => !document.querySelector('[role="dialog"]'), `${scenario.name}: dialog did not close`);
  }
  check(!errors.length, errors.join("; "));
  return { passed: true, scenarios: scenarios.map(scenario => scenario.name), width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); })
  .finally(() => root.unmount());
