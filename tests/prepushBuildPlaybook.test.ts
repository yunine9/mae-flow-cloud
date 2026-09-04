import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPrePushBuildProfile,
  isPrePushBuildCommand,
  fullSuiteCommandVerdict,
  PrePushCommandRepeatGuard,
  prePushBuildGuidance,
  prePushCommandTimeoutSeconds,
  renderPrePushBuildGuidance,
  resolvePrePushExecutionBudget,
} from "../src/prepushBuildPlaybook.ts";
import { prePushMission } from "../src/prepushAgent.ts";

function repository(files: Record<string, string>): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "mae-flow-build-playbook-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("build playbook: Java 先 package 跳测试，再单独跑定向 UT", (t) => {
  const repo = repository({
    "pom.xml": "<project><build><plugins><artifactId>maven-compiler-plugin</artifactId></plugins></build></project>",
    "README.md": "# build",
    "mvnw": "#!/bin/sh",
  });
  t.after(repo.cleanup);

  const profile = detectPrePushBuildProfile(repo.root);
  assert.deepEqual(profile.stacks, ["java"]);
  assert.equal(profile.maven, true);
  assert.equal(profile.maven_command, "./mvnw");
  assert.deepEqual(profile.repository_guides, ["README.md", "mvnw"]);

  const guidance = renderPrePushBuildGuidance(profile);
  assert.match(guidance, /\.\/mvnw package -DskipTests/);
  assert.match(guidance, /-Dtest=ClassName#method/);
  assert.match(guidance, /只跑受影响/);
  assert.match(guidance, /不要跑全仓 UT/);
  assert.match(guidance, /不要先跑一次带测试的 package 又重复跑 test/);
  assert.match(guidance, /-Dtest=ClassName#method/);
  assert.match(guidance, /JDK 21/);
});

test("build playbook: JS 安装条件化且明确禁止无脑 clean", (t) => {
  const repo = repository({
    "pom.xml": "<project/>",
    "website/package.json": "{\"scripts\":{\"build-prod\":\"webpack\"}}",
    "website/package-lock.json": "{}",
    "website/node_modules/.keep": "",
    "website/install.sh": "#!/bin/sh",
  });
  t.after(repo.cleanup);

  const profile = detectPrePushBuildProfile(repo.root);
  assert.deepEqual(profile.stacks, ["javascript"]);
  assert.equal(profile.javascript?.package_manager, "npm");
  assert.equal(profile.javascript?.dependencies_present, true);

  const guidance = prePushBuildGuidance(repo.root);
  assert.match(guidance, /除非 package 清单\/锁文件变化.*不要重复安装/);
  assert.match(guidance, /不要无脑执行 Maven clean/);
  assert.match(guidance, /不要把前端 build 冒充 UT/);
  assert.match(guidance, /website\/install\.sh/);
});

test("build playbook: 识别 C++ Maven DT 与定向覆盖参数", (t) => {
  const repo = repository({
    "pom.xml": "<project><properties><DT_test>UT</DT_test><DT_run>true</DT_run></properties></project>",
    "CMakeLists.txt": "project(native)",
    "src/main/cpp/example.cc": "int main() {}",
  });
  t.after(repo.cleanup);

  const profile = detectPrePushBuildProfile(repo.root);
  assert.deepEqual(profile.stacks, ["cpp"]);
  assert.ok(profile.signals.includes("pom.xml:native/DT"));

  const guidance = prePushBuildGuidance(repo.root);
  // 命令口径以 mcde 的 mae-remote-build skill 真件为准:没有 -DDT_run,
  // 增量/全量只差一个 clean(用户 2026-09-04 提供)。
  assert.match(guidance, /mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT/);
  assert.doesNotMatch(guidance, /mvn clean compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT/);
  assert.match(guidance, /必须从输出确认 UT 进程确实执行/);
  assert.match(guidance, /ctest --output-on-failure/);
  // 缩小范围首选目录;DT_COV_INCLUDES 只作为"先核实再用"的候选出现,
  // 不能再被当成通用开关写进命令。
  assert.match(guidance, /首选是目录/);
  assert.match(guidance, /DT_COV_INCLUDES[^]{0,80}不在 mcde skill 里/);
  assert.match(guidance, /GCC\/G\+\+/);
});

