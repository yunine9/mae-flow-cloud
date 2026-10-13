import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { knowledgeArchiveDefaults } from "../src/knowledgeArchiveDefaults.ts";
import { domainExecutionContract } from "../src/domainKnowledgeExecution.ts";
import { bundledExtractionSkill, extractionSkillTool, KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";

const packageRoot = fileURLToPath(new URL("../internal-skills/business-docs-generator/", import.meta.url));
function readPackage(relative = "", files: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true })) {
    const path = posix.join(relative, entry.name);
    if (entry.isDirectory()) readPackage(path, files);
    else {
      assert.equal(entry.isFile(), true, `${path} 应为普通文件`);
      assert.ok(path.endsWith(".md"), `${path} 应可通过领域方法目录上传`);
      files[path] = readFileSync(join(packageRoot, path), "utf8");
    }
  }
  return files;
}

// Issue 475 附件原始模板的 SHA-256；适配执行方式时保留原文档体系与图表深度。
const originalTemplates: Record<string, string> = {
  "templates/domain/architecture.md": "9d3c3d443bf54ca24957203874ba43451c71232717f8dc7ed4cb26119b03b186",
  "templates/domain/domain-agents.md": "87f1c87c5ae4806b5cfb5db4568fe866bdc8101a98a23aca48daf5244a7ddbc1",
  "templates/domain/domain.md": "036fea6468d86fcc256cae7ec21d04c861c90e25370f69d7b6114477eeb9fb8c",
  "templates/domain/external-system.md": "5d9199bfdd4694b93133cf981631ee29e620cfa18d76116b53a4f986f03fa7af",
  "templates/domain/glossary.md": "3b8622a9bd5467f8905c24d5cf4fa91888f5a86b19d56343ad65afe3df9c4430",
  "templates/domain/interface-contract.md": "c4b3e3c6515e6d7ac073f7bea32370a6de2a57e4764e32b13c210e39e118a03b",
  "templates/domain/root-agents.md": "8dd005b14be7c14d8621dce00a2d1b175407cfd08b2159f478f8c8c32e083f93",
  "templates/repo/business-rules.md": "b5bc0d3fdda79f8419b948d04a4b32b002892fbb2d99d15b96b55fa94b015f34",
  "templates/repo/coding-conventions.md": "0cb3df1ebb44650fed9c84d4da81639f7032bfd1e79041dcfac964c6f285626a",
  "templates/repo/experience.md": "df1ddf95cd21bb11797994000f9b909502304973e3b2bfbc12186d6c2165ca02",
  "templates/repo/module-doc.md": "00519755c2121cf105edf20e241f03d559027d5c0372611597b13e0217bc82e3",
  "templates/repo/module-map.md": "49d86457a4c1768a304150e7e66242c675932305f056ae3e4c80f41f48d426b8",
  "templates/repo/repo-agents.md": "263755545d857d45a77739c993ab54e54d42be6c3b3d5cd72924730c9f10c873",
};

test("业务文档适配包保留附件全部 13 个原始模板，执行引用完整", () => {
  const files = readPackage();
  assert.deepEqual(Object.keys(files).filter(path => path.startsWith("templates/")).sort(), Object.keys(originalTemplates).sort());
  for (const [path, digest] of Object.entries(originalTemplates)) {
    assert.equal(createHash("sha256").update(files[path]).digest("hex"), digest, path);
  }
  for (const name of ["plan", "plan-template", "generate-domain", "generate-repo", "verify-doc"]) {
    assert.ok(files[`prompts/${name}.md`], `缺少附件执行提示词 ${name}`);
  }
  // 仅执行文件中的方法链接必须在包内；原模板链接是待生成文稿的示例，不能误当作包引用。
  for (const [path, content] of Object.entries(files).filter(([path]) => !path.startsWith("templates/"))) {
    for (const match of content.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(match[1])) continue;
      assert.ok(files[posix.normalize(posix.join(posix.dirname(path), match[1]))], `${path} 的方法引用缺失：${match[1]}`);
    }
  }
  assert.deepEqual(knowledgeArchiveDefaults(files, "domain"), { domain_directory: "domain-docs", repository_directory: "docs" });
  assert.equal(domainExecutionContract(files), "reviewed-document-plan");
});

test("业务文档完整包可通过现有领域方法安装，默认方法与已固定任务保持原版", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-docs-package-"));
  try {
    const files = readPackage(), store = new KnowledgeExtractionSkills(root);
    const original = store.current("domain"), defaultDigest = bundledExtractionSkill("domain").digest;
    assert.equal(original.name, "domain-knowledge-extraction");
    const oldPath = join(root, "old-task", "skill.json"), old = store.pin("domain", oldPath);
    const saved = await store.save("domain", files, original.digest, "package-test");
    assert.equal(saved.name, "business-docs-generator");
    assert.equal(saved.kind, "domain");
    assert.deepEqual(saved.files, files, "上传需保留提示词和模板，不能只安装 SKILL.md");
    assert.equal(bundledExtractionSkill("domain").digest, defaultDigest);
    assert.equal(store.pin("domain", oldPath).digest, old.digest);
    const pinned = store.pin("domain", join(root, "new-task", "skill.json"));
    assert.equal(pinned.digest, saved.digest);
    const tool: any = extractionSkillTool(pinned);
    for (const path of Object.keys(files)) {
      const result = await tool.execute("package-read", { path });
      assert.equal(result.content[0].text, files[path], path);
    }
    // 上传提示只应来自附件模板的产物示例链接，执行提示词不应有遗漏引用。
    assert.ok(saved.warnings.every(warning => warning.startsWith("templates/")), saved.warnings.join("\n"));
    const archive = join(dirname(oldPath), "skill-packages", `${old.digest}.json`);
    assert.equal(JSON.parse(readFileSync(archive, "utf8")).digest, old.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
