import type { SemanticEvent } from "./semanticEvents.ts";
import type {
  GateContract,
  GateDecision,
} from "./gateService.ts";
import { prePushBuildGuidance } from "./prepushBuildPlaybook.ts";
import type { PrePushExecutionAttestation } from "./prePushVerification.ts";

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
  /** 原生 runner 的加固容器事实；自定义执行器可暂不提供。 */
  execution?: PrePushExecutionAttestation;
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
  // 只给 Read 精确豁免宿主/仓库 Skill 的任务内快照；其他内部文件以及
  // 对 Skill 快照的写入仍拒绝，避免先读出状态再用 Bash 改。
  const kernelStatePath = /(?:^|[\\/\s'"`=])\.mae-flow(?:\.json|-[^\\/\s'"`;&|]+|[\\/])(?:$|[\s'"`;&|\\/])/i;
  const readonlySkillSnapshot = kind === "read"
    && /(?:^|[\\/])\.mae-flow-work[\\/](?:repository|host)-skills[\\/]/i.test(source);
  if (kernelStatePath.test(source) && !readonlySkillSnapshot) {
    return DENY("推送前验证会话不能读取或修改 Mae-Flow 内核现场。");
  }

  // 文件工具和 Bash 都不能伸手碰宿主运行时模型/API Key 或常见凭据。
  // 仓库自己的 .claude/.codex skill 不在此列，避免误伤业务仓能力加载。
  const hostSecretPath = /(?:^|[\\/\s'"`=])(?:pi-agent|\.ssh|\.gnupg|\.aws|\.kube)(?:[\\/]|$)|(?:^|[\\/\s'"`=])\.docker[\\/]config\.json(?:$|[\s'"`;&|])|(?:^|[\\/\s'"`=])(?:\.netrc|\.git-credentials|git-credential(?:\.sh)?)(?:$|[\s'"`;&|])/i;
  if (hostSecretPath.test(source)) {
    return DENY("推送前验证会话不能读取或改写宿主模型配置与凭据。");
  }

  // Maven/npm/Git 的用户级配置可能内含仓库凭据，JDK truststore 与 shell
  // profile 则属于整台宿主机。专项 Agent 只能使用部署时准备好的环境，不能
  // 通过文件工具或 Bash 把一次构建诊断固化成全局配置。仓内 pom、package、
  // .npmrc 等项目配置不匹配这些绝对/用户目录规则，仍可正常读取和修复。
  const homeConfigPath = /(?:~|\$(?:HOME|\{HOME\})|\/(?:root|home\/[^\\/\s'"`;&|]+|Users\/[^\\/\s'"`;&|]+))[\\/](?:\.gitconfig|\.npmrc|\.m2[\\/]settings\.xml|\.(?:bashrc|bash_profile|profile|zshrc|zprofile))(?:$|[\s'"`;&|])/i;
  const systemConfigPath = /(?:^|[\s'"`=])\/(?:etc[\\/](?:gitconfig|npmrc|maven[\\/]settings\.xml|profile(?:\.d[\\/][^\\/\s'"`;&|]+)?)|usr[\\/](?:share[\\/]maven[\\/]conf[\\/]settings\.xml|local[\\/](?:etc[\\/]npmrc|[^\\/\s'"`;&|]*jdk[^\\/\s'"`;&|]*[\\/]lib[\\/]security[\\/]cacerts))|Library[\\/]Java[\\/]JavaVirtualMachines[\\/][^\\/\s'"`;&|]+[\\/]Contents[\\/]Home[\\/]lib[\\/]security[\\/]cacerts)(?:$|[\s'"`;&|\\/])/i;
  const systemCertificatePath = /(?:^|[\s'"`=])\/(?:etc[\\/](?:ssl|pki)|usr[\\/]local[\\/]share[\\/]ca-certificates)(?:[\\/]|$)/i;
  const environmentConfigPath = /\$(?:\{(?:JAVA_HOME|M2_HOME|MAVEN_HOME)\}|(?:JAVA_HOME|M2_HOME|MAVEN_HOME))\/(?:lib\/security\/cacerts|conf\/settings\.xml)(?:$|[\s'"`;&|])/i;
  if (homeConfigPath.test(source)
    || systemConfigPath.test(source)
    || systemCertificatePath.test(source)
    || environmentConfigPath.test(source)) {
    return DENY("推送前验证会话不能读取或修改宿主的全局 Git、Maven、npm、JDK 或证书配置。");
  }

  // Write/Edit 的 value 在不同接线中可能是路径，也可能带着待写内容；一旦
  // 出现典型认证字段，宁可让宿主注入，也不能把凭据写进仓库配置。
  if (/\b(?:_authToken|authorization|private-token|oauth-token)\b\s*[:=]/i.test(source)) {
    return DENY("推送前验证会话不能读取、写入或持久化认证 Token。");
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
    if (/\bgit\b[\s\S]*\bclone\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中重新克隆仓库；请使用 Cloud 已准备好的工作区。");
    }
    if (/\bgit\b[\s\S]*\bpush\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中执行 git push；Cloud 会统一推送已复核的 HEAD。");
    }
    if (/\bgit\b[\s\S]*\bremote\b[\s\S]*\b(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中改写或更新 Git remote。");
    }
    if (/\bgit\b[\s\S]*\bcredential(?:-[\w-]+)?\b/i.test(segment)) {
      return DENY("禁止在推送前验证会话中读取、批准或改写 Git 凭据。");
    }
    if (/\bgit\b[\s\S]*\bconfig\b[\s\S]*(?:--global\b|--system\b)/i.test(segment)) {
      return DENY("禁止在推送前验证会话中修改宿主级 Git 配置；仅允许使用现有配置和本地提交。");
    }
    if (/\bgit\b[\s\S]*(?:\bconfig\b[\s\S]*\bhttp\.sslverify\b(?:\s|=)+["']?(?:false|0|no|off)\b["']?|(?:^|\s)-c\s*http\.sslverify\s*=\s*["']?(?:false|0|no|off)\b["']?)/i.test(segment)) {
      return DENY("禁止关闭 Git TLS 证书校验；证书问题应报告为宿主基础设施故障。");
    }
    if (/\bgit\b[\s\S]*\bconfig\b[\s\S]*(?:credential\.|remote\.|url\.|http\.[^\s=]*(?:extraheader|token|auth)|core\.askpass|include(?:if)?\.path|gpg\.program|[^\s=]*(?:token|password|passwd|secret|oauth)[^\s=]*)/i.test(segment)) {
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

  // 避免把 Token 直接塞进 URL/header，或让包管理器在 Agent 会话中登录、
  // 改用户配置和全局安装。常规 install/build/test 不受影响。
  if (/\bhttps?:\/\/[^\s'"/@:]+:[^\s'"/@]+@/i.test(source)
    || /\b(?:authorization|private-token|oauth-token)\s*[:=]\s*(?:bearer\s+)?[^\s'";&|]+/i.test(source)
    || /(?:^|\s)(?:--token|--password|--passwd)(?:=|\s+)/i.test(source)) {
    return DENY("禁止在推送前验证会话中读取、传入或持久化远端 Token/密码。");
  }
  if (/\b(?:npm|pnpm|yarn)\b[\s\S]*\b(?:login|logout|adduser|token)\b/i.test(source)
    || /\b(?:npm|pnpm|yarn)\b[\s\S]*\bconfig\b[\s\S]*\b(?:set|delete|del|edit)\b/i.test(source)
    || /\b(?:npm|pnpm)\b[\s\S]*(?:\s-g\b|\s--global\b)[\s\S]*\b(?:add|install|i)\b/i.test(source)
    || /\b(?:npm|pnpm)\b[\s\S]*\b(?:add|install|i)\b[\s\S]*(?:\s-g\b|\s--global\b)/i.test(source)) {
    return DENY("禁止在推送前验证会话中登录包仓、改写包管理器配置或安装全局工具。");
  }

  // TLS/证书只能由部署侧统一维护；专项 Agent 不得以“先跑通”为由关闭
  // 校验或改写系统/JDK truststore。
  if (/\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0\b/i.test(source)
    || /\bGIT_SSL_NO_VERIFY\s*=\s*(?:1|true|yes|on)\b/i.test(source)
    || /\bNPM_CONFIG_STRICT_SSL\s*=\s*(?:0|false|no|off)\b/i.test(source)
    || /-Dmaven\.wagon\.http\.ssl\.(?:insecure|allowall)\s*=\s*true\b/i.test(source)
    || /\bkeytool\b[\s\S]*-(?:importcert|importkeystore|delete|changealias|storepasswd|keypasswd|genkeypair)\b/i.test(source)
    || /\b(?:update-ca-certificates|update-ca-trust)\b/i.test(source)
    || /\bsecurity\b[\s\S]*\badd-trusted-cert\b/i.test(source)) {
    return DENY("禁止关闭 TLS 校验或修改宿主/JDK 证书；请报告基础设施故障。");
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
  const successful: string[] = [];
  const ranBeforeLastWrite: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool_finished") continue;
    const payload = event.payload as Record<string, any>;
    if (String(payload.name ?? "") !== "Bash" || Boolean(payload.is_error)) continue;
    const call = requested.get(
      `${event.sessionId}:${String(payload.call_id ?? "")}`);
    if (!call || !call.command || event.eventId <= call.eventId) continue;
    // 两个桶分开记:一个是合格证据,一个只用来把"跑过但太早"和
    // "压根没跑"区分开——它们对人的含义完全不同(见下面的报错措辞)。
    (call.eventId <= lastWrite ? ranBeforeLastWrite : successful)
      .push(call.command);
  }
  const covers = (bucket: string[], reported: string) => {
    const needle = normalizeCommand(reported);
    return Boolean(needle)
      && bucket.some((actual) => normalizeCommand(actual).includes(needle));
  };
  const missing = [report.compile.command, report.unit_test.command]
    .filter((command) => !covers(successful, command));
  if (!missing.length) return "";
  // 措辞必须让人一眼分清三种情况,否则"跑了但报得不一样"会被当成作弊
  // (2026-08-21 整链试跑实锤:模型真跑了、真绿了、还自己修好一个真编译
  // 错误,却被判"没有真实成功执行",人只能去翻 bash 日志才看得出冤枉)。
  const stale = missing.filter((command) => covers(ranBeforeLastWrite, command));
  if (stale.length === missing.length) {
    return "报告中的命令只在最后一次代码修改/提交之前成功过，改动之后没有重跑: "
      + missing.join("；");
  }
  return "报告中的命令没有在最后一次代码修改后真实成功执行"
    + "（若确实跑过，请核对上报命令与实际 Bash 调用是否一致）: "
    + missing.join("；");
}

/**
 * 命令比对用的归一化。
 *
 * 为什么不是精确相等:使命要求"命令须与实际 Bash 调用完全一致",但模型
 * 实际发的是 `cd /很长的路径 && mvn test; echo TEST_EXIT=$?`,上报的是
 * `mvn test`——要它逐字节回抄一条带路径前缀和退出码后缀的 shell 命令,
 * 现实中不可能稳定做到。精确相等让这道闸**基本过不去**(2026-08-21
 * 首次整链试跑实测:三次合格的成功执行全部落空)。改成包含匹配。
 *
 * 松了多少要说清楚:上报 `mvn test`、实跑 `mvn test -DskipTests` 现在混得
 * 过去。接受这个代价的理由是这道闸的定位——push 前的快速反馈与流量闸门,
 * **不冒充最终质量裁判**;真裁判是绑提交 SHA 的流水线。一道永远过不去的
 * 闸比一道稍松的闸有害得多。"退出成功"和"发生在最后一次修改之后"两条
 * 硬约束都没动。
 */
function normalizeCommand(command: string): string {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

export function prePushMission(request: PrePushRunRequest): string {
  const buildGuidance = prePushBuildGuidance(request.workspace);
  return [
    "你是 Cloud 的推送前验证与修复 Agent。这是独立专项会话，不在 Mae-Flow 内核流程中。",
    "不要执行 current、done、AskUserQuestion，也不要读取或修改 .mae-flow 状态。",
    `任务：${request.taskId}；待验证 HEAD：${request.sha}；目标分支：${request.branch}`,
    `需求背景：${request.requirement}`,
    "",
    "你的唯一目标：在当前仓库找到真实构建方式，完成编译与单元测试；遇到代码或测试问题就直接修复，",
    "然后重新执行编译和 UT，直至两项都通过。可以自由检查源码、测试、pom/build/CMake/package 配置，",
    "但不要顺手重构无关代码。代码修改使用 Edit/Write 工具，不要用 shell 文本替换伪装修改。",
    "如有修改，按仓库现有提交规范提交到本地 HEAD；禁止 push、改 remote、读取或写入任何凭据，",
    "Cloud 会在会话释放并复核后注入短期凭据、统一推送。禁止递归强删；clean 请走构建工具生命周期。",
    "平台现场文件(.mae-flow* / openspec/config.yaml 等)不归你管：它们已被平台登记忽略，",
    "即使仍显示为未跟踪也不要提交、删除，更不要为它们修改用户的 .gitignore——那是用户的文件。",
    "依赖下载、工具缺失、磁盘/网络/权限等不是改代码能解决的问题，归类为 infrastructure_failure，",
    "写清缺什么后停止，不要为了制造绿灯篡改测试、关闭检查或编造执行结果。",
    "",
    buildGuidance,
    "",
    // 原文要求"与实际 Bash 调用完全一致",但模型实际发的是带 cd 前缀和
    // 退出码后缀的长命令,做不到逐字节回抄——这条契约把闸卡死过(实测)。
    // 现在只要求写真正执行的那一段构建命令,宿主按包含匹配核对。
    "收口前确认 git status 没有应提交的业务改动。最后一段必须严格输出下面结构"
      + "（command 写你真正执行的那段构建命令原文，如 `mvn test`；不必带 cd 前缀"
      + "和 echo 退出码后缀，但**不能写没跑过的命令**，宿主会回执行记录核对）：",
    "<prepush-result>",
    '{"status":"passed|code_failure|infrastructure_failure",'
      + '"compile":{"command":"实际命令","status":"passed|failed|skipped","summary":"简述"},'
      + '"unit_test":{"command":"实际命令","status":"passed|failed|skipped","summary":"简述"},'
      + '"summary":"最终结论"}',
    "</prepush-result>",
    "只有编译和 UT 都在最后一次代码修改后真实返回成功，status 才能写 passed。",
    // 用户 2026-08-22 点名的担心:"我就怕只跑编译不跑 UT"。
    // 宿主侧刻意不加"这条命令是不是在跑测试"的判定(会误伤 UT 入口不含
    // test 字样的仓),所以这里必须说到明面上——这条靠的是嘱咐,不是闸。
    // 措辞不许夸大宿主的核对能力:它核的是"你上报的命令确实成功跑过",
    // 核不出那条命令跑的是编译还是测试。
    "unit_test 必须填**真跑过测试**的那条命令（Java 编译栏可用"
      + " `mvn package -DskipTests`，但 UT 栏仍须另填 `mvn test`；C++ 可用"
      + "`mvn compile -DDT_test=UT -DDT_run=true`、`npm test`），"
      + "**不能把编译命令填进 UT 栏顶账**：只编译不跑 UT 等于这一关没做，"
      + "代价是把没测过的代码推上去烧流水线。"
      + "仓库确实没有 UT 入口时，如实报 code_failure 并写清楚，不要以编译代替。",
  ].join("\n");
}
