/**
 * Build-Fix 证据校验的决策表(纯函数)。
 *
 * 为什么要有:这道闸从 2026-08-21 到 09-04 改了六次(精确相等→包含匹配→
 * 顺序约束降级为事实→平台笔记不算修改→重定向/引号/说明不判死→命令对不
 * 上但真跑过重型构建放行),每次都是内网实锤逼出来的,每次只加一个用例。
 * 没有一处把"现在到底认什么、拒什么"摆成一张表——下次再松或再紧,谁也说
 * 不清有没有把上一条实锤又改回去。本表就是那张表:一行一个实锤场景,改闸
 * 先改表。
 *
 * 闸的定位(prepushAgent.ts 注释原话):push 前的快速反馈与流量闸门,只防
 * "凭空报 PASS",不冒充最终质量裁判——真裁判是绑 SHA 的流水线。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticEvent } from "../src/semanticEvents.ts";
import {
  prePushEvidenceFacts,
  verifyPrePushEvidence,
  type PrePushAgentReport,
} from "../src/prepushAgent.ts";

let seq = 0;
function bash(command: string, ok = true, session = "prepush-1"): SemanticEvent[] {
  const id = `call-${++seq}`;
  const base = { taskId: "T", sessionId: session, ts: "2026-09-06T00:00:00.000Z" };
  return [
    { ...base, eventId: ++seq, kind: "tool_requested", payload: { call_id: id, name: "Bash", input: { command } } },
    { ...base, eventId: ++seq, kind: "tool_finished", payload: { call_id: id, name: "Bash", input: { command }, is_error: !ok, result: ok ? "ok" : "boom" } },
  ];
}
function edit(path: string): SemanticEvent[] {
  return [{ taskId: "T", sessionId: "prepush-1", ts: "2026-09-06T00:00:00.000Z", eventId: ++seq, kind: "tool_requested",
    payload: { call_id: `call-${++seq}`, name: "Edit", input: { path } } }];
}
const report = (compile: string, unit_test: string, status: PrePushAgentReport["status"] = "passed"): PrePushAgentReport => ({
  status, compile: { command: compile, status: "passed" }, unit_test: { command: unit_test, status: "passed" }, summary: "ok",
});
const PASS = report("mvn -q -DskipTests package", "mvn -q test");

interface Row {
  case: string;
  /** 现状里疑似漏洞的行:钉住是为了改的时候有人知道,不是认可。 */
  hole?: boolean;
  events: SemanticEvent[];
  report: PrePushAgentReport;
  /** "" 表示放行;否则是拒绝理由里必须出现的片段。 */
  verdict: "" | RegExp;
  facts?: { changed_after_run: string[]; command_mismatch: string[] };
}

