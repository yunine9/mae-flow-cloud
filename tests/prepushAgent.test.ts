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
    "JAVA_HOME=/usr/local/jdk-21 mvn compile",
    "mvn -s .mvn/project-settings.xml test",
    "./gradlew clean test",
    "npm install --legacy-peer-deps",
    "pnpm install && pnpm test",
    "npm config get registry",
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

test("prepush gate: build-notes 精确豁免,组合走私照拦", () => {
  // 构建入口沉淀是预热/prepush 共用工作件,不是内核现场(实锤:
  // 预热写入曾被拦报"沙箱限制")。
  for (const [tool, value] of [
    ["Write", ".mae-flow-work/build-notes.md"],
    ["Read", ".mae-flow-work/build-notes.md"],
    ["Bash", "cat > .mae-flow-work/build-notes.md <<'EOF'\n- 增量编译: mvn compile\nEOF"],
    ["Bash", "tail -20 .mae-flow-work/build-notes.md"],
  ] as const) {
    assert.equal(prePushSecurityDecision(tool, value), undefined, value);
  }
  // 同一条命令夹带其他内核现场路径:豁免不放行。
  for (const [tool, value] of [
    ["Bash", "cp .mae-flow.json .mae-flow-work/build-notes.md"],
    ["Bash", "cat .mae-flow-work/story.md > .mae-flow-work/build-notes.md"],
    ["Write", ".mae-flow-work/notes-extra.md"],
  ] as const) {
    assert.equal(
      prePushSecurityDecision(tool, value)?.action, "deny", value);
  }
});

test("prepush gate: 排除语法提到内核现场不算访问(内网误杀实锤)", () => {
  for (const command of [
    // 内网日志原样的两条被误杀命令。
    'cd /data/x/SONFrontendService && grep -r "freq.one2n\\|freq.n2one" '
    + '--include="*.java" . 2>/dev/null | grep -v ".mae-flow-work" | grep -v "target/"',
    "find . -path ./.mae-flow-work -prune -o \\( -name \"*.java\" \\) -print "
    + '| xargs grep -l "freq" 2>/dev/null',
    'grep -r foo --exclude-dir=.mae-flow-work .',
    'git grep foo -- . ":(exclude).mae-flow-work"',
  ]) {
    assert.equal(prePushSecurityDecision("Bash", command), undefined, command);
  }
  // 正向引用不受排除豁免影响,照样拒。
  for (const command of [
    "cat .mae-flow.json",
    "grep foo .mae-flow-work/story.md",
    'grep -v ".mae-flow-work" x | tee .mae-flow-work/story.md',
  ]) {
    assert.equal(
      prePushSecurityDecision("Bash", command)?.action, "deny", command);
  }
});

