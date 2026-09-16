/** 全局版本与分支映射；创建任务时解析，已有任务使用自己的基线快照。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export class ConfigurationInputError extends Error {}

export interface ProductVersion { id: string; version: string; branch: string }
const file = (dataDir: string) => join(dataDir, "product-versions.json");
export function listProductVersions(dataDir: string): ProductVersion[] {
  if (!existsSync(file(dataDir))) return [];
  const data = JSON.parse(readFileSync(file(dataDir), "utf8"));
  if (!Array.isArray(data) || data.some(row => !row.id || !row.version || !row.branch)) {
    throw new ConfigurationInputError("版本配置文件格式错误，请修复后重试");
  }
  return data;
}
export function saveProductVersion(dataDir: string, input: Partial<ProductVersion>): ProductVersion {
  const rows = listProductVersions(dataDir);
  const version = String(input.version ?? "").trim();
  const branch = String(input.branch ?? "").trim();
  if (!version || version.length > 100 || /[\x00-\x1f\x7f]/.test(version)) throw new ConfigurationInputError("版本名称必填，最多 100 字符");
  if (!branch || branch.length > 255 || branch === "HEAD" || branch.includes("@{")
      || spawnSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" }).status !== 0) {
    throw new ConfigurationInputError("请填写有效的 Git 分支名称");
  }
  if (input.id && !rows.some(row => row.id === input.id)) throw new ConfigurationInputError("版本已不存在，请刷新列表");
  if (rows.some(row => row.id !== input.id && row.version.toLowerCase() === version.toLowerCase())) {
    throw new ConfigurationInputError("该版本已配置，请编辑现有映射");
  }
  const row = { id: input.id || randomUUID(), version, branch };
  const next = input.id ? rows.map(old => old.id === input.id ? row : old) : [...rows, row];
  write(dataDir, next);
  return row;
}
function write(dataDir: string, rows: ProductVersion[]): void {
  mkdirSync(dataDir, { recursive: true });
  const temporary = file(dataDir) + ".tmp";
  writeFileSync(temporary, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file(dataDir));
}
export function deleteProductVersion(dataDir: string, id: string): void {
  const rows = listProductVersions(dataDir);
  if (!rows.some(row => row.id === id)) throw new ConfigurationInputError("版本已不存在，请刷新列表");
  write(dataDir, rows.filter(row => row.id !== id));
}
/** 显式选择不存在时给出可操作错误；无选择的旧客户端仍沿用原基线。 */
export function resolveProductBranch(dataDir: string, version: unknown, fallback?: string): string | undefined {
  const name = String(version ?? "").trim();
  if (!name) return fallback;
  const row = listProductVersions(dataDir).find(row => row.version === name);
  if (!row) throw new ConfigurationInputError(`版本「${name}」未在配置中心配置，请刷新并重新选择`);
  return row.branch;
}
