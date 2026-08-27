import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type PrePushBuildStack = "java" | "javascript" | "cpp";

export interface PrePushBuildProfile {
  stacks: PrePushBuildStack[];
  /** 所有已识别语言是否都由根 pom.xml 编排。 */
  maven: boolean;
  maven_command: "./mvnw" | "mvn";
  repository_guides: string[];
  selected_skill_snapshot: boolean;
  javascript?: {
    root: "website";
    package_manager: "npm" | "pnpm" | "yarn";
    dependencies_present: boolean;
  };
  signals: string[];
}

export interface PrePushExecutionBudget {
  /** 整个专项 Agent 的墙钟上限。 */
  attemptTimeoutMs: number;
  /** 被识别为重型构建的单条命令至少获得的墙钟预算。 */
  buildCommandTimeoutMs: number;
}

export interface PrePushExecutionBudgetOptions {
  attemptTimeoutMs?: number;
  buildCommandTimeoutMs?: number;
}

const MINUTE_MS = 60_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * MINUTE_MS;
const DEFAULT_NATIVE_ATTEMPT_TIMEOUT_MS = 60 * MINUTE_MS;
const DEFAULT_BUILD_COMMAND_TIMEOUT_MS = 20 * MINUTE_MS;
const DEFAULT_NATIVE_BUILD_COMMAND_TIMEOUT_MS = 45 * MINUTE_MS;
const MAX_ATTEMPT_SAFETY_MARGIN_MS = 5 * MINUTE_MS;

function positiveBudget(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * 慢 native 仓不能沿用普通 Java 仓的墙钟预算。这里由平台给出默认值，
 * 部署仍可按代表仓的 P95 显式覆盖；无论怎样都给整轮留出清理和收口余量。
 */
export function resolvePrePushExecutionBudget(
  profile: PrePushBuildProfile,
  options: PrePushExecutionBudgetOptions = {},
): PrePushExecutionBudget {
  const native = profile.stacks.includes("cpp");
  const attemptTimeoutMs = positiveBudget(
    options.attemptTimeoutMs,
    native ? DEFAULT_NATIVE_ATTEMPT_TIMEOUT_MS : DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  const requestedBuildTimeoutMs = positiveBudget(
    options.buildCommandTimeoutMs,
    native
      ? DEFAULT_NATIVE_BUILD_COMMAND_TIMEOUT_MS
      : DEFAULT_BUILD_COMMAND_TIMEOUT_MS,
  );
  const safetyMarginMs = Math.min(
    MAX_ATTEMPT_SAFETY_MARGIN_MS,
    Math.max(1_000, Math.floor(attemptTimeoutMs / 10)),
  );
  const buildCeilingMs = Math.max(1_000, attemptTimeoutMs - safetyMarginMs);
  return {
    attemptTimeoutMs,
    buildCommandTimeoutMs: Math.min(requestedBuildTimeoutMs, buildCeilingMs),
  };
}

/**
 * 只识别明确进入构建/测试生命周期的命令。普通只读探查不能因为仓库含
 * C++ 就被放宽到几十分钟；反过来，命令带 cd/env/重定向也不能漏识别。
 */
export function isPrePushBuildCommand(command: string): boolean {
  const value = command.toLowerCase();
  const maven = /(?:^|[\s;&|()])(?:mvn|\.\/mvnw)(?:\s|$)/.test(value)
    && /(?:^|\s)(?:compile|test|package|verify|install)(?:\s|$)/.test(value);
  const gradle = /(?:^|[\s;&|()])(?:gradle|\.\/gradlew)(?:\s|$)/.test(value)
    && /(?:^|\s)(?:assemble|build|check|test)(?:\s|$)/.test(value);
  const cmake = /(?:^|[\s;&|()])cmake\s+[^;&|\n]*--build(?:\s|$)/.test(value);
  const nativeRunner = /(?:^|[\s;&|()])(?:make|gmake|ninja|ctest)(?:\s|$)/
    .test(value);
  const packageRunner = /(?:^|[\s;&|()])(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|check)(?:\s|$)/
    .test(value);
  const otherRunner = /(?:^|[\s;&|()])(?:cargo\s+(?:build|test)|go\s+test)(?:\s|$)/
    .test(value);
  return maven || gradle || cmake || nativeRunner || packageRunner || otherRunner;
}

/**
 * 模型可以建议 timeout，但不能用一个随手填的 600 秒截断平台已知的慢构建。
 * 重型命令的 timeout 被抬到平台下限，并限制在整轮预算的安全余量内。
 */
export function prePushCommandTimeoutSeconds(
  command: string,
  requested: number | undefined,
  budget: PrePushExecutionBudget,
): number | undefined {
  if (!isPrePushBuildCommand(command)) return requested;
  if (requested !== undefined
      && (!Number.isFinite(requested) || requested <= 0)) return requested;
  const floor = Math.max(1, Math.ceil(budget.buildCommandTimeoutMs / 1_000));
  const safetyMarginMs = Math.min(
    MAX_ATTEMPT_SAFETY_MARGIN_MS,
    Math.max(1_000, Math.floor(budget.attemptTimeoutMs / 10)),
  );
  const ceiling = Math.max(
    1,
    Math.floor((budget.attemptTimeoutMs - safetyMarginMs) / 1_000),
  );
  return Math.min(Math.max(requested ?? floor, floor), ceiling);
}

const MAX_TEXT_BYTES = 512 * 1024;

function safeFixedPath(workspace: string, relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    return undefined;
  }
  let current = resolve(workspace);
  try {
    // O_NOFOLLOW 只保护末级；逐段 lstat 才能拒绝 website 等中间目录链接。
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return undefined;
    }
    return current;
  } catch {
    return undefined;
  }
}

