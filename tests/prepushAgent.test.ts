import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticEvent } from "../src/semanticEvents.ts";
import {
  createPrePushGateContract,
  parsePrePushAgentReport,
  prePushSecurityDecision,
  verifyPrePushEvidence,
  type PrePushAgentReport,
} from "../src/prepushAgent.ts";

function event(
  eventId: number,
  kind: SemanticEvent["kind"],
  payload: Record<string, unknown>,
): SemanticEvent {
  return {
    eventId,
    taskId: "T-prepush",
    sessionId: "prepush-1",
    ts: "2026-08-21 10:00:00",
    kind,
    payload,
  };
}

function block(value: unknown): string {
  return `<prepush-result>${JSON.stringify(value)}</prepush-result>`;
}

const PASSED: PrePushAgentReport = {
  status: "passed",
  compile: { command: "mvn -q -DskipTests package", status: "passed" },
  unit_test: { command: "mvn -q test", status: "passed" },
  summary: "编译和单元测试通过",
};

test("prepush parser: 解析结构化结论并只认最后一个收口块", () => {
  const parsed = parsePrePushAgentReport(`说明\n${block(PASSED)}\n完成`);
  assert.deepEqual(parsed, PASSED);

  const failed = {
    status: "code_failure",
    compile: { command: "npm run build", status: "passed" },
    unit_test: { command: "npm test", status: "failed", summary: "2 failed" },
    summary: "测试仍失败",
  };
  assert.deepEqual(
    parsePrePushAgentReport(`${block(PASSED)}\n更正：${block(failed)}`),
    failed,
  );
  assert.equal(
    parsePrePushAgentReport(`${block(PASSED)}\n<prepush-result>{broken}</prepush-result>`),
    undefined,
  );
});

test("prepush parser: 拒绝畸形和自相矛盾的通过结论", () => {
  assert.equal(parsePrePushAgentReport("没有收口块"), undefined);
  assert.equal(parsePrePushAgentReport(block({
    ...PASSED,
    status: "passed",
    unit_test: { command: "mvn test", status: "failed" },
  })), undefined);
  assert.equal(parsePrePushAgentReport(block({
    ...PASSED,
    compile: { command: "", status: "passed" },
  })), undefined);
  assert.equal(parsePrePushAgentReport(block({
    ...PASSED,
    status: "code_failure",
  })), undefined);
});

test("prepush evidence: 编译和 UT 必须在最后一次修改后真实成功", () => {
  const events = [
    event(1, "tool_requested", {
      call_id: "edit", name: "Edit", input: { path: "src/a.ts" },
    }),
    event(2, "tool_requested", {
      call_id: "compile", name: "Bash",
      input: { command: PASSED.compile.command },
    }),
    event(3, "tool_finished", {
      call_id: "compile", name: "Bash",
      input: { command: PASSED.compile.command }, is_error: false, result: "ok",
    }),
    event(4, "tool_requested", {
      call_id: "ut", name: "Bash", input: { command: PASSED.unit_test.command },
    }),
    event(5, "tool_finished", {
      call_id: "ut", name: "Bash",
      input: { command: PASSED.unit_test.command }, is_error: false, result: "ok",
    }),
  ];
  assert.equal(verifyPrePushEvidence(events, PASSED), "");

  const modifiedAfterCompile = [
    ...events.slice(1, 3),
    event(6, "tool_requested", {
      call_id: "late-edit", name: "Write", input: { path: "src/a.ts" },
    }),
    ...events.slice(3).map((row) => ({ ...row, eventId: row.eventId + 4 })),
  ];
  assert.match(
    verifyPrePushEvidence(modifiedAfterCompile, PASSED),
    /mvn -q -DskipTests package/,
  );
});

