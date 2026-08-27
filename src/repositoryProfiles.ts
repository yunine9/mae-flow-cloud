/** 首次由用户确认、后续复用的仓库技术画像。系统不猜。 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";

const ROOT = "repository-profiles";
const FILE = "profiles.json";
const OPERATIONS = "operations.jsonl";
const MAX_REPOSITORIES = 1000;

export class RepositoryProfileError extends Error {}

export interface RepositoryProfile {
  repository: string;
  technologies: string[];
  /** true + [] = 用户明确选择“暂不确定”，不是系统漏采。 */
  confirmed: boolean;
  updated_at: string;
  updated_by: string;
}

export interface RepositoryProfileResolution {
  repository: string;
  profile?: RepositoryProfile;
}

function home(dataDir: string): string { return join(dataDir, ROOT); }
function file(dataDir: string): string { return join(home(dataDir), FILE); }

function validateRepository(value: string): string {
  const repository = value.trim();
  if (!repository || repository.length > 512 || /[\0\r\n]/.test(repository)) {
    throw new RepositoryProfileError("代码仓地址不合法");
  }
  return repository;
}

function readAll(dataDir: string): RepositoryProfile[] {
  const path = file(dataDir);
  if (!existsSync(path)) return [];
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new RepositoryProfileError("仓库技术画像存储不是普通文件");
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(value)) throw new Error("not an array");
    return value.flatMap((item): RepositoryProfile[] => {
      if (!item || typeof item.repository !== "string") return [];
      try {
        return [{
          repository: validateRepository(item.repository),
          technologies: normalizeKnowledgeLanguages(
            Array.isArray(item.technologies) ? item.technologies : [])
            .filter((technology) => technology !== "agnostic"),
          confirmed: item.confirmed === true,
          updated_at: String(item.updated_at ?? ""),
          updated_by: String(item.updated_by ?? ""),
        }];
      } catch { return []; }
    });
  } catch {
    throw new RepositoryProfileError("仓库技术画像数据损坏");
  }
}

function writeAll(dataDir: string, profiles: RepositoryProfile[]): void {
  if (profiles.length > MAX_REPOSITORIES) {
    throw new RepositoryProfileError(`最多保存 ${MAX_REPOSITORIES} 个仓库画像`);
  }
  const root = home(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o750 });
  const path = file(dataDir);
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(profiles, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o640,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function resolveRepositoryProfiles(
  dataDir: string,
  repositories: string[],
): RepositoryProfileResolution[] {
  const all = readAll(dataDir);
  const byIdentity = new Map(all.map((profile) =>
    [repositoryIdentity(profile.repository), profile]));
  return [...new Set(repositories.map(validateRepository))].map((repository) => ({
    repository,
    profile: byIdentity.get(repositoryIdentity(repository)),
  }));
}

export function saveRepositoryProfile(
  dataDir: string,
  input: { repository: string; technologies?: string[]; confirmed?: boolean },
  operator: string,
): RepositoryProfile {
  const repository = validateRepository(input.repository);
  let technologies: string[];
  try {
    technologies = normalizeKnowledgeLanguages(input.technologies ?? [])
      .filter((item) => item !== "agnostic");
  } catch (error) {
    throw new RepositoryProfileError(
      error instanceof Error ? error.message : String(error));
  }
  const profile: RepositoryProfile = {
    repository,
    technologies,
    confirmed: input.confirmed !== false,
    updated_at: new Date().toISOString(),
    updated_by: operator,
  };
  const identity = repositoryIdentity(repository);
  const all = readAll(dataDir).filter((item) =>
    repositoryIdentity(item.repository) !== identity);
  writeAll(dataDir, [...all, profile].sort((left, right) =>
    left.repository.localeCompare(right.repository)));
  appendFileSync(join(home(dataDir), OPERATIONS), `${JSON.stringify({
    at: profile.updated_at,
    operator,
    action: "confirm",
    repository,
    technologies,
  })}\n`, { encoding: "utf-8", mode: 0o640 });
  return profile;
}