test("prepush gate: 拦住 push、remote 与凭据改写", () => {
  for (const command of [
    "git push origin HEAD",
    "/usr/bin/git -C . push --force-with-lease",
    "git clone https://example.invalid/repo.git /tmp/repo",
    "git remote set-url origin https://example.invalid/repo.git",
    "git remote add backup ssh://example.invalid/repo.git",
    "git config --local credential.helper store",
    "git config --global user.email agent@example.invalid",
    "git config --system core.autocrlf false",
    "git config http.sslVerify false",
    "git config --local http.sslVerify 'false'",
    "git -c http.sslVerify=false fetch origin",
    "GIT_SSL_NO_VERIFY=true git fetch origin",
    "git config remote.origin.pushurl ssh://example.invalid/repo.git",
    "git config codehub.token secret",
    "git credential fill",
    "git fetch https://user:secret@example.invalid/repo.git",
    "git -c http.extraHeader='Authorization: Bearer secret' fetch origin",
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
    ["Read", "~/.m2/settings.xml"],
    ["Write", "$HOME/.npmrc"],
    ["Bash", "printf x >> ~/.gitconfig"],
    ["Bash", "sed -i s/old/new/ /etc/maven/settings.xml"],
    ["Write", "/etc/ssl/certs/corp-ca.pem"],
    ["Bash", "printf 'export JAVA_HOME=/tmp/jdk' >> ~/.bashrc"],
    ["Bash", "keytool -importcert -file corp.crt -keystore $JAVA_HOME/lib/security/cacerts"],
    ["Bash", "npm config set registry https://example.invalid"],
    ["Write", ".npmrc\n_authToken=secret"],
    ["Bash", "npm login --registry https://example.invalid"],
    ["Bash", "npm install -g typescript"],
    ["Bash", "NODE_TLS_REJECT_UNAUTHORIZED=0 npm test"],
    ["Bash", "mvn -Dmaven.wagon.http.ssl.insecure=true test"],
    ["Bash", "echo $MODEL_API_KEY"],
    ["Bash", "printenv ACCESS_TOKEN"],
    ["Bash", "env | sort"],
    ["Bash", "sudo rm -fr target"],
    ["Bash", "git clean -fdx"],
    ["Bash", "git reset --hard HEAD"],
    ["Bash", "find . -type f -delete"],
    // 产物豁免不外溢:源码/内核现场/上级路径/变量参数照拒。
    ["Bash", "rm -rf src"],
    ["Bash", "rm -rf target ../other"],
    ["Bash", "rm -rf /workspace/target"],
    ["Bash", "rm -rf ${SUB_DIR}/build"],
    ["Bash", "rm -rf target src/main"],
  ]) {
    assert.equal(prePushSecurityDecision(tool, value)?.action, "deny", `${tool}: ${value}`);
  }
  // 构建产物的批量清理是正当动作(内网实锤:playbook 教删陈旧 CMake
  // 生成目录,门禁不许一刀切拦死)。
  for (const command of [
    "rm -rf build",
    "rm -rf target/build",
    "rm -rf website/node_modules",
    "rm -rf target/build/CMakeFiles target/build/CMakeCache.txt",
    "rm -rf cmake-build-debug",
  ]) {
    assert.equal(prePushSecurityDecision("Bash", command), undefined, command);
  }
  assert.equal(prePushSecurityDecision("Read", ".claude/skills/java/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision("Read", ".codex/skills/test/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision("Read", ".npmrc"), undefined);
  assert.equal(prePushSecurityDecision("Write", ".mvn/project-settings.xml"), undefined);
  assert.equal(prePushSecurityDecision(
    "Read", ".mae-flow-work/repository-skills/java/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision(
    "Read", ".mae-flow-work/host-skills/snapshot/SKILL.md"), undefined);
  assert.equal(prePushSecurityDecision(
    "Write", ".mae-flow-work/host-skills/snapshot/SKILL.md")?.action, "deny");
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

// —— 以下三条来自 2026-08-21 首次整链试跑的实锤(.pilot/e2e-container-2)——
// 模型真跑了 mvn、真绿了(Tests run: 18, Failures: 0)、还自己修好一个真编译
// 错误,却被判"没有真实成功执行"。原因是证据比对用的是**整条 bash 命令原文
// 精确相等**,而模型上报的是 `mvn test`、实发的是
// `cd /很长的路径 && mvn test; echo TEST_EXIT=$?`——这道闸当时基本过不去。

test("prepush evidence: 实发命令带 cd 前缀和退出码后缀时,上报的构建命令仍算数", () => {
  // 这一串是试跑现场命令形状的等价复刻,不是臆造的夹具。
  const prefix = "cd /srv/tasks/task-1/origin && ";
  const events = [
    event(1, "tool_requested", {
      call_id: "compile", name: "Bash",
      input: { command: `${prefix}${PASSED.compile.command} 2>&1 | tail -20; echo EXIT=$?` },
    }),
    event(2, "tool_finished", {
      call_id: "compile", name: "Bash", is_error: false, result: "BUILD SUCCESS",
    }),
    event(3, "tool_requested", {
      call_id: "ut", name: "Bash",
      input: { command: `${prefix}${PASSED.unit_test.command} > /tmp/mvn.log 2>&1; echo TEST_EXIT=$?` },
    }),
    event(4, "tool_finished", {
      call_id: "ut", name: "Bash", is_error: false, result: "Tests run: 18",
    }),
  ];
  assert.equal(verifyPrePushEvidence(events, PASSED), "",
    "包裹在 cd/重定向/echo 里的真实执行必须被认成证据");
});

test("prepush evidence: 跑过但只在改动之前——措辞要和'压根没跑'分开", () => {
  const events = [
    event(1, "tool_requested", {
      call_id: "compile", name: "Bash",
      input: { command: `cd /x && ${PASSED.compile.command}` },
    }),
    event(2, "tool_finished", { call_id: "compile", name: "Bash", is_error: false }),
    event(3, "tool_requested", {
      call_id: "ut", name: "Bash", input: { command: `cd /x && ${PASSED.unit_test.command}` },
    }),
    event(4, "tool_finished", { call_id: "ut", name: "Bash", is_error: false }),
    // 两条都跑完之后才提交:证据全部作废,但这不是"没跑过"。
    event(5, "tool_requested", {
      call_id: "commit", name: "Bash",
      input: { command: 'git -c user.name=a commit -m "fix"' },
    }),
    event(6, "tool_finished", { call_id: "commit", name: "Bash", is_error: false }),
  ];
  const error = verifyPrePushEvidence(events, PASSED);
  assert.match(error, /只在最后一次代码修改\/提交之前成功过/);
  assert.doesNotMatch(error, /没有在最后一次代码修改后真实成功执行/,
    "跑过但太早,不能用和'压根没跑'一样的措辞——会被当成作弊");
});

test("prepush evidence: 放松成包含匹配后,没跑过的命令照样拦得住", () => {
  const events = [
    event(1, "tool_requested", {
      call_id: "ls", name: "Bash", input: { command: "cd /x && ls -la" },
    }),
    event(2, "tool_finished", { call_id: "ls", name: "Bash", is_error: false }),
  ];
  const error = verifyPrePushEvidence(events, PASSED);
  assert.match(error, /没有在最后一次代码修改后真实成功执行/);
  assert.match(error, /mvn -q -DskipTests package/);
  assert.match(error, /mvn -q test/);
  // 空命令不能因为"空串是任何串的子串"而白捡一张通行证。
  assert.match(
    verifyPrePushEvidence(events, {
      ...PASSED, compile: { command: "   ", status: "passed" },
    }),
    /没有在最后一次代码修改后真实成功执行/);
});