test("build playbook: 混合仓保留全部维度并让 Skill/仓库事实优先", (t) => {
  const repo = repository({
    "pom.xml": "<project><artifactId>maven-compiler-plugin</artifactId><DT_run>true</DT_run></project>",
    "src/main/java/App.java": "class App {}",
    "src/main/native/main.cc": "int main() {}",
    "website/package.json": "{}",
    "website/pnpm-lock.yaml": "lockfileVersion: 9",
    ".mae-flow-work/repository-skills/java/SKILL.md": "# Java",
    "CONTRIBUTING.md": "custom build",
  });
  t.after(repo.cleanup);

  const profile = detectPrePushBuildProfile(repo.root);
  assert.deepEqual(profile.stacks, ["javascript", "cpp", "java"]);
  assert.equal(profile.javascript?.package_manager, "pnpm");
  assert.equal(profile.selected_skill_snapshot, true);

  const guidance = renderPrePushBuildGuidance(profile);
  assert.match(guidance, /pom\/package.*真实可执行入口.*业务仓 Skill.*辅助说明/);
  assert.match(guidance, /按当前任务判断相关性后自行决定是否读取/);
  assert.match(guidance, /混合仓/);
  assert.match(guidance, /一次 Maven 生命周期定向覆盖时不要重复构建/);
});

test("build budget: 慢 native 构建不再被 Agent 的 600 秒截断", () => {
  const nativeProfile = {
    stacks: ["cpp" as const],
    maven: true,
    maven_command: "mvn" as const,
    repository_guides: [],
    selected_skill_snapshot: false,
    signals: ["pom.xml:native/DT"],
  };
  const budget = resolvePrePushExecutionBudget(nativeProfile);
  assert.equal(budget.attemptTimeoutMs, 60 * 60_000);
  assert.equal(budget.buildCommandTimeoutMs, 45 * 60_000);
  assert.equal(prePushCommandTimeoutSeconds(
    "cd service && mvn compile -DDT_test=UT -DDT_run=true",
    600,
    budget,
  ), 45 * 60);
  assert.equal(prePushCommandTimeoutSeconds(
    "git status --short",
    60,
    budget,
  ), 60, "普通探查仍尊重短 timeout");
  assert.equal(prePushCommandTimeoutSeconds(
    "cmake --build build --target probe",
    undefined,
    budget,
  ), 45 * 60);
  assert.equal(isPrePushBuildCommand("mvn --version"), false);
  assert.equal(isPrePushBuildCommand("./gradlew test"), true);
});

test("build budget: 部署覆盖仍给整轮清理和收口留余量", () => {
  const profile = {
    stacks: ["java" as const],
    maven: true,
    maven_command: "mvn" as const,
    repository_guides: [],
    selected_skill_snapshot: false,
    signals: ["pom.xml:java"],
  };
  const budget = resolvePrePushExecutionBudget(profile, {
    attemptTimeoutMs: 20 * 60_000,
    buildCommandTimeoutMs: 30 * 60_000,
  });
  assert.equal(budget.attemptTimeoutMs, 20 * 60_000);
  assert.equal(budget.buildCommandTimeoutMs, 18 * 60_000,
    "短整轮按 10% 安全余量截住单命令预算");
  assert.equal(prePushCommandTimeoutSeconds("mvn test", 3600, budget), 18 * 60);
});

test("Build-Fix 全仓 UT 护栏只拦明显全量命令，定向选择器正常放行", () => {
  // 定向选择器是这些生态的标配,拦下去 Agent 一定换得出来。
  for (const command of [
    "mvn test",
    "./mvnw verify",
    "npm test",
    "./gradlew test",
    "cargo test",
    "go test ./...",
    "pytest",
  ]) assert.equal(fullSuiteCommandVerdict(command), "blocked", command);

  // C++/native 只提示:DT include 能不能用取决于仓库自己的插件配置,
  // 平台没在真仓上验证过。硬拒会让整个 C++ 仓跑不了 UT——代价不对等
  // (用户 2026-09-04 拍板"改成提示吧")。
  for (const command of [
    // mcde 的 mae-remote-build skill 真件口径:没有 DT_run,增量/全量只差
    // 一个 clean。只认带 DT_run 的写法等于对真实命令视而不见。
    "mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT",
    "mvn clean install -U -DDEBUG_FLAG=DEBUG -DDT_test=UT -s ${HOME}/settings.xml",
    "mvn compile -DDT_test=UT -DDT_run=true",
    "ctest --output-on-failure",
    "ctest",
  ]) assert.equal(fullSuiteCommandVerdict(command), "advised", command);

  for (const command of [
    "mvn package -DskipTests",
    "mvn -pl order -Dtest=OrderServiceTest test",
    "mvn compile -DDT_test=UT -DDT_run=true -DDT_COV_INCLUDES=*Order*",
    "npm test -- src/order.test.ts",
    "npm run test:order",
    "ctest -R Order --output-on-failure",
    "go test ./internal/order",
    "pytest tests/test_order.py",
  ]) assert.equal(fullSuiteCommandVerdict(command), "none", command);
});

