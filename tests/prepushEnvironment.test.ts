import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRE_PUSH_ENVIRONMENT_SUCCESS_MARKER,
  hasContainerVolumeDestination,
  inspectPrePushEnvironment,
  prePushEnvironmentCommand,
} from "../src/prepushEnvironment.ts";
import type { PrePushBuildProfile } from "../src/prepushBuildPlaybook.ts";

const mixedProfile: PrePushBuildProfile = {
  stacks: ["java", "javascript", "cpp"],
  maven: true,
  maven_command: "mvn",
  repository_guides: ["README.md"],
  selected_skill_snapshot: false,
  javascript: {
    root: "website",
    package_manager: "npm",
    dependencies_present: false,
  },
  signals: ["pom.xml:java", "pom.xml:native/DT", "website/package.json"],
};

test("推送前环境预检覆盖 Maven 实际 JDK/settings/cacerts 与 C++ 拓扑", () => {
  const command = prePushEnvironmentCommand({
    profile: mixedProfile,
    requireMavenSettings: true,
  });
  assert.match(command, /passwd_home/);
  assert.match(command, /mvn --version/);
  assert.match(command, /Java version: 21/);
  assert.match(command, /runtime:/);
  assert.match(command, /lib\/security\/cacerts/);
  assert.match(command, /\/etc\/mae-flow\/maven\/settings\.xml/);
  assert.match(command, /\$HOME\/\.m2\/settings\.xml/);
  assert.match(command, /\/cache\/maven/);
  assert.match(command, /\/cache\/npm/);
  assert.match(command, /cpp_sdk_repository/);
  assert.match(command, /build\/\.\.\/\.\./);
  assert.doesNotMatch(command, /\bcurl\b|\bwget\b/,
    "环境预检只读本地事实，不能自己制造慢网络探测");
});

test("未声明 Maven settings 时不把公共仓强行锁死", () => {
  const command = prePushEnvironmentCommand({
    profile: mixedProfile,
    requireMavenSettings: false,
  });
  assert.doesNotMatch(command, /部署声明了 Maven settings/);
  assert.doesNotMatch(command, /\$HOME\/\.m2\/settings\.xml/);
});

test("预检结果把明确缺项直接转换为基础设施诊断", () => {
  const failed = inspectPrePushEnvironment(78, [
    "Apache Maven 3.6.3",
    "__MFC_PREPUSH_ENV_FAIL__:Maven 实际使用的不是 JDK 21",
  ].join("\n"));
  assert.equal(failed.ready, false);
  assert.match(failed.detail, /Maven 实际使用的不是 JDK 21/);
  const passed = inspectPrePushEnvironment(
    0,
    `versions ok\n${PRE_PUSH_ENVIRONMENT_SUCCESS_MARKER}\n`,
  );
  assert.deepEqual(passed, {
    ready: true,
    detail: "容器构建环境预检通过",
  });
});

test("volume 目标识别兼容 ro/rw 后缀", () => {
  assert.equal(hasContainerVolumeDestination(
    ["/deploy/settings.xml:/etc/mae-flow/maven/settings.xml:ro"],
    "/etc/mae-flow/maven/settings.xml",
  ), true);
  assert.equal(hasContainerVolumeDestination(
    ["/cache:/cache/maven:rw"],
    "/etc/mae-flow/maven/settings.xml",
  ), false);
});
