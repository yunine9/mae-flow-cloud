import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CloudSession } from "../src/sessionDriver.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";

for (const probe of [false, true]) test(`任意领域 Skill 自行安排写作与只读评审，源码、资料和豆包可组合使用（${probe ? "单模块" : "正式"}）`, async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-skill-agent-")), repo = join(root, "repo"), cli = join(root, "doubao");
  const env = { MAE_FLOW_WXDOUBAO_BIN: cli, WXDOUBAO_USERID: "fixture-user", WXDOUBAO_TOKEN: "fixture-credential" };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/order.ts"), "export function cancel() { return 'reverse'; }\n");
  mkdirSync(join(repo, "docs")); writeFileSync(join(repo, "docs/old.md"), "OLD_PROBE_DOCUMENT"); writeFileSync(join(repo, "AGENTS.md"), "OLD_PROBE_AGENT");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{structuredContent:{text:"AR20260001：历史重复扣款后改用冲正，失败需人工核对",url:"https://example.test/decision"}}}));\n`, { mode: 0o700 });
  const material = await businessMaterial(root), sessions: any[] = [];
  const skills = new KnowledgeExtractionSkills(root), originalComponent = skills.current("component").digest;
  const files = { "SKILL.md": "---\nname: settlement-guide\ndescription: 研究冲正规则。\n---\nMETHOD_A：按 [方法](guide/way.md) 调查后保存任意组织的文档。", "guide/way.md": "阅读源码、资料和豆包，单独复核，具体步骤由本方法安排。" };
  await skills.save("domain", files, skills.current("domain").digest, "expert");
  const body = "# 已结算订单的取消\n\n采用冲正保留审计链。失败时由财务核对。";
  const document = { id: "guide", title: "冲正", layer: "domain", target_id: "domain", path: "domains/answers/settlement.md", content: body, sources: "已读取的源码、上传资料与豆包" };
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    sessions.push(config);
    const call = async (name: string, args: any, error = false) => {
      const tool = config.extraTools.find((t: any) => t.name === name); assert.ok(tool, name);
      const response = await tool.execute("fixture", args, new AbortController().signal);
      assert.equal(!!response.isError, error, JSON.stringify(response));
      try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
    };
    return { start: async (prompt: string) => {
      const data = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      assert.equal(data.instructions, "只研究订单取消，不读取 legacy/payment.ts；正文只写业务规则");
      assert.match(prompt, /优先于 Skill 的默认安排/);
      assert.equal(config.excludeAgentFiles, true); assert.equal(config.allowedTools.includes("bash"), false);
      assert.match(prompt, /METHOD_A/); assert.doesNotMatch(prompt, /先用.*phase-|前两个模块|knowledge_research|知识正文写作要求/);
      if (!data.step) {
        assert.equal(config.resumeSession, true); assert.equal(data.probe?.module, probe ? "订单" : undefined);
        await call("business_knowledge", { tool: "knowledge_search", question: "ROOT_SHARED AR20260001 取消约束" });
        await call("knowledge_work", { action: "schedule", steps: [
          { id: "answer", title: "解释规则", instructions: "读资料及源码后写一份问答", depends_on: [], readonly: false },
          { id: "check", title: "核对结论", instructions: "回查资料并评审问答", depends_on: ["answer"], readonly: true },
        ] });
        await call("knowledge_work", { action: "run", id: "check" }, true);
        await call("knowledge_work", { action: "run", id: "answer" });
        const count = sessions.length; await call("knowledge_work", { action: "run", id: "answer" }); assert.equal(sessions.length, count);
        const reviewed = await call("knowledge_work", { action: "run", id: "check" }); assert.equal(reviewed.data.pass, true);
        await call("knowledge_work_result", { summary: "本方法的写作与评审完成", document_ids: ["guide"], data: { custom: true } });
      } else {
        assert.equal(config.resumeSession, false);
        assert.doesNotMatch(prompt, /ROOT_SHARED/, "独立步骤没有主会话的私有上下文");
        const shared = await call("knowledge_evidence", { action: "list", query: "ROOT_SHARED" });
        assert.ok(shared.entries[0].evidence_id);
        const raw = await call("knowledge_evidence", { action: "read", evidence_id: shared.entries[0].evidence_id });
        assert.match(raw.content, /AR20260001/);
        for (const tool of ["ar_fur_info", "ar_idp_docs", "ar_history_similar"]) await call("business_knowledge", { tool, ar_code: "AR20260001" });
        if (probe) await call("component_source", { action: "read", component_id: "repo-1", path: "docs/old.md", include_platform: true }, true);
        // component_source returns plain source, so use the raw tool here.
        const source = await config.extraTools.find((t: any) => t.name === "component_source").execute("read", { action: "read", component_id: "repo-1", path: "src/order.ts" }, new AbortController().signal);
        assert.equal(!!source.isError, false);
        await config.extraTools.find((t: any) => t.name === "knowledge_material").execute("material", { id: material.id }, new AbortController().signal);
        const queried = await config.extraTools.find((t: any) => t.name === "business_knowledge").execute("query", { tool: "knowledge_search", question: "取消为什么改为冲正，失败怎么处理" }, new AbortController().signal);
        assert.equal(!!queried.isError, false);
        if (data.step.readonly) {
          assert.equal((await call("knowledge_draft", { action: "read", id: "guide" })).content, body);
          await call("knowledge_draft", { action: "save", document: { ...document, content: "不能覆盖" } }, true);
          await call("knowledge_work_result", { summary: "已对照原始资料", document_ids: ["guide"], data: { pass: true, feedback: "结论一致" } });
        } else {
          await call("knowledge_draft", { action: "save", document });
          await call("knowledge_work_result", { summary: "已保存知识", document_ids: ["guide"], data: { whatever_this_skill_needs: [1, 2] } });
        }
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("不应补充会话"); } } as any;
  });
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision }) }));
  try {
    createBusinessModule(root, { id: "trade", name: "交易", description: "交易", owner: "expert", repositories: ["https://example.test/orders.git"] }, "expert");
    const job = probe ? service.createProbe({ module_id: "trade", probe_module: "订单", instructions: "只研究订单取消，不读取 legacy/payment.ts；正文只写业务规则", material_ids: [material.id] }, "expert") : service.create({ issue_no: "REQ-skill", title: "订单", scope: "取消", instructions: "只研究订单取消，不读取 legacy/payment.ts；正文只写业务规则", material_ids: [material.id], repositories: [{ repository: "https://example.test/orders.git", branch: "main" }] }, "expert");
    for (let i = 0; i < 1000 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(r => setTimeout(r, 10));
    const final = service.get(job.id); assert.equal(final.status, "done", final.error);
    assert.equal(final.documents.length, 1); assert.equal(final.documents[0].content, body); assert.equal(sessions.length, 3);
    assert.equal(final.turns[0].revisions?.["repo-1"], revision);
    assert.ok(final.evidence.some(e => e.tool === "knowledge_material")); assert.ok(final.evidence.some(e => e.tool === "business_knowledge"));
    assert.equal(final.evidence.filter(e => e.tool === "knowledge_evidence" && e.action === "read").length, 2);
    for (const action of ["ar_fur_info", "ar_idp_docs", "ar_history_similar"]) assert.ok(final.evidence.some(e => e.tool === "business_knowledge" && e.action === action && e.status === "available"));
    assert.equal(skills.current("component").digest, originalComponent);
    const state = JSON.parse(readFileSync(join(root, "domain-extraction", job.id, "skill-runs", final.turns[0].id, "work.json"), "utf8"));
    assert.deepEqual(state.steps.map((s: any) => s.id), ["answer", "check"]);
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "");
  } finally { await service.shutdown(); intercepted.mock.restore(); for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(root, { recursive: true, force: true }); }
});

test("替换为单篇 Skill 即改变输出，不读取源码、不强制评审和领域文档，也不按特殊文件名分流", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-skill-swap-")), skills = new KnowledgeExtractionSkills(root);
  let runs = 0, sources = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      runs++;
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      assert.equal(context.step, undefined); assert.match(prompt, /ONLY_ONE_PAGE/);
      const read = config.extraTools.find((t: any) => t.name === "extraction_skill");
      assert.match((await read.execute("read", { path: "custom/how.md" })).content[0].text, /自由正文/);
      const name = prompt.includes("VERSION_B") ? "faq" : "decision";
      const document = { id: name, title: name, target_id: name === "faq" ? "domain" : "repo-1", layer: name === "faq" ? "domain" : "repository", path: name === "faq" ? `domains/${name}.md` : `docs/knowledge/${name}.md`, content: `# ${name}\n自由正文，没有固定章节或机器字段。`, sources: "用户提供的业务范围" };
      const saved = await config.extraTools.find((t: any) => t.name === "knowledge_draft").execute("save", { action: "save", document });
      assert.equal(!!saved.isError, false);
      const result = await config.extraTools.find((t: any) => t.name === "knowledge_work_result").execute("done", { summary: name, document_ids: [name] });
      assert.equal(!!result.isError, false);
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {},
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => { sources++; throw new Error("不应读取源码"); } }));
  try {
    const jobs: string[] = [];
    for (const version of ["A", "B"]) {
      await skills.save("domain", { "SKILL.md": `---\nname: method-${version.toLowerCase()}\ndescription: 自定义领域方法。\n---\nONLY_ONE_PAGE VERSION_${version}，只按 [说明](custom/how.md) 写一篇文档。`, "custom/how.md": "自由正文。",
        ...(version === "B" ? { "references/platform-pipeline.md": "这是普通附件文件，不表示启动平台流水线。" } : {}) }, skills.current("domain").digest, "expert");
      const job = service.create({ issue_no: "REQ-skill", title: "业务", scope: "已知范围", repositories: version === "B" ? [] : [{ repository: "https://example.test/repo.git", branch: "main" }] }, "expert"); jobs.push(job.id);
      for (let i = 0; i < 200 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    }
    assert.equal(runs, 2); assert.equal(sources, 0);
    assert.equal(service.get(jobs[0]).documents[0].id, "decision"); assert.equal(service.get(jobs[1]).documents[0].id, "faq");
    assert.notEqual(service.get(jobs[0]).turns[0].skill?.digest, service.get(jobs[1]).turns[0].skill?.digest);
    assert.ok(jobs.every(id => service.get(id).publications.length === 0));
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
