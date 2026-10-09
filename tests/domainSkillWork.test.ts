import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainSkillWork } from "../src/domainSkillWork.ts";

const step = (id: string, depends_on: string[] = []) => ({ id, title: id, instructions: "任意 Skill 的工作说明", depends_on, readonly: false });
test("通用工作记录只执行 Skill 提供的步骤，拒绝环路，断点复用结果与显式暂停", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-work-")), file = join(dir, "state.json"), signal = new AbortController().signal;
  try {
    let work = new DomainSkillWork(file, "skill-a");
    assert.equal(work.state.steps.length, 0);
    assert.throws(() => work.schedule([step("a", ["b"]), step("b", ["a"])]), /循环/);
    assert.equal(work.state.steps.length, 0);
    assert.throws(() => work.schedule([step("a", ["absent"])]), /不存在/);
    work.schedule([step("a"), step("b", ["a"])]);
    await assert.rejects(work.run("b", async () => ({ summary: "bad", document_ids: [] }), signal), /依赖/);
    let calls = 0; const execute = async () => { calls++; return { summary: "结果", document_ids: [], data: { custom: [1] } }; };
    await work.run("a", execute, signal);
    assert.throws(() => work.finish({ summary: "伪报完成", document_ids: [] }), /未完成/);
    work.finish({ status: "paused", summary: "Skill 请求用户核对", document_ids: [] });
    work = new DomainSkillWork(file, "skill-a"); assert.equal(work.state.result?.status, "paused");
    work = new DomainSkillWork(file, "skill-a", 1); assert.equal(work.state.result, undefined);
    await work.run("a", execute, signal); assert.equal(calls, 1, "重启不重复执行已完成工作");
    await work.run("b", execute, signal); assert.equal(calls, 2);
    work.finish({ status: "complete", summary: "结束", document_ids: [] });
    assert.deepEqual(work.state.steps.map(s => s.id), ["a", "b"], "平台没有增加业务阶段或评审");
    assert.throws(() => work.schedule([{ ...step("a"), instructions: "覆盖历史" }]), /不能改写/);
    // A crashed running step can be retried without changing its dependencies or result history.
    const state = JSON.parse(readFileSync(file, "utf8")); state.steps.push({ ...step("c"), status: "running", attempts: 1 }); delete state.result;
    writeFileSync(file, JSON.stringify(state)); work = new DomainSkillWork(file, "skill-a", 1);
    assert.equal(work.state.steps.at(-1)?.status, "failed");
    await work.run("c", execute, signal); assert.equal(work.state.steps.at(-1)?.attempts, 2);
    work.schedule([step("unused")]); work.discard("unused", "Skill 确认不适用");
    work.finish({ summary: "已说明未执行项", document_ids: [] });
    work = new DomainSkillWork(file, "skill-a", 2);
    assert.equal(work.state.result, undefined, "已完成任务的显式接续也要执行 Skill，不能直接复用结束结论");
    assert.equal(work.state.previous_results?.at(-1)?.summary, "已说明未执行项");
    assert.equal(work.state.steps[0].status, "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("取消不接受迟到结果，失败记录和草稿编号保留用于接续", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-cancel-"));
  try {
    const work = new DomainSkillWork(join(dir, "state.json"), "skill"), controller = new AbortController();
    work.schedule([step("slow")]);
    await assert.rejects(work.run("slow", async () => { controller.abort(); return { summary: "迟到", document_ids: [] }; }, controller.signal));
    assert.equal(work.state.steps[0].status, "failed"); assert.equal(work.state.steps[0].result, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