const ROWS: Row[] = [
  { case: "两条命令原样成功跑过:放行,无事实要提醒",
    events: [...bash(PASS.compile.command), ...bash(PASS.unit_test.command)], report: PASS, verdict: "",
    facts: { changed_after_run: [], command_mismatch: [] } },
  { case: "报告没说通过:拒",
    events: [...bash(PASS.compile.command), ...bash(PASS.unit_test.command)],
    report: report(PASS.compile.command, PASS.unit_test.command, "code_failure"), verdict: /没有报告通过/ },
  // ↓ 下面两行是 2026-09-04 放宽后的现状,不是设计意图:只要会话里成功跑过
  // 任何一条重型构建命令(编译本身就是),上报的 UT 没跑过/跑失败也放行。
  // "只防凭空报 PASS"防的是整份报告造假,防不住"编译真过、UT 编的"。
  // 要不要收紧待用户拍板;收紧时改这两行的 verdict 即可,表就是契约。
  { case: "现状·只有编译过、UT 没跑:放行(编译已算重型构建)", hole: true,
    events: [...bash(PASS.compile.command)], report: PASS, verdict: "" },
  { case: "现状·UT 跑了但失败:放行(同上)", hole: true,
    events: [...bash(PASS.compile.command), ...bash(PASS.unit_test.command, false)], report: PASS, verdict: "" },
  { case: "实发带 cd 前缀与退出码后缀(2026-08-21 首次整链实锤):算数",
    events: [...bash(`cd /w/repo && ${PASS.compile.command}; echo TEST_EXIT=$?`), ...bash(`cd /w/repo && ${PASS.unit_test.command}; echo TEST_EXIT=$?`)],
    report: PASS, verdict: "" },
  { case: "实发带重定向与引号、上报带中文说明(内网 task-38 实锤):算数",
    events: [...bash('LD_LIBRARY_PATH="$X" mvn -q -DskipTests package > /dev/null 2>&1'), ...bash("mvn -q test >> build.log 2>&1")],
    report: report("LD_LIBRARY_PATH=$X mvn -q -DskipTests package", "mvn -q test（并同口径跑 A 与 B）"), verdict: "" },
  { case: "上报把两条合成一条 && 拼接:每个干活片段都跑过就算数",
    events: [...bash("mvn -q -DskipTests package"), ...bash("mvn -q test")],
    report: report("cd /w && mvn -q -DskipTests package && mvn -q test", "mvn -q test"), verdict: "" },
  { case: "上报的命令没跑过,但本会话成功跑过重型构建(2026-09-04 拍板):放行,不一致写进事实",
    events: [...bash("mvn -q -pl notify-service -am test")],
    report: PASS, verdict: "",
    facts: { changed_after_run: [], command_mismatch: [PASS.compile.command, PASS.unit_test.command] } },
  { case: "上报的命令没跑过,会话里也没有任何重型构建:凭空报 PASS,拒",
    events: [...bash("ls -la"), ...bash("cat pom.xml")], report: PASS, verdict: /没有任何.*重型构建命令成功跑过/ },
  { case: "编译成功后又改了会进交付的文件:不判失效,列进事实给人看(2026-09-03 拍板)",
    events: [...bash(PASS.compile.command), ...edit("src/main/App.java"), ...bash(PASS.unit_test.command), ...edit("src/test/AppTest.java")],
    report: PASS, verdict: "",
    facts: { changed_after_run: ["src/main/App.java", "src/test/AppTest.java"], command_mismatch: [] } },
  { case: "成功之后只改了平台笔记与状态文件:不算修改(2026-09-03)",
    events: [...bash(PASS.compile.command), ...bash(PASS.unit_test.command), ...edit("/w/repo/.mae-flow-work/build-notes.md"), ...edit(".mae-flow.json")],
    report: PASS, verdict: "", facts: { changed_after_run: [], command_mismatch: [] } },
  // 事件账按 sessionId:call_id 配对,但不限定是哪个会话:编码主会话跑过的
  // 命令也算。给的是整份 events,调用方负责只喂 Build-Fix 会话的事件。
  { case: "现状·配对按会话隔离,但不限定会话:别的会话的成功也算", hole: true,
    events: [...bash(PASS.compile.command, true, "coding-main"), ...bash(PASS.unit_test.command, true, "coding-main")],
    report: PASS, verdict: "" },
];

for (const row of ROWS) {
  test(`Build-Fix 证据表:${row.case}`, () => {
    const verdict = verifyPrePushEvidence(row.events, row.report);
    if (row.verdict === "") assert.equal(verdict, "", `应放行,实际拒绝: ${verdict}`);
    else assert.match(verdict, row.verdict);
    if (row.facts) assert.deepEqual(prePushEvidenceFacts(row.events, row.report), row.facts);
  });
}

test("Build-Fix 证据表:放行至少六种、拒绝至少两种形状,表不能被裁", () => {
  assert.ok(ROWS.filter((row) => row.verdict === "" && !row.hole).length >= 6);
  assert.ok(ROWS.filter((row) => row.verdict !== "").length >= 2);
});

test("Build-Fix 证据表:已知漏洞清单——收紧闸门时来这里改,别再各修各的", () => {
  assert.deepEqual(ROWS.filter((row) => row.hole).map((row) => row.case), [
    "现状·只有编译过、UT 没跑:放行(编译已算重型构建)",
    "现状·UT 跑了但失败:放行(同上)",
    "现状·配对按会话隔离,但不限定会话:别的会话的成功也算",
  ]);
});
