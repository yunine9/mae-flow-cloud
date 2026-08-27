/**
 * 团队 Skill 货架(只读):部署数据目录 skills/ 的资产清单。
 *
 * 货架回答"现在生效的是什么"(身份/指纹/新鲜度/装载性),与消费足迹
 * (knowledge-insights 的 resources)互补——后者只看得见被任务带过的,
 * 一个放坏了的 skill 在足迹里是隐形的,货架必须把它照出来。
 * 正文不进接口(SKILL.md 可能很长且与展示无关),digest 是版本锚:
 * 后续可写货架(上传/回退)与留痕都对着它。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { readSkillLanguages } from "./knowledgeLanguages.ts";

/** 与宿主 Skill 快照(hostSkillRuntime)同深度上限:货架照见的范围
 * 不应超过运行时真会去装的范围。 */
const MAX_DEPTH = 8;

export interface HostSkillShelfEntry {
  name: string;
  description: string;
  /** SKILL.md frontmatter 声明的工程实现语境。 */
  languages: string[];
  /** SKILL.md 正文 sha256:版本指纹,页面对拍与后续留痕的锚。 */
  digest: string;
  /** SKILL.md 的 mtime(ISO)。 */
  updated_at: string;
  /** 相对 skills 根的路径——宿主绝对路径不出接口。 */
  path: string;
  bytes: number;
  /** pi 装载器认不认。false = 放了也不会进任何会话(缺 name/description
   * 等),货架必须照出来,否则"放了没生效"只能靠试跑撞见。 */
  loadable: boolean;
}

export interface HostSkillShelf {
  root_exists: boolean;
  skills: HostSkillShelfEntry[];
  warnings: string[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 收集根下全部 SKILL.md。软链接整条跳过并出警告——与快照器同纪律,
 * 货架不能展示一个运行时拒绝装载的东西还不说明原因。 */
function collectSkillFiles(root: string, warnings: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) {
        warnings.push(`跳过软链接: ${relative(root, absolute)}`);
        continue;
      }
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.name === "SKILL.md") found.push(absolute);
    }
  };
  walk(root, 0);
  return found;
}

/** 不可装载的条目也要有名字:frontmatter 能读多少读多少,读不出就用
 * 目录名兜底(与 pi 的兜底语义一致),仅用于展示。 */
function fallbackFrontmatter(
  content: string,
  key: "name" | "description",
): string {
  const match = content.match(
    new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : "";
}

export function listHostSkillShelf(dataDir: string): HostSkillShelf {
  const root = resolve(dataDir, "skills");
  if (!existsSync(root)) {
    return { root_exists: false, skills: [], warnings: [] };
  }
  const warnings: string[] = [];
  // 装载性以 pi 的装载器为唯一判据——货架自己不发明第二套认定规则。
  const loadableByPath = new Map<string, { name: string; description: string }>();
  try {
    for (const skill of loadSkills({
      cwd: dataDir,
      agentDir: dataDir,
      skillPaths: [root],
      includeDefaults: false,
    }).skills) {
      loadableByPath.set(resolve(skill.filePath), {
        name: skill.name,
        description: skill.description ?? "",
      });
    }
  } catch (error) {
    warnings.push(`装载器扫描失败(货架退化为纯文件清单): ${String(error)}`);
  }
  const skills: HostSkillShelfEntry[] = [];
  for (const file of collectSkillFiles(root, warnings)) {
    let content: Buffer;
    let mtime: Date;
    try {
      content = readFileSync(file);
      mtime = lstatSync(file).mtime;
    } catch (error) {
      warnings.push(
        `读取失败: ${relative(root, file)} — ${String(error)}`);
      continue;
    }
    const loaded = loadableByPath.get(resolve(file));
    const text = content.toString("utf-8");
    const directory = relative(root, file).split(sep).slice(0, -1).join("/");
    if (!loaded) {
      warnings.push(`不可装载(pi 装载器未接受,检查 frontmatter 的 `
        + `name/description): ${relative(root, file)}`);
    }
    let languages: string[] = [];
    try {
      languages = readSkillLanguages(text);
    } catch (error) {
      warnings.push(`语言标签无效: ${relative(root, file)} — ${
        error instanceof Error ? error.message : String(error)}`);
    }
    skills.push({
      name: loaded?.name
        || fallbackFrontmatter(text, "name")
        || directory || relative(root, file),
      description: loaded?.description
        || fallbackFrontmatter(text, "description"),
      languages,
      digest: sha256(content),
      updated_at: mtime.toISOString(),
      path: relative(root, file).split(sep).join("/"),
      bytes: content.byteLength,
      loadable: !!loaded,
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { root_exists: true, skills, warnings };
}
