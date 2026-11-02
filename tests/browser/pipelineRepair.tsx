import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { IssueNavGroup } from "../../web/src/App";
import { PipelineRepairPanel } from "../../web/src/PipelineRepairPanel";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarProvider } from "../../web/src/components/ui/sidebar";
import type { IssueChildTab } from "../../web/src/issues/IssueBoard";
import type { PipelineRepairRecord } from "../../src/mrPipelineRepairTypes";

const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function until(test: () => unknown, message: string) { for (let i = 0; i < 60 && !test(); i++) await pause(); check(test(), message); }
function button(text: string, scope: ParentNode = document) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text);
  check(value, `按钮不存在：${text}`); return value!;
}
const calls: Array<{ url: string; method: string }> = [];
const now = "2026-11-02T08:00:00Z";
const record: PipelineRepairRecord = { id: "repair-current", account: "alice", mr_url: "https://codehub.test/team/repo/merge_requests/1288", round: 1,
  status: "repairing", message: "正在修复类型错误并执行本地编译、测试", created_at: now, updated_at: now,
  checks: [{ dimension: "COMPILE", status: "failed" }, { dimension: "UT", status: "not_run" }, { dimension: "CODECHECK", status: "pending" }],
  mr: { url: "https://codehub.test/team/repo/merge_requests/1288", iid: "1288", title: "认证模块配置修复", repo: "https://codehub.test/team/repo.git", source_branch: "feature/fix", target_branch: "main", sha: "a".repeat(40), state: "opened" },
  logs: [{ at: now, text: "已读取当前提交的编译错误日志" }, { at: now, text: "正在执行仓库标准构建与单元测试" }] };
let rows: PipelineRepairRecord[] = [], failRead = true;
const disabled = location.search.includes("disabled");
window.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? "GET"; calls.push({ url, method });
  if (!url.startsWith("/pipeline-repairs")) throw new Error(`不应调用需求或问题会话接口：${url}`);
  if (method === "GET") {
    if (failRead && !disabled) { failRead = false; return Response.json({ error: "平台暂时不可用" }, { status: 503 }); }
    return Response.json({ enabled: !disabled, reason: disabled ? "尚未配置交付平台，请联系管理员" : undefined, records: rows });
  }
  if (url.endsWith("/stop")) rows = [{ ...record, status: "stopped", message: "已停止，工作区和修复记录保留" }];
  else if (url.endsWith("/retry")) rows = [{ ...record, round: 2 }];
  else { check(JSON.parse(String(init?.body)).mr_url === record.mr_url, "提交 MR 链接"); rows = [record]; }
  return Response.json(rows[0], { status: method === "POST" ? 202 : 200 });
};

function Shell() {
  const [tab, setTab] = useState<IssueChildTab>("sessions");
  return <SidebarProvider style={{ "--sidebar-width": "228px" } as React.CSSProperties}>
    <Sidebar collapsible="none" className="sticky top-0 h-svh">
      <SidebarHeader><div className="px-4 py-5 text-base font-semibold">Mae-Flow</div></SidebarHeader>
      <SidebarContent className="sidebar-reset"><SidebarGroup><SidebarGroupLabel>个人工作台</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
        <IssueNavGroup view="issues" current="issues" childTab={tab} onSelectChild={setTab} onSelect={() => {}} />
      </SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
    </Sidebar>
    <SidebarInset><main className="mx-auto w-full max-w-(--page-width) px-10 py-8">
      <h1 className="mb-2 text-[28px] font-semibold text-text-strong">{tab === "pipeline" ? "流水线修复" : "问题会话"}</h1>
      <p className="mb-7 text-sm text-muted-foreground">{tab === "pipeline" ? "输入已有 MR，让 Agent 修复编译、测试和代码质量失败。" : "你的问题会话进展一览。"}</p>
      <PipelineRepairPanel visible={tab === "pipeline"} />
      <p hidden={tab === "pipeline"}>问题会话列表</p>
    </main></SidebarInset>
  </SidebarProvider>;
}
const root = createRoot(document.getElementById("app")!);
document.body.dataset.view = "issues";
root.render(<Shell />);
async function run() {
  await until(() => document.querySelector('[aria-label="问题处理"]'), "导航已加载");
  check(calls.length === 0, "隐藏面板不读修复接口");
  button("流水线修复").click();
  if (disabled) {
    await until(() => document.body.textContent?.includes("尚未配置交付平台"), "未配置原因可见");
    check(button("开始修复").disabled, "未配置不能启动"); return { passed: true, width: innerWidth, disabled: true };
  }
  await until(() => document.querySelector('[role="alert"]'), "读取失败可见"); button("刷新").click();
  await until(() => document.body.textContent?.includes("还没有修复记录"), "刷新后恢复");
  const input = document.querySelector<HTMLInputElement>("#pipeline-repair-url")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, record.mr_url);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  button("开始修复").click();
  await until(() => document.querySelector("article"), "显示新修复记录");
  check(document.querySelector("article")?.textContent?.includes("认证模块配置修复"), "显示真实 MR 标题");
  check(document.body.textContent?.includes("已读取当前提交"), "新记录自动展开过程");
  check(document.body.textContent?.includes("编译 · 未通过"), "检查维度与状态使用中文");
  button("停止修复").click(); await until(() => document.querySelector("article")?.textContent?.includes("已停止"), "停止状态可见");
  button("重试继续").click(); await until(() => document.querySelector("article")?.textContent?.includes("已进行 2 轮"), "重试保留原记录");
  button("问题会话").click(); await pause();
  const count = calls.length; await pause(4300); check(calls.length === count, "离开子页签停止轮询");
  check(document.querySelector<HTMLElement>('[aria-label="流水线修复"]')?.hidden, "切回会话时隐藏修复面板");
  button("流水线修复").click(); await pause();
  check(input.value === record.mr_url, "导航切换保留输入");
  const form = input.closest("form")!.getBoundingClientRect(), section = input.closest("section")!.getBoundingClientRect();
  check(form.right <= section.right && section.right <= innerWidth, "桌面布局无溢出");
  check(calls.every(call => call.url.startsWith("/pipeline-repairs")), "执行独立接口，不创建问题会话");
  return { passed: true, width: innerWidth, calls: calls.length };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
