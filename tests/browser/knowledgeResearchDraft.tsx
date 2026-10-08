import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";

const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const scenario = new URLSearchParams(location.search).get("scenario");
const calls: Array<{ path: string; input?: any }> = [];
const skill = { name: "领域萃取方法", digest: "a".repeat(64), can_manage: true, versions: [], files: { "SKILL.md": "# 领域萃取方法\n\n先阅读业务材料。" } };
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, input }); let result: unknown;
  if (path === "/business-modules") result = { modules: [{ id: "trade", name: "交易业务", repositories: ["https://example.test/trade.git"], status: "active", assets: [] }], warnings: [], operations: [] };
  else if (path === "/knowledge-tasks") result = { tasks: [], summary: { running: 0, attention: 0, total: 0 }, warnings: [] };
  else if (path === "/memory-insights") result = { memories: [], repos: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/skills") result = { skills: [], operations: [], warnings: [] };
  else if (path === "/knowledge-extraction/skills/domain") {
    if (input) Object.assign(skill, { files: input.files, digest: "b".repeat(64) });
    result = skill;
  } else if (path === "/knowledge-materials") result = { id: "material-fixture", name: input.name, version: "v2", scope: "本次萃取任务", state: "ready", sections: 2 };
  // 验证创建请求即结束，不让模拟研究体掩盖草稿是否清理。
  else if (path === "/domain-extraction" && input) return new Response(JSON.stringify({ error: "fixture: create unavailable" }), { status: 500 });
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
root.render(<KnowledgeLibrary onOpenTask={() => {}} />);
const visible = (e: Element) => !!e.getClientRects().length;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(e => visible(e) && e.textContent?.trim() === text);
async function click(text: string) { const e = button(text); check(e && !e.disabled, `missing enabled button ${text}`); e!.click(); await pause(); }
async function waitFor(selector: string) { for (let i = 0; i < 40 && !document.querySelector(selector); i++) await pause(); check(document.querySelector(selector), `missing ${selector}; route=${location.search}`); }
async function fill(selector: string, value: string) {
  const e = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; check(e, `missing ${selector}`);
  Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(e, value);
  e.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function pick(selector: string, files: File[]) {
  const list = new DataTransfer(); files.forEach(file => list.items.add(file));
  const field = document.querySelector<HTMLInputElement>(selector)!; check(field, `missing ${selector}`);
  field.files = list.files; field.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
const description = "核对退款规则", issue = "REQ-449", goal = "只研究退款规则", branch = "feature/refunds";
const value = (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value;
async function run() {
  await waitFor('[aria-label="研究知识"]'); await pause();
  await fill('[aria-label="单号描述"]', description);
  await fill('input[placeholder="需求或问题单号"]', issue);
  if (scenario === "description") {
    check(value('[aria-label="单号描述"]') === description, "填单号后，先填写的单号描述被清空");
    await fill('input[placeholder="需求或问题单号"]', "REQ-450");
    check(value('[aria-label="单号描述"]') === description, "修改单号不应清空人工描述");
  } else {
    // 单独隔离导航缺陷，不被描述清空缺陷提前中断。
    await fill('[aria-label="单号描述"]', description);
    await fill('.field-pair input', branch); await fill('textarea', goal);
    // 避免 Chrome 虚拟时钟先于文件 I/O 超时。
    const OriginalReader = window.FileReader;
    (window as any).FileReader = class { result = "data:text/plain;base64,IyBydWxlcw=="; onload?: () => void; readAsDataURL() { this.onload?.(); } };
    await pick('input[aria-label="上传业务资料"]', [new File(["# rules"], "业务.md")]);
    window.FileReader = OriginalReader;
    await click("萃取方法"); await waitFor('[aria-label="平台 Skill 详情"]');
    check(!button("开始研究"), "方法阅读页不显示研究表单");
    if (scenario === "method") {
      check(button("更新方法") && !button("上传新版本") && !button("保存并用于新任务"), "方法页只显示一个更新入口");
      await click("更新方法"); await waitFor('[role="menuitem"]');
      check([...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent?.trim()).join("/") === "选择 Skill 目录/选择 SKILL.md", "更新入口提供整包和单文件两种选择");
      await click("更新方法");
      const content = "# 修订方法\n\n核对退款规则后独立复核。";
      const file = new File([content], "SKILL.md");
      Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(content).buffer });
      await pick('input[aria-label="上传平台 SKILL.md"]', [file]);
      check(button("确认更新") && button("取消") && !button("更新方法") && !button("使用此 Skill"), "预览阶段只有确认更新和取消");
      check(document.querySelector('[aria-label="Skill 文件正文"]')?.textContent?.includes("独立复核"), "更新前显示新方法预览");
      check(!calls.some(c => c.path.endsWith("/domain") && c.input), "选择文件不直接更新公共方法");
      await click("取消");
      check(document.querySelector('[aria-label="Skill 文件正文"]')?.textContent?.includes("先阅读业务材料"), "取消预览恢复当前方法");
      await pick('input[aria-label="上传平台 SKILL.md"]', [file]); await click("确认更新");
      const writes = calls.filter(c => c.path === "/knowledge-extraction/skills/domain" && c.input);
      check(writes.length === 1 && writes[0].input.files["SKILL.md"] === content && writes[0].input.expected_digest === "a".repeat(64), "确认只提交一次完整内容和当前版本");
      check(button("更新方法") && !button("确认更新") && document.querySelector('[role="status"]')?.textContent?.includes("已更新"), "更新完成回到方法阅读页");
      check(document.documentElement.scrollWidth <= innerWidth + 2, "方法页不能横向溢出");
      if (!(window as any).__KEEP_RESEARCH_PREVIEW__) root.unmount();
      return { passed: true };
    } else if (scenario === "return") {
      // 使用产品提供的返回入口，不能靠测试直接重写地址。
      const back = [...document.querySelectorAll<HTMLButtonElement>("button")].find(e => visible(e) && (e.textContent?.trim() === "返回研究知识" || e.textContent?.trim() === "返回知识库"));
      check(back, "萃取方法缺少返回入口"); back!.click(); await pause();
    } else if (scenario === "history") { history.back(); await pause(); }
    else await click("使用此 Skill");
    check(new URLSearchParams(location.search).get("kbPage") === "research", "从方法页返回应回到之前的研究表单");
    await waitFor('[aria-label="研究知识"]');
    check(value('input[placeholder="需求或问题单号"]') === issue, "返回后关联单号丢失");
    check(value('[aria-label="单号描述"]') === description, "返回后单号描述丢失");
    check(value('.field-pair input') === branch && value('textarea') === goal, "返回后基准分支或研究要求丢失");
    check(document.querySelector('[aria-label="业务资料上传"]')?.textContent?.includes("业务.md"), "返回后上传资料丢失");
    check(document.querySelector('[aria-label="知识归属"]')?.textContent?.includes("交易业务"), "返回后业务模块丢失");
    await click("开始研究");
    const submitted = calls.find(c => c.path === "/domain-extraction" && c.input)?.input;
    check(submitted?.issue_no === issue && submitted.issue_description === description && submitted.baseline_branch === branch && submitted.instructions === goal && submitted.material_ids[0] === "material-fixture", "恢复后的全部信息需进入创建请求");
    // 创建失败后离开再回来，也必须保留输入。
    await click("萃取方法"); await waitFor('[aria-label="平台 Skill 详情"]'); await click("使用此 Skill");
    check(value('[aria-label="单号描述"]') === description, "创建失败不能删除草稿");
  }
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面窗口不能横向溢出");
  if (!(window as any).__KEEP_RESEARCH_PREVIEW__) root.unmount(); return { passed: true };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });
