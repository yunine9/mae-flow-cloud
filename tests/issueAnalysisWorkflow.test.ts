/**
 * 问题分析工作流(ADR-0005)的机械面单测:
 * - submit_analysis 的报告五章节门票(missingAnalysisSections);
 * - 货架 skill 的问题会话匹配口径(knowledgeMatchesIssueSession,
 *   materializeHostSkills 的 knowledgeScope="issue");
 * - 问题域知识上下文(issueKnowledgeContext)与编排层技能源
 *   (assets/issue-skills/issue-analysis)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYSIS_REPORT_SECTIONS,
  missingAnalysisSections,
} from "../src/issueFlow/tools.ts";
import { issueKnowledgeContext } from "../src/issueFlow/service.ts";
import { SKILL_SOURCE_DIR } from "../src/issueFlow/prompt.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";
import {
  knowledgeMatchesIssueSession,
  readSkillKnowledgeMetadata,
} from "../src/knowledgeAssetModel.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

test("分析报告五章节门票:缺章节点名打回,齐全放行,标题级别宽容", () => {
  const full = [
    "# 问题分析:登录超时", "连接池耗尽致登录超时,方案:超时回收。",
    "## 问题现象", "压测环境登录超时",
    "## 问题根因", "连接池耗尽", "## 修改方案", "超时回收",
    "## 证据链", "日志:pool exhausted",
    "### 置信度", "高", "",
  ].join("\n");
  assert.deepEqual(missingAnalysisSections(full), [],
    "五章节齐全(标题级别不限)必须放行");
  assert.deepEqual(
    missingAnalysisSections("# 分析\n\n根因:连接池耗尽,但没分章节。\n"),
    [...ANALYSIS_REPORT_SECTIONS],
    "章节淹没在正文里必须整单打回");
  assert.deepEqual(
    missingAnalysisSections("# 分析\n## 问题根因\nx\n## 证据链\ny\n"),
    ["问题现象", "修改方案", "置信度"],
    "缺哪几章点名哪几章");
  assert.deepEqual(
    missingAnalysisSections("# 分析\n正文提到结论、证据链与置信度。\n"),
    [...ANALYSIS_REPORT_SECTIONS],
    "正文里出现章节名字不算数——必须撞在标题行上");
});

test("问题会话知识口径:通用工程豁免,作用域照过滤,未分类不进", () => {
  const context = {
    repositories: ["https://git.example.com/pay.git"],
    businessModuleIds: ["pay-core"],
  };
  const meta = (over: Partial<Parameters<typeof
    knowledgeMatchesIssueSession>[0]>) => ({
    nature: "engineering" as const,
    form: "skill" as const,
    business_module_ids: [],
    repositories: [],
    technologies: ["java"],
    ...over,
  });
  // 未限定仓库/模块的工程知识=团队通用方法,豁免进所有问题会话
  // (通用问题定位 skill 就以这个形态发布)。
  assert.equal(knowledgeMatchesIssueSession(meta({}), context), true);
  // 未分类维持"不进",豁免不是无标签后门。
  assert.equal(knowledgeMatchesIssueSession(
    meta({ nature: "unclassified", technologies: [] }), context), false);
  // 业务知识按模块过滤;限定仓库的工程知识按仓过滤(地址归一)。
  assert.equal(knowledgeMatchesIssueSession(
    meta({ nature: "business", technologies: [],
      business_module_ids: ["pay-core"] }), context), true);
  assert.equal(knowledgeMatchesIssueSession(
    meta({ nature: "business", technologies: [],
      business_module_ids: ["media-core"] }), context), false);
  assert.equal(knowledgeMatchesIssueSession(
    meta({ repositories: ["https://git.example.com/pay"] }), context), true);
  assert.equal(knowledgeMatchesIssueSession(
    meta({ repositories: ["https://git.example.com/media.git"] }),
    context), false);
});

/** 货架 fixture:每个 skill 一个目录,frontmatter 带 knowledge 字段。 */
function writeFixtureSkill(
  sourceRoot: string, name: string, knowledgeFields: string,
): void {
  mkdirSync(join(sourceRoot, name), { recursive: true });
  writeFileSync(join(sourceRoot, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 的描述\n`
    + `${knowledgeFields}---\n\n正文\n`);
}

/** 快照目录被 chmod 成只读,清理前先恢复可写(与 hostSkills 测试同款)。 */
function rmRf(path: string): void {
  const makeWritable = (dir: string): void => {
    if (!existsSync(dir)) return;
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir)) makeWritable(join(dir, entry));
  };
  try {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 清不掉就留给 scripts/clean-test-tmp.ts 的临时目录清扫。
  }
}

test("货架快照按 knowledgeScope 装载:issue 放行通用 skill,task 维持原口径", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-issue-scope-"));
  const sourceRoot = join(root, "skills");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  try {
    writeFixtureSkill(sourceRoot, "universal-localization",
      "knowledge_nature: engineering\ntechnologies: [java]\n");
    writeFixtureSkill(sourceRoot, "pay-playbook",
      "knowledge_nature: engineering\nbusiness_modules: [pay-core]\n"
        + "technologies: [java]\n");
    writeFixtureSkill(sourceRoot, "media-notes",
      "knowledge_nature: business\nbusiness_modules: [media-core]\n");
    writeFixtureSkill(sourceRoot, "untagged", "");
    const base = {
      sourceRoot,
      workspaceRoot: workspace,
      snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
      context: issueKnowledgeContext({
        repo_urls: ["https://git.example.com/pay.git"],
        module_id: "pay-core",
      } as IssueSessionState),
    };
    const issue = materializeHostSkills({ ...base, knowledgeScope: "issue" });
    assert.deepEqual(issue.names.sort(),
      ["pay-playbook", "universal-localization"],
      "issue 口径:通用工程豁免 + 模块命中的作用;媒体模块与未分类不进");
    const task = materializeHostSkills({ ...base });
    assert.deepEqual(task.names, [],
      "task 口径不变:问题会话没有技术栈画像,带 technologies 的全被过滤");
  } finally {
    rmRf(root);
  }
});

test("问题域知识上下文:关联仓清单+绑定模块,无模块不造空壳", () => {
  assert.deepEqual(issueKnowledgeContext({
    repo_urls: ["https://a.example.com/x.git", "https://b.example.com/y"],
    module_id: "pay-core",
  } as IssueSessionState), {
    repositories: ["https://a.example.com/x.git", "https://b.example.com/y"],
    technologies: [],
    businessModuleIds: ["pay-core"],
  });
  assert.deepEqual(issueKnowledgeContext({
    repo_url: "https://c.example.com/z",
  } as IssueSessionState), {
    repositories: ["https://c.example.com/z"],
    technologies: [],
    businessModuleIds: [],
  });
});

test("编排层技能源:issue-analysis 在源目录,报告模板含五章节标题", () => {
  const body = readFileSync(
    join(SKILL_SOURCE_DIR, "issue-analysis", "SKILL.md"), "utf-8");
  assert.match(body, /^---\nname: issue-analysis\ndescription: [^\n]+\n/,
    "frontmatter 必须带 name+description(pi 靠它进技能索引)");
  for (const section of ANALYSIS_REPORT_SECTIONS) {
    assert.match(body, new RegExp(`^## ${section}`, "m"),
      `模板必须含「${section}」章节——工具门票与技能模板要同源`);
  }
  assert.match(body, /^## 知识边界/m,
    "必须有知识边界节——外部 skill 只供领域知识,不定流程/格式/节奏");
  assert.match(body, /报告确认即本工作流完成/,
    "生命周期钉死:报告提交即完成,交付纪律归 issue-delivery");
  // 报告可读性纪律(2026-09-03):一句话总结先行/节名即问题/证据指针化/提交前收敛。
  assert.ok(body.indexOf("一句话总结") < body.indexOf("## 问题现象"),
    "一句话总结在所有章节之前——只读首行就能拍板");
  assert.ok(body.indexOf("## 问题根因") < body.indexOf("## 修改方案")
    && body.indexOf("## 修改方案") < body.indexOf("## 证据链"),
    "节序=现象→根因→方案→证据链,节名即问题");
  assert.match(body, /原文不进报告|原文不贴/,
    "证据指针化:日志与代码原文不进报告,出处可核即可");
  assert.match(body, /结论版/,
    "提交前收敛:submit_analysis 交的是结论版,不是过程回放");
});

test("货架通用定位 skill 源(dts-diagnose):engineering 不限作用域,报告对齐五章节", () => {
  const path = join(SKILL_SOURCE_DIR, "..", "host-skills",
    "dts-diagnose", "SKILL.md");
  const body = readFileSync(path, "utf-8");
  assert.match(body, /^---\nname: dts-diagnose\ndescription: [^\n]+\n/,
    "frontmatter 必须带 name+description(货架验收要求 pi 装载器认它)");
  assert.match(body, /^knowledge_nature: engineering$/m,
    "货架发布必须标 engineering(验收拒收 unclassified)");
  assert.match(body, /^technologies: \[/m,
    "engineering 知识必须带适用语言(发布校验必填)");
  assert.doesNotMatch(body, /^business_modules:/m,
    "不得限定业务模块——加了作用域就会被 knowledgeMatchesTask 过滤,"
    + "ADR-0005 的通用豁免要求未限定仓库/模块");
  assert.doesNotMatch(body, /^repositories:/m, "同上,不得限定仓库");
  // 端到端:真实解析器+真实匹配器证明它以通用豁免进所有问题会话
  // (空上下文=没有任何作用域可命中,还为 true 就是真的通用)。
  assert.equal(knowledgeMatchesIssueSession(
    readSkillKnowledgeMetadata(body),
    { repositories: [], businessModuleIds: [] }), true);
  for (const section of ANALYSIS_REPORT_SECTIONS) {
    assert.match(body, new RegExp(`^## ${section}`, "m"),
      `报告模板必须含「${section}」——货架方法论与 submit_analysis 门票同源`);
  }
  assert.doesNotMatch(body, /每步确认/,
    "适配钉死:不得保留「每步确认」——analyze 阶段唯一出口是 submit_analysis");
  assert.doesNotMatch(body, /\bcurl\b/,
    "适配钉死:截图走 dts_get_ticket/inspect_image,不走 curl 拉外链");
  assert.match(body, /轻量 4\/4 通过/,
    "质量检查必须标适用范围——轻量路径免穷举类检查,不与执行纪律打架");
  assert.match(body, /定位结论只对分析时的代码基线负责/,
    "版本分支推导必须有落点:差异写进「置信度」,结论只对分析基线负责");
  // 与编排层模板同序同密度(2026-09-03):一句话总结先行/节名即问题/证据指针化/结论版。
  assert.ok(body.indexOf("一句话总结") < body.indexOf("## 问题现象")
    && body.indexOf("## 问题根因") < body.indexOf("## 修改方案")
    && body.indexOf("## 修改方案") < body.indexOf("## 证据链"),
    "模板同序:总结先行,节序=现象→根因→方案→证据链");
  assert.match(body, /一句话总结/,
    "首行=一句话总结(串联 现象→根因→方案),与编排层模板同源");
  assert.match(body, /出处指针/,
    "日志证据指针化:时间戳+目录+关键字,不贴整段原文");
  assert.match(body, /结论版/,
    "五步法中间产物不整块进报告,提交的是结论版");
  assert.ok(Buffer.byteLength(body) <= 128 * 1024, "货架单文件上限 128KiB");
});
