/** 配置中心·知识仓(#286,ADR-0033):管理员指定的全局领域知识代码仓,
 * 单仓单值。仅管理员可见可写——配置中心"全员维护"哲学的第一条例外:
 * 强制全局影响所有人的所有会话,是运营决策不是团队协作资产。
 * URL 校验与拉仓同一把尺(validateRepoUrl):配置能存下的,开工就能克隆。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRepoUrl } from "./issueFlow/issueGit.ts";

export class KnowledgeRepoConfigError extends Error {}

export interface KnowledgeRepoConfig { url: string }

const file = (dataDir: string) => join(dataDir, "knowledge-repo.json");

/** 未配置返回 undefined——读缺席不落文件、不抛错,调用方按"没有知识仓"走。 */
export function readKnowledgeRepoConfig(
  dataDir: string,
): KnowledgeRepoConfig | undefined {
  if (!existsSync(file(dataDir))) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file(dataDir), "utf8"));
  } catch {
    throw new KnowledgeRepoConfigError(
      "知识仓配置文件损坏,请删除后重新配置(knowledge-repo.json)");
  }
  if (typeof data !== "object" || data === null
    || typeof (data as { url?: unknown }).url !== "string") {
    throw new KnowledgeRepoConfigError(
      "知识仓配置文件格式错误,请删除后重新配置(knowledge-repo.json)");
  }
  return { url: (data as { url: string }).url };
}

/** 覆盖式单值保存;打回时不留半截配置(先验证后写盘)。
 * 校验比拉仓运行期严一档(先例:saveProductVersion 配置期跑
 * git check-ref-format):validateRepoUrl 会把 scp 形态(git@host:path)
 * 当本地路径 resolve 放行——运行期有克隆失败回执兜底,配置期存进一个
 * 必败地址只会在每个会话撒失败事件,所以在保存口早打回;除此之外与
 * 拉仓同一把尺,不造第二真相。 */
export function saveKnowledgeRepoConfig(
  dataDir: string,
  rawUrl: string,
): KnowledgeRepoConfig {
  const input = String(rawUrl ?? "");
  let url: string;
  try {
    url = validateRepoUrl(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new KnowledgeRepoConfigError(
      `知识仓地址无效:${reason}(与问题拉仓同一把尺,只收 HTTPS 或本地路径)`);
  }
  if (url !== input.trim() && input.includes("@") && !/:\//.test(input)) {
    throw new KnowledgeRepoConfigError(
      "知识仓地址无效:不支持 ssh/scp 形态(git@host:path),"
        + "请改用 HTTPS 地址");
  }
  write(dataDir, { url });
  return { url };
}

export function clearKnowledgeRepoConfig(dataDir: string): void {
  write(dataDir, undefined);
}

function write(dataDir: string, config?: KnowledgeRepoConfig): void {
  mkdirSync(dataDir, { recursive: true });
  if (!config) {
    rmSync(file(dataDir), { force: true });
    return;
  }
  const temporary = file(dataDir) + ".tmp";
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600 });
  renameSync(temporary, file(dataDir));
}
