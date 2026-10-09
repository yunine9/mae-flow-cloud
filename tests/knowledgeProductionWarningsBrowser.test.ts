import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { componentKnowledgeTask, domainKnowledgeTask, listKnowledgeTasks } from "../src/knowledgeTaskCenter.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { KnowledgeTaskCenterData } from "../src/knowledgeTaskCenterTypes.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const repository = { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains" };
function write(dir: string, relative: string, text: string) {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function productionMatrix(): KnowledgeTaskCenterData {
  const tasks: KnowledgeTaskCenterData["tasks"] = [];
  for (const state of ["ready", "running", "opened", "failed"] as const) for (const kind of ["domain", "component"] as const) {
    const job: DomainKnowledgeJob = { id: `dkx-${kind}-${state}`, title: `${kind} 人工归档 ${state}`, scope: "当前正式知识归档", operator: "alice", created_at: "2026-10-03T00:00:00Z", issue_no: "REQ-MATRIX", repositories: [], knowledge_target: repository, material_ids: [], status: state === "failed" ? "failed" : "done", stage: state === "failed" ? "本轮研究失败" : "已入库", error: state === "failed" ? "研究执行体失败，原知识保留" : undefined, revisions: {}, turns: [], evidence: [], documents: [{ id: "orders", title: "已发布订单规则", target_id: "domain", layer: "domain", path: "domains/orders.md", content: "正式订单规则", sources: "固定版本源码", revision: 1, selected: true, base_content: null, base_revision: "a".repeat(40), history: [], knowledge_document_id: "kd-matrix", published_revision: "b".repeat(64), published_document_revision: 1, published_at: "2026-10-03T00:00:00Z" }], publications: [] };
    if (state !== "ready") {
      const publication: DomainKnowledgeJob["publications"][number] = { target_id: "domain", branch: `codex/${kind}-${state}`, state: state === "running" ? "pending" : state,
        ...(state === "opened" ? { url: `https://example.test/mr/${kind}-${state}` } : {}), ...(state === "failed" ? { error: "Git 网络暂时故障，请重试此仓归档。" } : {}),
        documents: [{ id: "orders", path: "domains/orders.md", content: "正式订单规则", revision: 1, knowledge_document_id: "kd-matrix", knowledge_revision: "b".repeat(64) }] };
      job.publications = [publication];
      job.archive_batches = [{ id: `batch-${kind}-${state}`, state: state === "opened" ? "done" : state, issue_no: job.issue_no, created_at: job.created_at, operator: "alice", documents: structuredClone(job.documents), targets: [repository], publications: [publication], ...(state === "failed" ? { error: publication.error } : {}) }];
    }
    const record: ResearchRecord = { id: `cr-${state}`, component: { id: "orders", name: "订单组件", repository: "https://example.test/component.git", branch: "main", path: "src", languages: ["cpp"], description: "订单规则", enabled: true }, language: "cpp", topic: job.title, operator: "alice", key: `matrix-${state}`, status: state === "failed" ? "failed" : "done", stage: job.stage, error: job.error, created_at: job.created_at, evidence: [], document_id: "kd-matrix" };
    if (kind === "component") job.component_research_id = record.id;
    const expected = kind === "domain" ? projectKnowledgeProduction({ kind, record: job }) : projectKnowledgeProduction({ kind, record, archive: job });
    const task = kind === "domain" ? domainKnowledgeTask(job) : componentKnowledgeTask(record, job);
    assert.equal(task.group, state === "failed" ? "attention" : state === "running" ? "running" : "completed");
    assert.equal(expected.archive.status_label, { ready: "已发布（未归档）", running: "归档中", opened: "已归档", failed: "归档失败" }[state]);
    if (state === "failed") assert.equal(task.status_label, "归档失败", "失败归档的动作优先于同任务的研究失败");
    assert.deepEqual(task.production, expected, "任务行和详情使用同一后端投影");
    assert.deepEqual(task.next_action, expected.next_action);
    assert.ok(task.next_action.href?.includes("kbPage=task"));
    tasks.push(task);
  }
  return { module_activity: [], tasks, warnings: [], summary: { running: tasks.filter(task => task.group === "running").length, attention: tasks.filter(task => task.group === "attention").length, total: tasks.length } };
}

test("生产线验收3/F5 与生产线验收8/F10–F12：桌面任务中心保留坏文件告警，组合状态和完整动作沿用后端真实投影",
  { timeout: 40_000, skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mfc-production-warnings-browser-"));
    const dataDir = join(dir, "data"), warningsDir = join(dir, "warnings-only");
    const badPaths = [`domain-extraction/dkx-${randomUUID()}/job.json`, `component-research/cr-${randomUUID()}/record.json`, `knowledge-documents/kd-${randomUUID()}.json`];
    for (const data of [dataDir, warningsDir]) for (const path of badPaths) write(data, path, "{");
    const completed: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title: "已完成的正常领域研究", scope: "订单规则", operator: "alice", created_at: "2026-10-02T00:00:00Z",
      repositories: [], knowledge_target: repository, material_ids: [],
      status: "done", stage: "已完成", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
    const attention: ResearchRecord = { id: `cr-${randomUUID()}`, component: { id: "files", name: "文件组件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["cpp"], description: "文件处理", enabled: true },
      language: "cpp", topic: "可以继续的正常组件研究", operator: "bob", key: "warnings-browser", status: "failed", error: "来源当前不可用，可重试研究", stage: "萃取失败", created_at: "2026-10-02T00:00:00Z", evidence: [] };
    write(dataDir, `domain-extraction/${completed.id}/job.json`, JSON.stringify(completed));
    write(dataDir, `component-research/${attention.id}/record.json`, JSON.stringify(attention));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const domain = new DomainKnowledgeExtraction(dataDir, async () => { await held; return "已停止的测试执行体"; });
    const component = new ComponentResearch(dataDir, async () => { throw new Error("本测试不执行组件研究"); });
    const emptyDomain = new DomainKnowledgeExtraction(warningsDir, async () => { throw new Error("坏记录不应执行"); });
    const emptyComponent = new ComponentResearch(warningsDir, async () => { throw new Error("坏记录不应执行"); });
    try {
      const running = domain.create({ title: "正在进行的正常研究", scope: "资源规则", issue_no: "REQ-BROWSER", repositories: [], knowledge_target: repository }, "carol");
      const populated = listKnowledgeTasks({ dataDir, domain, component, skillExtractionJob: () => undefined });
      const warningsOnly = listKnowledgeTasks({ dataDir: warningsDir, domain: emptyDomain, component: emptyComponent, skillExtractionJob: () => undefined });
      assert.equal(populated.warnings.length, 3);
      assert.equal(populated.summary.running, 1);
      assert.equal(populated.summary.attention, 4);
      assert.equal(warningsOnly.tasks.length, 0);
      assert.equal(warningsOnly.summary.attention, 3);
      const fixture = { populated, warningsOnly, matrix: productionMatrix(), badPaths, runningId: running.id, completedId: completed.id, attentionId: attention.id };
      let buildTimer: ReturnType<typeof setTimeout> | undefined;
      const bundled = await Promise.race([
        build({ entryPoints: [resolve("tests/browser/knowledgeProductionWarnings.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } }),
        new Promise<never>((_, reject) => { buildTimer = setTimeout(() => reject(new Error("浏览器夹具构建超过5秒预算")), 5_000); }),
      ]).finally(() => clearTimeout(buildTimer));
      const html = join(dir, "check.html"), output = join(dir, "dom.html");
      const json = JSON.stringify(fixture).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
      const assets = resolve("web/dist/assets");
      const css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
      writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app" style="padding:24px"></div><pre id="result"></pre><script id="fixture" type="application/json">' + json + '</script><script>' + bundled.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
      const fd = openSync(output, "w");
      let pid: number | undefined;
      let closePromise: Promise<void> | undefined;
      try {
        const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--force-device-scale-factor=1", `--user-data-dir=${join(dir, "profile")}`,
          "--window-size=1366,768", "--virtual-time-budget=6000", "--dump-dom", `file://${html}`], { detached: true, stdio: ["ignore", fd, "ignore"] });
        pid = child.pid;
        let childError: Error | undefined;
        child.once("error", error => { childError = error; });
        closePromise = new Promise(resolve => { child.once("close", () => resolve()); });
        let browserTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          closePromise,
          (async () => {
            // dump-dom 可先打印完整页面而进程尚未退出；以真实断言结果完成验收，再清理浏览器。
            const deadline = Date.now() + 25_000;
            while (Date.now() < deadline) {
              if (/<pre id="result">[^<]+<\/pre>/.test(readFileSync(output, "utf8"))) return;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error("桌面浏览器未在25秒内输出验收结果");
          })(),
          new Promise<never>((_, reject) => { browserTimer = setTimeout(() => reject(new Error("桌面浏览器超过25秒执行预算")), 25_000); }),
        ]).finally(() => clearTimeout(browserTimer));
        if (childError) throw childError;
      } finally {
        try {
          if (pid) {
            try { process.kill(-pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        } finally {
          try {
            if (closePromise) {
              let exitTimer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                closePromise,
                new Promise<never>((_, reject) => { exitTimer = setTimeout(() => reject(new Error("桌面浏览器终止后超过5秒退出预算")), 5_000); }),
              ]).finally(() => clearTimeout(exitTimer));
            }
          } finally { closeSync(fd); }
        }
      }
      const result = readFileSync(output, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, "桌面浏览器未在预算内完成告警验收");
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, value.error);
      assert.equal(value.passed, true);
      assert.equal(value.width, 1366);
    } finally {
      release();
      await Promise.all([domain.shutdown(), component.shutdown(), emptyDomain.shutdown(), emptyComponent.shutdown()]);
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
