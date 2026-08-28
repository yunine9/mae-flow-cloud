/**
 * 仓库根下由各类 Coding Agent / 中心能力服务使用的本地目录。
 *
 * 这些目录有两种来源：
 * - 代码仓本来就跟踪的仓内 Skill；
 * - clone 后由中心服务临时注入的运行时 Skill / 配置。
 *
 * Git 的本地 exclude 只会忽略后者（未跟踪文件），不会影响前者的读取。
 * 推送兜底则只拦“本任务中新加入提交历史”的平台目录文件，避免临时
 * 注入资产被 `git add .` 带走，同时不妨碍仓库已有 Skill 保持原样。
 */
export const AGENT_PLATFORM_ROOTS = [
  ".agents",
  ".pi",
  ".claude",
  ".cac",
  ".codex",
  ".cursor",
  ".windsurf",
  ".gemini",
] as const;

export const AGENT_PLATFORM_LOCAL_EXCLUDES = AGENT_PLATFORM_ROOTS
  .map((root) => `/${root}/`);

export const AGENT_PLATFORM_PATHSPECS = AGENT_PLATFORM_ROOTS
  .flatMap((root) => [`:(exclude)${root}`, `:(exclude)${root}/**`]);

export function normalizeRepositoryPath(path: string): string {
  return String(path ?? "").replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "").replace(/^"|"$/g, "");
}

export function isAgentPlatformPath(path: string): boolean {
  const normalized = normalizeRepositoryPath(path);
  return AGENT_PLATFORM_ROOTS.some((root) =>
    normalized === root || normalized.startsWith(`${root}/`));
}

export function describeAgentPlatformRoots(): string {
  return AGENT_PLATFORM_ROOTS.join(" / ");
}