test("prepush evidence: 失败、伪造或不匹配的 Bash 结果不能充当证据", () => {
  const failedEvents = [
    event(1, "tool_requested", {
      call_id: "compile", name: "Bash",
      input: { command: PASSED.compile.command },
    }),
    event(2, "tool_finished", {
      call_id: "compile", name: "Bash",
      input: { command: PASSED.compile.command }, is_error: true, result: "boom",
    }),
    event(3, "tool_requested", {
      call_id: "ut", name: "Bash", input: { command: PASSED.unit_test.command },
    }),
    event(4, "tool_finished", {
      call_id: "wrong-call", name: "Bash",
      input: { command: PASSED.unit_test.command }, is_error: false, result: "ok",
    }),
  ];
  const error = verifyPrePushEvidence(failedEvents, PASSED);
  assert.match(error, /mvn -q -DskipTests package/);
  assert.match(error, /mvn -q test/);
  assert.equal(verifyPrePushEvidence([], {
    ...PASSED,
    status: "infrastructure_failure",
  }), "验证会话没有报告通过");
});

test("prepush gate: 放行构建、UT、本地提交和只读 Git", () => {
  for (const command of [
    "mvn -q test",
    "./gradlew clean test",
    "pnpm install && pnpm test",
    "cmake --build build && ctest --test-dir build",
    "env NODE_ENV=test npm run build",
    "printenv JAVA_HOME",
    "git status --short",
    "git diff --check",
    "git add src test && git commit -m 'fix: compile'",
    "git remote -v",
  ]) {
    assert.equal(prePushSecurityDecision("Bash", command), undefined, command);
  }
});

test("prepush gate: 拦住 push、remote 与凭据改写", () => {
  for (const command of [
    "git push origin HEAD",
    "/usr/bin/git -C . push --force-with-lease",
    "git remote set-url origin https://example.invalid/repo.git",
    "git remote add backup ssh://example.invalid/repo.git",
    "git config --local credential.helper store",
    "git config remote.origin.pushurl ssh://example.invalid/repo.git",
    "git credential fill",
    "printf x >> .git/config",
    "GIT_ASKPASS=/tmp/helper git fetch",
  ]) {
    assert.equal(prePushSecurityDecision("Bash", command)?.action, "deny", command);
  }
});

test("prepush gate: 拦住宿主秘密和危险删除，不误伤仓库 skill", () => {
  for (const [tool, value] of [
    ["Read", ".mae-flow.json"],
    ["Write", ".mae-flow-order.json"],
    ["Bash", "cat .mae-flow-chain.md"],
    ["Read", "../pi-agent/models.json"],
    ["Bash", "cat ../pi-agent/models.json"],
    ["Read", "~/.ssh/id_rsa"],
    ["Bash", "cat $HOME/.netrc"],
    ["Bash", "echo $MODEL_API_KEY"],
    ["Bash", "printenv ACCESS_TOKEN"],
    ["Bash", "env | sort"],
    ["Bash", "rm -rf build"],
    ["Bash", "sudo rm -fr target"],
    ["Bash", "git clean -fdx"],
    ["Bash", "git reset --hard HEAD"],
    ["Bash", "find . -type f -delete"],
  ]) {
    assert.equal(prePushSecurityDecision(tool, value)?.action, "deny", `${tool}: ${value}`);
  }
  assert.equal(prePushSecurityDecision("Read", ".claude/skills/java/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision("Read", ".codex/skills/test/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision(
    "Read", ".mae-flow-work/repository-skills/java/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision("Bash", "rm build/old.log"), undefined);
});

test("prepush gate: 专项硬边界优先，未命中时组合部署契约", () => {
  const seen: string[] = [];
  const contract = createPrePushGateContract((tool, value) => {
    seen.push(`${tool}:${value}`);
    return value === "forbidden-by-deployment"
      ? { action: "deny", reason: "部署策略" }
      : undefined;
  });
  const fakeEvent = event(1, "tool_requested", {
    call_id: "c1", name: "Bash", input: { command: "mvn test" },
  });

  assert.equal(contract("Bash", "git push", fakeEvent)?.action, "deny");
  assert.deepEqual(seen, [], "硬边界命中后不能降级到 fallback");
  assert.equal(contract("Bash", "forbidden-by-deployment", fakeEvent)?.action, "deny");
  assert.deepEqual(seen, ["Bash:forbidden-by-deployment"]);
  assert.equal(contract("Bash", "mvn test", fakeEvent), undefined);
});
