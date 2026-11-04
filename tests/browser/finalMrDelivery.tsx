import { createRoot } from "../../web/node_modules/react-dom/client";
import { DeliveryAnalytics } from "../../web/src/DeliveryAnalytics";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
import type { TaskSummary } from "../../web/src/api";
import type { DeliveryAnalysisRow, MrComparisonDetail } from "../../src/deliveryAnalyticsTypes";

const root = createRoot(document.getElementById("app")!);
const initialUrl = "https://codehub.example.test/orders/merge_requests/114";
const finalUrl = "https://codehub.example.test/orders/merge_requests/126";
const when = "2026-11-04T02:36:00Z";
const sourceFile = "src/order/retry.ts";
let task: TaskSummary = { id: "task-orders", title: "订单查询超时重试", requirement: "订单查询超时后再尝试一次", status: "await_merge",
  status_label: "等待合入", ticket: "REQ-1846", luban_account: "chen", created_at: when,
  delivery: { mr_url: initialUrl, mr_state: "打开", initial_mr: { url: initialUrl, head: "a".repeat(40) } } };
const row: DeliveryAnalysisRow = { id: task.id, title: task.title!, delivery_id: "r2", at: when, completed_at: when, repo: "orders",
  modules: [], merged: true, mr_url: finalUrl, initial_mr_url: initialUrl, mr_comparison: { method: "patch", initial_head: "a".repeat(40), final_head: "b".repeat(40),
    retained: 8, removed: 1, added: 4, files: [
      { path: sourceFile, retained: 7, removed: 1, added: 3, changed: true },
      { path: "tests/retry.test.ts", retained: 1, removed: 0, added: 1, changed: true },
    ] } };
const comparison: MrComparisonDetail = { comparison_basis: "head", truncated: false, files: [
  { path: sourceFile, change_patch: "@@ -12,3 +12,5 @@\n   if (response.timedOut) {\n-    return fail(response);\n+    const retry = await queryOrder(id);\n+    return retry.ok ? retry.order : fail(retry);\n   }",
    initial_patch: "@@ -12,0 +12,1 @@\n+    return fail(response);", final_patch: "@@ -12,0 +12,2 @@\n+    const retry = await queryOrder(id);\n+    return retry.ok ? retry.order : fail(retry);", truncated: false },
  { path: "tests/retry.test.ts", change_patch: "+expect(attempts).toBe(2);", initial_patch: "", final_patch: "+expect(attempts).toBe(2);", truncated: false },
] };
const calls: Array<{ url: string; method: string; body?: string }> = [];
let rejectLink = true;
window.fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: init?.body?.toString() });
  if (url === "/tasks/task-orders/final-mr") {
    if (rejectLink) return Response.json({ error: "最终 MR 不属于当前仓库" }, { status: 400 });
    task = { ...task, delivery: { ...task.delivery, final_mr: { id: 126, repo: "orders", url: finalUrl,
      source_branch: "dev/retry-order", target_branch: "main", state: "opened" } } };
    return Response.json(task);
  }
  if (url === "/delivery-analytics") return Response.json({ generated_at: when, rows: [row] });
  if (url === "/tasks/task-orders/final-mr-comparison?generation=r2") return Response.json(comparison);
  if (url === "/technology-stacks") return Response.json({ stacks: [] });
  if (url.includes("/annotations")) return Response.json({ items: [], checks: [], closures: [] });
  if (url.includes("/conversation")) return Response.json({ items: [], problems: [] });
  if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url === "/auth/people" || url === "/auth/committers") return Response.json([]);
  return Response.json({}, { status: 404 });
};

function assert(result: unknown, message: string): asserts result {
  if (!result) throw new Error(message);
}
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(test: () => unknown, message: string) {
  for (let index = 0; index < 70 && !test(); index++) await pause();
  assert(test(), message);
}
function button(label: string) {
  const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  assert(target, "未找到按钮 " + label);
  return target;
}
function renderWorkspace(owner = true) {
  root.render(<TaskWorkspace task={task} viewerUsername={owner ? "chen" : "guest"} canOverride={false} canCollaborate={owner}
    canRequestReview={false} canOperate={owner} onChanged={() => renderWorkspace(owner)} onClose={() => {}} />);
}
async function run() {
  if (new URLSearchParams(location.search).has("deliveryTask")) {
    root.render(<main className="tw-root p-8"><DeliveryAnalytics onOpenTask={() => {}} /></main>);
    await until(() => document.querySelector('pre[aria-label="从初版到最终版代码"]'), "打开分析详情应自动展示首个变化文件");
    const panel = document.querySelector('[aria-label="初版与最终版的代码差异"]')!;
    assert(panel.textContent?.includes("-    return fail(response);") && panel.textContent?.includes("+    const retry"), "差异须含实际前后代码");
    assert(panel.querySelector('a')?.href === initialUrl && panel.querySelectorAll('a')[1]?.href === finalUrl, "必须链接两份真实 MR");
    assert(!document.querySelector(".delivery-detail-body")?.textContent?.includes("交付代码行数：0 行"), "归因缺失不可报零行");
    button("tests/retry.test.ts").click();
    await until(() => document.querySelector('pre[aria-label="从初版到最终版代码"]')?.textContent?.includes("toBe(2)"), "切换文件应更新代码");
    assert(calls.filter(call => call.url.includes("final-mr-comparison")).length === 1, "同一轮交付的证据按需读取一次");
    button(sourceFile).click(); await pause();
  } else {
    renderWorkspace();
    await until(() => [...document.querySelectorAll("button")].some(el => el.textContent?.startsWith("任务详情")), "应能从工作台打开任务详情");
    button("任务详情 ↗").click(); await until(() => document.querySelector('[data-slot="dialog-content"]'), "打开详情");
    button("关联最终 MR").click(); await pause();
    const field = document.querySelector<HTMLInputElement>('input[type="url"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, finalUrl);
    field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    button("保存关联").click();
    await until(() => document.body.textContent?.includes("最终 MR 不属于当前仓库"), "被拒绝时应留在表单并显示原因");
    rejectLink = false;
    button("保存关联").click();
    await until(() => document.querySelector('a[href="' + finalUrl + '"]'), "成功后出现最终 MR 链接");
    assert(document.querySelector('a[href="' + initialUrl + '"]'), "关联后原 MR 仍可打开");
    assert(calls.filter(call => call.method === "POST").every(call => call.url === "/tasks/task-orders/final-mr" && JSON.parse(call.body!).url === finalUrl), "关联只提交最终链接");
    renderWorkspace(false); await pause();
    assert(![...document.querySelectorAll("button")].some(el => el.textContent === "更换最终 MR"), "只读访客不可更换最终 MR");
    renderWorkspace(); await pause(); button("更换最终 MR").click(); await pause();
    if (new URLSearchParams(location.search).has("completed")) {
      task = { ...task, status: "completed", status_label: "已完成", completed_at: when, delivery: { ...task.delivery,
        mr_state: "已合入", final_mr: { ...task.delivery!.final_mr!, state: "merged" } } };
      renderWorkspace(); await pause();
      assert(document.querySelector('a[href="/?deliveryAnalysis=1&deliveryTask=task-orders"]'), "任务完成应能直达本次交付的代码差异");
      assert(!document.querySelector('input[type="url"]'), "已完成任务不可再次更换关联");
    }
  }
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
