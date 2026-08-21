import type { SemanticEvent } from "./semanticEvents.ts";
import type {
  GateContract,
  GateDecision,
} from "./gateService.ts";

export type PrePushFailureKind = "code_failure" | "infrastructure_failure";

export interface PrePushCheckReport {
  command: string;
  status: "passed" | "failed" | "skipped";
  summary?: string;
}

export interface PrePushAgentReport {
  status: "passed" | PrePushFailureKind;
  compile: PrePushCheckReport;
  unit_test: PrePushCheckReport;
  summary: string;
}

export interface PrePushRunRequest {
  taskId: string;
  workspace: string;
  sha: string;
  round: number;
  requirement: string;
  branch: string;
  baseline: string;
}

export interface PrePushRunResult {
  status: "passed" | PrePushFailureKind;
  /** Agent 收口后真正验证的 HEAD；它可能包含本轮修复提交。 */
  sha: string;
  message: string;
  report?: PrePushAgentReport;
}

/** 测试/部署可注入其他执行器；生产缺席时由 Cloud 原生 Pi 会话执行。 */
export type PrePushRunner = (
  request: PrePushRunRequest,
) => Promise<PrePushRunResult>;

const RESULT_PATTERN = /<prepush-result>\s*([\s\S]*?)\s*<\/prepush-result>/gi;
const MAX_RESULT_BYTES = 64 * 1024;

const DENY = (reason: string): GateDecision => ({ action: "deny", reason });

/**
 * Cloud 推送前会话不是 Mae-Flow 的阶段会话，因此不能借内核 Hook 做裁决。
 * 这里仅焊死这类专项 Agent 永远不该拥有的宿主能力；构建命令本身保持开放，
 * 仓库可以继续自由使用 Maven、Gradle、npm/pnpm、CMake、Make 等真实工具链。
 *
 * 这是 GateContract，而不是第二套流程状态机。调用方可以把部署已有的契约
 * 作为 fallback 传进来：预推送硬边界优先，未命中时再交给部署契约。
 */
export function createPrePushGateContract(
  fallback?: GateContract,
): GateContract {
  return (tool, value, event) =>
    prePushSecurityDecision(tool, value) ?? fallback?.(tool, value, event);
}

/** 语义更短的生产接线名；保留 create* 名称方便策略单测与外部组合。 */
export function prePushGateContract(base?: GateContract): GateContract {
  return createPrePushGateContract(base);
}