function pathKind(workspace: string, relativePath: string): "file" | "directory" | undefined {
  try {
    // 只检查固定相对路径，并拒绝符号链接；业务仓内容不能借扫描器读取工作区外文件。
    const target = safeFixedPath(workspace, relativePath);
    if (!target) return undefined;
    const stat = lstatSync(target);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
  } catch {
    // 缺失、无权限或损坏均视为没有该提示，真正执行时由 Agent 报告。
  }
  return undefined;
}

function textFile(workspace: string, relativePath: string): string {
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW 让“先 lstat、随后被替换成链接”的竞态也无法越出工作区。
    const target = safeFixedPath(workspace, relativePath);
    if (!target) return "";
    descriptor = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return "";
    const value = readFileSync(descriptor);
    if (value.includes(0)) return "";
    return value.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hasFile(workspace: string, relativePath: string): boolean {
  return pathKind(workspace, relativePath) === "file";
}

function hasDirectory(workspace: string, relativePath: string): boolean {
  return pathKind(workspace, relativePath) === "directory";
}

/**
 * 只做保守的仓库特征识别，不替 Agent 决定构建命令。仓库可能同时包含
 * Java、前端和 native 模块，因此 stacks 是集合而不是互斥的“仓库类型”。
 */
export function detectPrePushBuildProfile(workspace: string): PrePushBuildProfile {
  const pom = textFile(workspace, "pom.xml");
  const hasPom = Boolean(pom);
  const signals: string[] = [];
  const stacks: PrePushBuildStack[] = [];

  const hasWebsite = hasFile(workspace, "website/package.json");
  if (hasWebsite) {
    stacks.push("javascript");
    signals.push("website/package.json");
  }

  const nativeSignals = [
    "CMakeLists.txt",
    "src/main/cpp",
    "src/test/cpp",
    "src/main/native",
    "src/test/native",
    "native",
  ].filter((path) => hasFile(workspace, path) || hasDirectory(workspace, path));
  const nativePom = /(?:DT_test|DT_run|DT_COV_INCLUDES|DT_COV_EXCLUDES|cmake|cpp|native)/i
    .test(pom);
  if (nativeSignals.length || nativePom) {
    stacks.push("cpp");
    signals.push(...nativeSignals);
    if (nativePom) signals.push("pom.xml:native/DT");
  }

  const javaSignals = ["src/main/java", "src/test/java"]
    .filter((path) => hasDirectory(workspace, path));
  const javaPom = /(?:maven-compiler-plugin|maven-surefire-plugin|<maven\.compiler\.|<source>\s*(?:8|11|17|21)\s*<\/source>)/i
    .test(pom);
  if (javaSignals.length || javaPom || (hasPom && !nativePom && !hasWebsite)) {
    stacks.push("java");
    signals.push(...javaSignals);
    if (javaPom) signals.push("pom.xml:java");
    else if (hasPom && !nativePom && !hasWebsite) signals.push("pom.xml:maven-default");
  }

  const repositoryGuides = [
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "mvnw",
    "build.sh",
    "compile.sh",
    "install.sh",
    "website/install.sh",
  ].filter((path) => hasFile(workspace, path));

  let javascript: PrePushBuildProfile["javascript"];
  if (hasWebsite) {
    const packageManager = hasFile(workspace, "website/pnpm-lock.yaml")
      ? "pnpm"
      : hasFile(workspace, "website/yarn.lock")
        ? "yarn"
        : "npm";
    javascript = {
      root: "website",
      package_manager: packageManager,
      dependencies_present: hasDirectory(workspace, "website/node_modules"),
    };
  }

  return {
    stacks,
    maven: hasPom,
    maven_command: hasFile(workspace, "mvnw") ? "./mvnw" : "mvn",
    repository_guides: repositoryGuides,
    selected_skill_snapshot: hasDirectory(
      workspace,
      ".mae-flow-work/repository-skills",
    ),
    ...(javascript ? { javascript } : {}),
    signals: [...new Set(signals)],
  };
}

function stackLabel(stack: PrePushBuildStack): string {
  if (stack === "javascript") return "JS/前端";
  if (stack === "cpp") return "C++";
  return "Java";
}

/**
 * 把内网实战经验作为 advisory 送给专项 Agent。它不是硬编码执行器：业务仓
 * 的可执行配置与脚本是事实，相关 Skill 负责解释，内网经验只在二者未说明时兜底。
 */
export function renderPrePushBuildGuidance(profile: PrePushBuildProfile): string {
  const mvn = profile.maven_command;
  const lines = [
    "### 内网推送前构建参考（建议，不是第二套流程）",
    `识别到：${profile.stacks.length ? profile.stacks.map(stackLabel).join(" + ") : "尚未识别明确语言"}${profile.maven ? "；根目录由 Maven 编排" : ""}。`,
    "先以 pom/package、wrapper、仓库脚本与 CI 配置确认真实可执行入口；再根据已选择业务仓 Skill 的名称和描述判断是否相关，需要时读取其说明。Skill 是辅助说明，不得覆盖真实配置或安全边界；下述内网经验只在仓库材料没有说明时兜底。",
  ];

  if (profile.selected_skill_snapshot) {
    lines.push("当前工作区存在已选择 Skill 的只读快照；按当前任务判断相关性后自行决定是否读取，不要求逐个调用，也不要修改该快照。");
  }
  if (profile.repository_guides.length) {
    lines.push(`优先检查的仓库入口：${profile.repository_guides.join("、")}。`);
  }

  if (profile.maven) {
    lines.push(
      "内网 MAE 仓的统一事实：C++/Java/JS 都以 Maven 为唯一编译入口，各仓私有依赖与环境变量（svc_profile、SDK、DT 参数）由 Maven 插件自动生成和管理——不要绕开它手搓构建，也不要手工 export 它该生成的东西。",
    );
  }
  lines.push(
    "基础设施预检：Java/C++ Maven 构建需要 JDK 21 与 Maven；前端需要仓库兼容的 Node/npm（部署基线为 Node 18/npm 9）；C++ 还需要 GCC/G++、binutils、bison、flex、ccache。缺失、版本不兼容、制品仓 TLS/网络/权限或磁盘问题归类 infrastructure_failure，不要通过改业务代码伪装修复。低版本 JDK 的典型症状是 UnsupportedClassVersionError——那是环境问题，不是代码问题。",
    "平台已经负责 Maven/npm 镜像、证书信任与凭据。不要克隆新副本、注入令牌、改全局 Git/Maven/npm 配置，也不要关闭 TLS/SSL 校验；遇到证书或鉴权故障只记录证据并报告基础设施失败。",
    `增量优先：非首次构建用不带 clean 的 \`${mvn} compile\`（内网实测 C++ 仓 3 分钟→18 秒）；刚克隆的仓上 clean 没有意义，别浪费一次全量。`,
    "长构建不要用管道直连截尾（如 `mvn compile | tail -80`）——tail 要等命令退出才输出，进行中一个字都看不到，超时被杀连诊断都留不下。先落文件再看尾巴：`mvn compile > build.log 2>&1; tail -80 build.log`。",
  );

  if (profile.stacks.includes("java")) {
    lines.push(
      `Java：编译/打包检查默认用 \`${mvn} package -DskipTests\`，UT 再单独用 \`${mvn} test\`。不要先跑一次带测试的 package 又重复跑 test；只需验证编译时 \`${mvn} compile\` 就够。仓库脚本、pom 或已选择 Skill 明确给出其他入口时以仓库事实为准。`,
      "Java 定向 UT 可用 `-Dtest=ClassName`、`-Dtest=ClassName#method`、通配符及 `-pl <module>`；修复循环先跑受影响测试，收口前仍按仓库要求跑完整范围。",
      "Java UT 缺 native 系统库（如 SQLite）属环境问题：报 infrastructure_failure 并点名缺哪个库，不要改业务代码绕。",
    );
  }

  if (profile.stacks.includes("javascript")) {
    const packageManager = profile.javascript?.package_manager ?? "npm";
    const installState = profile.javascript?.dependencies_present
      ? "website/node_modules 已存在；除非 package 清单/锁文件变化或依赖损坏，不要重复安装"
      : "website/node_modules 未发现；按仓库锁文件和脚本安装依赖";
    lines.push(
      `JS/前端：${installState}。检测到 ${packageManager}；优先遵循锁文件/仓库脚本，npm 无更明确入口时才在 website 使用 \`npm install --legacy-peer-deps\`。`,
      "依赖安装必须先于任何 Maven 编译——Maven 的 antrun 插件只调用 `npm run build`，不负责 install，漏了这步编译必失败。依赖版本冲突时先找项目的 install.sh 或仓库指定的 Node 版本，不要盲目改锁文件。",
      `JS/前端由 Maven 编排时优先增量 \`${mvn} compile\`。不要无脑执行 Maven clean，它可能删除 website/node_modules；只有仓库明确要求且已规划重新安装依赖时才 clean。`,
      "UT 必须从 package scripts、pom 或 CI 找到真实入口；不要把前端 build 冒充 UT。仓库明确要求产物构建时，才使用其 `npm run build-prod <version>` 等脚本。",
    );
  }

  if (profile.stacks.includes("cpp")) {
    lines.push(
      `C++/native：优先从 Maven 插件进入。当前内网经验的候选命令是 \`${mvn} compile -DDT_test=UT -DDT_run=true\`；首次完整基线或确认生成物陈旧时才考虑 \`${mvn} clean compile -DDT_test=UT -DDT_run=true\`。这只是候选，必须先核对 pom、仓库脚本与插件说明。`,
      "必须从输出确认 UT 进程确实执行并产生用例/结果摘要，不能只看 Maven BUILD SUCCESS 就把它记作 UT。若 DT 参数只生成或编译测试，则继续使用仓库生成目录中的 ctest --output-on-failure 或仓库专用 runner，最终上报真正执行测试的命令。",
      "C++ 定向 UT 可按仓库支持使用 `-DDT_COV_INCLUDES=\"*ModuleName*\"` 或 `-DDT_COV_EXCLUDES=\"*ModuleName*\"`；先缩小修复反馈环，收口前再覆盖仓库要求范围。",
      `C++ 只需验证编译时去掉 DT 参数：\`${mvn} compile\` 即可；SDK 与 CMake 依赖由 Maven 插件自动拉取，一般无需手动安装。`,
      "svc_profile、SDK 等若由 Maven 生成或拉取，不要手工 export/伪造；工具链或专用依赖确实缺失时报告 infrastructure_failure。",
    );
  }

  if (profile.stacks.length > 1) {
    lines.push("这是混合仓：先确认根 pom 是否已统一编排各模块；能由一次 Maven 生命周期覆盖时不要重复构建，不能覆盖的 UT 再按各模块真实入口补跑并分别记录证据。");
  }
  if (!profile.stacks.length) {
    lines.push("未识别到标准入口：继续从仓库 Skill、说明、脚本和 CI 发现真实编译/UT 命令，不要凭语言印象编造命令；确实没有 UT 入口时如实报告而非以 build 代替。");
  }

  return lines.join("\n");
}

export function prePushBuildGuidance(workspace: string): string {
  return renderPrePushBuildGuidance(detectPrePushBuildProfile(workspace));
}
