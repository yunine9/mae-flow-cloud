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
  assert.match(guidance, /\.\/mvnw test/);
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
  assert.match(guidance, /mvn compile -DDT_test=UT -DDT_run=true/);
  assert.match(guidance, /mvn clean compile -DDT_test=UT -DDT_run=true/);
  assert.match(guidance, /必须从输出确认 UT 进程确实执行/);
  assert.match(guidance, /ctest --output-on-failure/);
  assert.match(guidance, /DT_COV_INCLUDES/);
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
  assert.match(guidance, /一次 Maven 生命周期覆盖时不要重复构建/);
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

test("build playbook: 实际注入预推送 Agent mission，而非仅停留在文档", (t) => {
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
  assert.match(mission, /内网推送前构建参考/);
  assert.match(mission, /pom\/package.*真实可执行入口/);
  assert.match(mission, /mvn package -DskipTests/);
  assert.match(mission, /mvn test/);
  assert.match(mission, /内网经验只在仓库材料没有说明时兜底/);
  assert.match(mission, /整轮最多 60 分钟/);
  assert.match(mission, /重型构建单条至少获得 45 分钟/);
  assert.match(mission, /不要自行用 600 秒/);
  assert.match(mission, /不要求 git status 为空/);
  assert.match(mission, /不要为了清空状态把编译产物提交进去/);
});