/** 返回 undefined 表示预推送安全层不干预，由下一层契约决定。 */
export function prePushSecurityDecision(
  tool: string,
  value: string,
): GateDecision | undefined {
  const kind = tool.trim().toLowerCase();
  const source = value.trim();
  if (!source) return undefined;

  // 专项会话绕开内核 Hook 的前提，是它也绝不能改写/伪造内核现场。
  // 构建与 UT 不需要这些文件；读写都拒绝，避免先读出状态再用 Bash 改。
  const kernelStatePath = /(?:^|[\\/\s'"`=])\.mae-flow(?:\.json|-[^\\/\s'"`;&|]+|[\\/])(?:$|[\s'"`;&|\\/])/i;
  const selectedSkillSnapshot = kind === "read"
    && /(?:^|[\\/])\.mae-flow-work[\\/]repository-skills[\\/]/i.test(source);
  if (kernelStatePath.test(source) && !selectedSkillSnapshot) {
    return DENY("推送前验证会话不能读取或修改 Mae-Flow 内核现场。");
  }

  // 文件工具和 Bash 都不能伸手碰宿主运行时模型/API Key 或常见凭据。
  // 仓库自己的 .claude/.codex skill 不在此列，避免误伤业务仓能力加载。
  const hostSecretPath = /(?:^|[\\/\s'"`=])(?:pi-agent|\.ssh|\.gnupg|\.aws|\.kube)(?:[\\/]|$)|(?:^|[\\/\s'"`=])\.docker[\\/]config\.json(?:$|[\s'"`;&|])|(?:^|[\\/\s'"`=])(?:\.netrc|\.git-credentials|git-credential(?:\.sh)?)(?:$|[\s'"`;&|])/i;
  if (hostSecretPath.test(source)) {
    return DENY("推送前验证会话不能读取或改写宿主模型配置与凭据。");
  }

  if (kind !== "bash") return undefined;

  // 不允许通过环境变量侧门把宿主密钥打印进上下文。指定 JAVA_HOME、PATH
  // 等非秘密变量仍可查看，`env FOO=bar npm test` 这类构建命令也不受影响。
  const secretEnvironment = /(?:^|[;&|\n]\s*)(?:env|printenv|set|export\s+-p)\s*(?:$|[;&|\n])|\$(?:\{[A-Z_][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)|(?:^|[;&|\n]\s*)printenv\s+[A-Z_][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*/i;
  if (secretEnvironment.test(source)) {
    return DENY("推送前验证会话不能枚举或输出宿主凭据环境变量。");
  }

  // Agent 只能产生本地提交。认证注入、remote 以及真正的 push 都由释放
  // 会话后的 Cloud 宿主统一完成，避免模型获得或持久化远端写权限。
  const shellSegments = source.split(/(?:&&|\|\||[;\n])/);
  for (const segment of shellSegments) {
    if (!/\bgit\b/i.test(segment)) continue;
    if (/\bgit\b[\s\S]*\bpush\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中执行 git push；Cloud 会统一推送已复核的 HEAD。");
    }
    if (/\bgit\b[\s\S]*\bremote\b[\s\S]*\b(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中改写或更新 Git remote。");
    }
    if (/\bgit\b[\s\S]*\bcredential(?:-[\w-]+)?\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中读取、批准或改写 Git 凭据。");
    }
    if (/\bgit\b[\s\S]*\bconfig\b[\s\S]*(?:credential\.|remote\.|url\.|http\.[^\s=]*extraheader|core\.askpass|include(?:if)?\.path|gpg\.program)/i.test(segment)) {
      return DENY("禁止在推送前验证会话中改写 Git 远端或凭据配置。");
    }
    if (/\bgit\b[\s\S]*\bclean\b/i.test(segment)
      || /\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/i.test(segment)
      || /\bgit\b[\s\S]*\bcheckout\b[\s\S]*\s--(?:\s|$)/i.test(segment)
      || /\bgit\b[\s\S]*\brestore\b[\s\S]*(?:--worktree\b|(?:^|\s)\.(?:\s|$))/i.test(segment)) {
      return DENY("禁止丢弃工作区改动；请保留现场并修复，或明确报告环境失败。");
    }
  }

  // 直接编辑 .git/config 同样可以绕过上面的 git 子命令。
  if (/(?:^|[\\/\s'"`=])\.git[\\/]config(?:$|[\s'"`;&|])/i.test(source)
    || /\b(?:GIT|SSH)_ASKPASS\s*=/i.test(source)
    || /\bGIT_SSH_COMMAND\s*=/i.test(source)) {
    return DENY("禁止在推送前验证会话中改写 Git 远端或认证入口。");
  }

  // clean 生命周期交给真实构建工具；Agent 不需要原始递归强删能力。
  // 同时拦住 find -delete，防止工作区被不可恢复地批量清空。
  const rmCommands = source.match(/\brm\s+[^;&|\n]*/gi) ?? [];
  for (const command of rmCommands) {
    const hasRecursive = /(?:^|\s)-(?!-)[^\s]*[rR][^\s]*|--recursive\b/.test(command);
    const hasForce = /(?:^|\s)-(?!-)[^\s]*f[^\s]*|--force\b/.test(command);
    if (hasRecursive && hasForce) {
      return DENY("禁止递归强制删除；请使用仓库构建工具的 clean 生命周期。");
    }
  }
  if (/\bfind\b[^;&|\n]*\s-delete\b/i.test(source)) {
    return DENY("禁止使用 find -delete 批量删除工作区内容。");
  }

  return undefined;
}

export function parsePrePushAgentReport(text: string): PrePushAgentReport | undefined {
  // 只认最后一个收口块：模型在解释过程中可能复述格式示例，不能让前面的
  // 旧块覆盖最终结论。最后一块畸形时直接拒绝，不回退到较早的“通过”。
  const matches = [...text.matchAll(RESULT_PATTERN)];
  const matched = matches.at(-1);
  if (!matched) return undefined;
  if (Buffer.byteLength(matched[1], "utf-8") > MAX_RESULT_BYTES) return undefined;
  try {
    const value = JSON.parse(matched[1]) as Record<string, unknown>;
    const status = String(value.status ?? "");
    if (!["passed", "code_failure", "infrastructure_failure"].includes(status)) {
      return undefined;
    }
    const check = (raw: unknown): PrePushCheckReport | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const row = raw as Record<string, unknown>;
      if (typeof row.command !== "string" || row.command.includes("\0")) {
        return undefined;
      }
      const command = row.command.trim();
      const checkStatus = String(row.status ?? "");
      if (!command || command.length > 8_192
        || !["passed", "failed", "skipped"].includes(checkStatus)) {
        return undefined;
      }
      return {
        command,
        status: checkStatus as PrePushCheckReport["status"],
        ...(String(row.summary ?? "").trim()
          ? { summary: String(row.summary).trim() } : {}),
      };
    };
    const compile = check(value.compile);
    const unitTest = check(value.unit_test);
    if (!compile || !unitTest) return undefined;
    if (status === "passed"
      && (compile.status !== "passed" || unitTest.status !== "passed")) {
      return undefined;
    }
    if (status === "code_failure"
      && compile.status === "passed" && unitTest.status === "passed") {
      return undefined;
    }
    return {
      status: status as PrePushAgentReport["status"],
      compile,
      unit_test: unitTest,
      summary: String(value.summary ?? "").trim() || "推送前验证会话已收口",
    };
  } catch {
    return undefined;
  }
}

/**
 * PASS 不能只认模型自述：报告中的编译与 UT 命令必须在本会话真实执行成功，
 * 且发生在最后一次文件 Edit/Write 之后。最终流水线仍是交付权威，这里只为
 * 避免把一眼可见的红灯推上去烧慢流水线。
 */
export function verifyPrePushEvidence(
  events: SemanticEvent[],
  report: PrePushAgentReport,
): string {
  if (report.status !== "passed") return "验证会话没有报告通过";
  if (report.compile.status !== "passed" || report.unit_test.status !== "passed") {
    return "编译与 UT 必须同时通过";
  }
  const requested = new Map<string, { command: string; eventId: number }>();
  let lastWrite = 0;
  for (const event of events) {
    if (event.kind !== "tool_requested") continue;
    const payload = event.payload as Record<string, any>;
    const name = String(payload.name ?? "");
    if (["Edit", "Write", "MultiEdit"].includes(name)) {
      lastWrite = Math.max(lastWrite, event.eventId);
    }
    if (name === "Bash") {
      const command = String(payload.input?.command ?? "").trim();
      // 本地 commit 也是代码快照变化点。即使修改通过 sed/heredoc 完成，
      // 只要最终按要求提交，编译与 UT 都必须发生在最后一次 commit 之后。
      if (/\bgit\b[\s\S]*\bcommit\b/i.test(command)) {
        lastWrite = Math.max(lastWrite, event.eventId);
      }
      requested.set(`${event.sessionId}:${String(payload.call_id ?? "")}`, {
        command,
        eventId: event.eventId,
      });
    }
  }
  const successful = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "tool_finished") continue;
    const payload = event.payload as Record<string, any>;
    if (String(payload.name ?? "") !== "Bash" || Boolean(payload.is_error)) continue;
    const call = requested.get(
      `${event.sessionId}:${String(payload.call_id ?? "")}`);
    if (!call || !call.command || call.eventId <= lastWrite
      || event.eventId <= call.eventId) continue;
    successful.set(call.command,
      Math.max(successful.get(call.command) ?? 0, event.eventId));
  }
  const missing = [report.compile.command, report.unit_test.command]
    .filter((command) => !successful.has(command));
  return missing.length
    ? `报告中的命令没有在最后一次代码修改后真实成功执行: ${missing.join("；")}`
    : "";
}

export function prePushMission(request: PrePushRunRequest): string {
  return [
    "你是 Cloud 的推送前验证与修复 Agent。这是独立专项会话，不在 Mae-Flow 内核流程中。",
    "不要执行 current、done、agent-task、AskUserQuestion，也不要读取或修改 .mae-flow 状态。",
    `任务：${request.taskId}；待验证 HEAD：${request.sha}；目标分支：${request.branch}`,
    `需求背景：${request.requirement}`,
    "",
    "你的唯一目标：在当前仓库找到真实构建方式，完成编译与单元测试；遇到代码或测试问题就直接修复，",
    "然后重新执行编译和 UT，直至两项都通过。可以自由检查源码、测试、pom/build/CMake/package 配置，",
    "但不要顺手重构无关代码。代码修改使用 Edit/Write 工具，不要用 shell 文本替换伪装修改。",
    "如有修改，按仓库现有提交规范提交到本地 HEAD；禁止 push、改 remote、读取或写入任何凭据，",
    "Cloud 会在会话释放并复核后注入短期凭据、统一推送。禁止递归强删；clean 请走构建工具生命周期。",
    "依赖下载、工具缺失、磁盘/网络/权限等不是改代码能解决的问题，归类为 infrastructure_failure，",
    "写清缺什么后停止，不要为了制造绿灯篡改测试、关闭检查或编造执行结果。",
    "",
    "收口前确认 git status 没有应提交的业务改动。最后一段必须严格输出下面结构（命令须与实际 Bash 调用完全一致）：",
    "<prepush-result>",
    '{"status":"passed|code_failure|infrastructure_failure",'
      + '"compile":{"command":"实际命令","status":"passed|failed|skipped","summary":"简述"},'
      + '"unit_test":{"command":"实际命令","status":"passed|failed|skipped","summary":"简述"},'
      + '"summary":"最终结论"}',
    "</prepush-result>",
    "只有编译和 UT 都在最后一次代码修改后真实返回成功，status 才能写 passed。",
  ].join("\n");
}