test("build playbook: 安全地忽略符号链接，不建议泄露凭据或关闭 SSL", (t) => {
  const repo = repository({});
  t.after(repo.cleanup);
  const outside = join(tmpdir(), `mae-flow-outside-pom-${process.pid}.xml`);
  writeFileSync(outside, "<project><DT_run>true</DT_run></project>");
  t.after(() => rmSync(outside, { force: true }));
  symlinkSync(outside, join(repo.root, "pom.xml"));
  const outsideWebsite = mkdtempSync(join(tmpdir(), "mae-flow-outside-website-"));
  t.after(() => rmSync(outsideWebsite, { recursive: true, force: true }));
  writeFileSync(join(outsideWebsite, "package.json"), "{}");
  symlinkSync(outsideWebsite, join(repo.root, "website"));

  const profile = detectPrePushBuildProfile(repo.root);
  assert.deepEqual(profile.stacks, []);
  assert.equal(profile.maven, false);

  const guidance = renderPrePushBuildGuidance(profile);
  assert.match(guidance, /注入令牌/);
  assert.match(guidance, /不要关闭 TLS\/SSL 校验/);
  assert.doesNotMatch(guidance, /http\.sslVerify\s+false/i);
  assert.doesNotMatch(guidance, /https?:\/\/[^\s]+@/i);
  assert.match(guidance, /确实没有 UT 入口时如实报告/);
});

test("build playbook: 实际注入 Build-Fix Agent mission，而非仅停留在文档", (t) => {
  const repo = repository({
    "pom.xml": "<project><artifactId>maven-compiler-plugin</artifactId></project>",
    "src/main/java/App.java": "class App {}",
  });
  t.after(repo.cleanup);

  const mission = prePushMission({
    taskId: "TASK-PLAYBOOK",
    workspace: repo.root,
    sha: "a".repeat(40),
    round: 1,
    requirement: "验证构建经验接线",
    branch: "feature/playbook",
    baseline: "main",
  }, {
    attemptTimeoutMs: 60 * 60_000,
    buildCommandTimeoutMs: 45 * 60_000,
  });
  assert.match(mission, /内网 Build-Fix 参考/);
  assert.match(mission, /pom\/package.*真实可执行入口/);
  assert.match(mission, /mvn package -DskipTests/);
  assert.match(mission, /UT 只跑受本次改动影响/);
  assert.match(mission, /全量回归由远端权威流水线负责/);
  assert.doesNotMatch(mission, /收口前.*完整范围/);
  assert.match(mission, /内网经验只在仓库材料没有说明时兜底/);
  assert.match(mission, /整轮最多 60 分钟/);
  assert.match(mission, /重型构建单条至少获得 45 分钟/);
  assert.match(mission, /不要自行用 600 秒/);
  assert.match(mission, /不要求 git status 为空/);
  assert.match(mission, /不要为了清空状态把编译产物提交进去/);
  assert.match(mission, /不要使用 fix: \/ feat: \/ chore:/);
  assert.match(mission, /同一份代码内容不要原样重复/);
});

test("Build-Fix 重型命令护栏：成功复用，失败仅允许一次原样重试", () => {
  const guard = new PrePushCommandRepeatGuard();
  const command = "mvn   test";
  assert.equal(guard.decide("tree-a", command), "execute");
  guard.record("tree-a", command, 1);
  assert.equal(guard.decide("tree-a", "mvn test"), "execute",
    "同代码首次失败后允许一次短暂环境抖动重试");
  guard.record("tree-a", "mvn test", 1);
  assert.equal(guard.decide("tree-a", command), "block_repeat");
  assert.equal(guard.decide("tree-b", command), "execute",
    "代码内容变化后自然获得新验证机会");

  const passed = new PrePushCommandRepeatGuard();
  passed.record("tree-a", command, 0);
  assert.equal(passed.decide("tree-a", "mvn test"), "reuse_success");
});
