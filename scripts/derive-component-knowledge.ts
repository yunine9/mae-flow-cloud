import { componentRuleFiles } from "../src/componentRuleCandidates.ts";
/** 从已导出的组件 Markdown 确定性派生索引和规则候选；不调用模型、不启用规则。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { deriveComponentArtifacts } from "../src/componentParadigms.ts";

function main() {
  const args = process.argv.slice(2), input = args[0], out = args[1];
  if (!input || args.length > 2) throw new Error("用法：node --import tsx scripts/derive-component-knowledge.ts <产物目录或JSON包> [输出目录]；省略输出目录只校验并输出摘要");
  const source = resolve(input), files: Record<string, string> = {};
  if (lstatSync(source).isSymbolicLink()) throw new Error("输入不能是软链接");
  if (lstatSync(source).isDirectory()) {
    const walk = (relative: string) => {
      for (const entry of readdirSync(join(source, relative), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("产物目录不能含软链接");
        const path = relative + "/" + entry.name;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && (path.endsWith(".md") || path.endsWith(".metadata.json"))) files[path] = readFileSync(join(source, path), "utf8");
      }
    };
    if (!existsSync(join(source, "components"))) throw new Error("缺少 components 产物目录");
    walk("components");
  } else {
    const bundle = JSON.parse(readFileSync(source, "utf8"));
    if (!bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) throw new Error("JSON 包缺少 files 对象");
    for (const [path, text] of Object.entries(bundle.files)) if (path.startsWith("components/")) {
      if (typeof text !== "string") throw new Error("产物内容必须是字符串"); files[path] = text;
    }
  }
  if (!Object.keys(files).length) throw new Error("没有可提取的组件产物");
  const result = deriveComponentArtifacts(files);
  const ruleFiles = componentRuleFiles(result.rules);
  if (out) {
    const target = resolve(out);
    const outputs = { ...Object.fromEntries(Object.entries(ruleFiles).map(([path, value]) => [path.replace(/^derived\//, ""), value])),
      "catalog.json": JSON.stringify({ schema: "mfc.component-paradigm/v1", paradigms: result.catalog }, null, 2) + "\n",
      "mapping-table.md": result.mapping + "\n",
      "rule-candidates.json": JSON.stringify({ schema: "mfc.component-paradigm/v1", enabled: false, rules: result.rules }, null, 2) + "\n" };
    const manifestPath = join(target, "component-derived-manifest.json");
    const protectPath = (file: string) => { let p = resolve(file); for (;;) { if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("输出不能经过软链接"); if (p === target) break; const parent = dirname(p); if (parent === p) break; p = parent; } };
    protectPath(manifestPath);
    const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: [] };
    const validOutput = (path: unknown): path is string => typeof path === "string" && /^(catalog\.json|mapping-table\.md|rule-candidates\.json|rule-report\.md|ast-grep\/(sgconfig\.yml|(?:rules|rule-tests)\/component-[a-f0-9]+(?:-test)?\.yml))$/.test(path);
    if (!Array.isArray(old.files) || !old.files.every(validOutput)) throw new Error("旧派生清单无效，未覆盖任何文件");
    for (const path of [...old.files, ...Object.keys(outputs), "component-derived-manifest.json"]) protectPath(join(target, path));
    mkdirSync(target, { recursive: true });
    for (const [path, content] of Object.entries(outputs)) { const file = join(target, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + ".tmp", content, { flag: "wx" }); renameSync(file + ".tmp", file); }
    for (const path of old.files) if (!Object.hasOwn(outputs, path) && existsSync(join(target, path))) unlinkSync(join(target, path));
    writeFileSync(manifestPath + ".tmp", JSON.stringify({ digest: result.digest, files: Object.keys(outputs).sort() }, null, 2) + "\n", { flag: "wx" });
    renameSync(manifestPath + ".tmp", manifestPath);
  }
  process.stdout.write(JSON.stringify({ documents: result.catalog.length, candidates: result.rules.length, digest: result.digest, enabled: false }) + "\n");
}
try { main(); } catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
