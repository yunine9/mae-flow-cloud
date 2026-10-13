import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainSkillWork, type SkillWorkResult } from "../src/domainSkillWork.ts";

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

const reviewedStep = (id = "guide") => ({ ...step(id), expected_document_ids: [id], review: { instructions: "回读正文和来源，核对适用条件与遗漏" } });
const candidate = (id = "guide"): SkillWorkResult => ({ summary: "文稿已保存", document_ids: [id], data: { pass: "旧 Skill 自由数据" } });
function reviewedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "skill-review-")), file = join(dir, "work.json");
  const work = new DomainSkillWork(file, "skill"); work.schedule([reviewedStep()]);
  return { dir, file, work, signal: new AbortController().signal };
}

test("预定文稿不完整时不能提交结果，也不启动评审", async () => {
  const f = reviewedFixture(); let reviews = 0;
  try {
    await assert.rejects(f.work.run("guide", async () => ({ summary: "只写了别的文稿", document_ids: ["other"] }), f.signal, {
      fingerprint: () => "version-1", review: async () => { reviews++; return { pass: true, feedback: "通过" }; },
    }), /全部预定文稿/);
    assert.equal(reviews, 0); assert.equal(f.work.state.steps[0].attempts, 3);
    assert.equal(f.work.state.steps[0].status, "failed");
    assert.equal(f.work.state.steps[0].candidate, undefined);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("独立评审退回的具体意见交回写作会话，修改后重新评审才完成", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0, version = "initial";
  try {
    const result = await f.work.run("guide", async current => {
      writes++;
      if (writes === 2) {
        assert.equal(current.error, "缺少取消前必须核对结算状态的前提");
        assert.equal(current.candidate?.review?.pass, false);
      }
      version = `version-${writes}`;
      f.work.recordCandidate("guide", candidate(), version);
      assert.equal(JSON.parse(readFileSync(f.file, "utf8")).steps[0].candidate.summary, "文稿已保存");
      return candidate();
    }, f.signal, { fingerprint: () => version, review: async () => {
      reviews++; return reviews === 1 ? { pass: false, feedback: "缺少取消前必须核对结算状态的前提" } : { pass: true, feedback: "已回查来源，前提与例外一致" };
    } });
    assert.equal(writes, 2); assert.equal(reviews, 2); assert.equal(result.review?.pass, true);
    assert.deepEqual(result.data, { pass: "旧 Skill 自由数据" }, "不解释或覆盖旧 data.pass");
    assert.equal(f.work.state.steps[0].reviewed_fingerprint, "version-2");
    f.work.finish({ summary: "全部已评审", document_ids: ["guide"] }, () => version);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("提交工具已保存候选后结束回复失败，不重复写作，仍执行独立评审", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0;
  try {
    const result = await f.work.run("guide", async () => {
      writes++; f.work.recordCandidate("guide", candidate()); throw new Error("结束回复时连接中断");
    }, f.signal, { fingerprint: () => "version-1", review: async () => { reviews++; return { pass: true, feedback: "当前正文和来源一致" }; } });
    assert.equal(writes, 1); assert.equal(reviews, 1); assert.equal(result.review?.pass, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审中断后重启复用候选文稿，预算和成功结果都保留", async () => {
  const f = reviewedFixture(), controller = new AbortController(); let writes = 0, reviews = 0;
  try {
    await assert.rejects(f.work.run("guide", async () => { writes++; return candidate(); }, controller.signal, {
      fingerprint: () => "version-1", review: async () => { reviews++; controller.abort(); return { pass: true, feedback: "迟到评审" }; },
    }));
    assert.equal(f.work.state.steps[0].status, "failed"); assert.equal(f.work.state.steps[0].result, undefined);
    assert.equal(f.work.state.steps[0].candidate?.summary, "文稿已保存");
    const stored = JSON.parse(readFileSync(f.file, "utf8")); stored.steps[0].status = "running";
    writeFileSync(f.file, JSON.stringify(stored)); // 模拟进程结束前未能保存最终状态。
    let restored = new DomainSkillWork(f.file, "skill");
    assert.equal(restored.state.steps[0].review_attempts, 1);
    const callbacks = { fingerprint: () => "version-1", review: async () => { reviews++; return { pass: true, feedback: "恢复后重新回读通过" }; } };
    await restored.run("guide", async () => { writes++; throw new Error("不能重写已经保存的候选"); }, f.signal, callbacks);
    assert.equal(writes, 1); assert.equal(reviews, 2);
    restored = new DomainSkillWork(f.file, "skill");
    await restored.run("guide", async () => { throw new Error("不能重复写作"); }, f.signal, callbacks);
    assert.equal(reviews, 2, "相同正文的已通过评审直接复用");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("正文变化不能复用旧评审，完成前也必须核对实际正文版本", async () => {
  const f = reviewedFixture(); let version = "version-1", writes = 0, reviews = 0;
  const callbacks = { fingerprint: () => version, review: async () => { reviews++; return { pass: true, feedback: `已核对 ${version}` }; } };
  try {
    await f.work.run("guide", async () => { writes++; return candidate(); }, f.signal, callbacks);
    version = "version-2";
    assert.throws(() => f.work.finish({ summary: "宣称完成", document_ids: ["guide"] }, callbacks.fingerprint), /文稿已变化/);
    const result = await f.work.run("guide", async () => { writes++; throw new Error("当前正文只需重评，不应覆盖"); }, f.signal, callbacks);
    assert.equal(writes, 1); assert.equal(reviews, 2); assert.equal(result.review?.feedback, "已核对 version-2");
    f.work.finish({ summary: "当前正文通过", document_ids: ["guide"] }, callbacks.fingerprint);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审期间正文变化时旧通过结论无效，只重评当前正文", async () => {
  const f = reviewedFixture(); let version = "version-1", reviews = 0, writes = 0;
  try {
    const result = await f.work.run("guide", async () => { writes++; return candidate(); }, f.signal, {
      fingerprint: () => version, review: async current => {
        reviews++;
        if (reviews === 1) version = "version-2";
        else assert.match(current.error ?? "", /评审期间文稿已变化/);
        return { pass: true, feedback: `核对第 ${reviews} 次读取的正文` };
      },
    });
    assert.equal(writes, 1); assert.equal(reviews, 2); assert.equal(result.review?.feedback, "核对第 2 次读取的正文");
    assert.equal(f.work.state.steps[0].reviewed_fingerprint, "version-2");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("已通过文稿多次正常更新时每版可重评，历史失败预算不限制后续新版本", async () => {
  const f = reviewedFixture(); let version = "version-0", writes = 0, reviews = 0;
  const callbacks = { fingerprint: () => version, review: async () => { reviews++; return { pass: true, feedback: `已回读 ${version}` }; } };
  try {
    let work = f.work;
    for (let i = 0; i < 6; i++) {
      version = `version-${i}`;
      const result = await work.run("guide", async () => { writes++; return candidate(); }, f.signal, callbacks);
      assert.equal(result.review?.feedback, `已回读 version-${i}`);
      assert.equal(work.state.steps[0].review_attempts, i + 1);
      work = new DomainSkillWork(f.file, "skill");
    }
    assert.equal(writes, 1, "正文已经由其他步骤更新，只重新核对，不覆盖新版本");
    assert.equal(reviews, 6);
    assert.equal(work.state.steps[0].review_budget_start, 5);
    work.finish({ summary: "全部当前版本已通过", document_ids: ["guide"] }, callbacks.fingerprint);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审连续驳回最多三轮，重启不补预算，人工明确接续才补充有限尝试", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0;
  const execute = async () => { writes++; return candidate(); };
  const callbacks = { fingerprint: () => `version-${writes}`, review: async () => { reviews++; return { pass: false, feedback: "仍缺关键例外的来源依据" }; } };
  try {
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(reviews, 3); assert.equal(f.work.state.steps[0].result, undefined);
    let restored = new DomainSkillWork(f.file, "skill");
    await assert.rejects(restored.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(reviews, 3);
    restored = new DomainSkillWork(f.file, "skill", 1);
    const result = await restored.run("guide", execute, f.signal, { ...callbacks, review: async current => {
      reviews++; assert.match(current.error ?? "", /仍缺关键例外/); return { pass: true, feedback: "已补充并回读例外来源" };
    } });
    assert.equal(writes, 4); assert.equal(reviews, 4); assert.equal(result.review?.pass, true);
    assert.equal(restored.state.steps[0].attempts, 4, "历史尝试次数保留");
    assert.equal(restored.state.steps[0].budget_start, 3);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审请求失败有持久上限，恢复后仅重试已保存候选的评审", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0;
  const execute = async () => { writes++; return candidate(); };
  const callbacks = { fingerprint: () => "version-1", review: async () => { reviews++; throw new Error("模型请求连接中断"); } };
  try {
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /模型请求连接中断/);
    assert.equal(writes, 1); assert.equal(reviews, 3);
    let restored = new DomainSkillWork(f.file, "skill");
    await assert.rejects(restored.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    restored = new DomainSkillWork(f.file, "skill", 1);
    await restored.run("guide", execute, f.signal, { ...callbacks, review: async () => { reviews++; return { pass: true, feedback: "连接恢复，回读当前正文通过" }; } });
    assert.equal(writes, 1); assert.equal(reviews, 4);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("取消后提交工具拒绝迟到候选，写作者不能伪造独立评审", async () => {
  const f = reviewedFixture(), controller = new AbortController();
  try {
    await assert.rejects(f.work.run("guide", async () => {
      controller.abort();
      assert.throws(() => f.work.recordCandidate("guide", candidate()));
      return candidate();
    }, controller.signal, { fingerprint: () => "version-1", review: async () => { throw new Error("已取消不应评审"); } }));
    assert.equal(f.work.state.steps[0].candidate, undefined);
    const resumed = new DomainSkillWork(f.file, "skill", 1); let reviewed = false;
    const result = await resumed.run("guide", async () => ({ ...candidate(), review: { pass: true, feedback: "作者自报通过" } }), f.signal, {
      fingerprint: () => "version-1", review: async (_step, value) => {
        assert.equal(value.review, undefined); reviewed = true; return { pass: true, feedback: "独立回读通过" };
      },
    });
    assert.equal(reviewed, true); assert.equal(result.review?.feedback, "独立回读通过");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("完整文稿计划独立保存，引用实际规划正文，拒绝重复、越界和未说明的排除", () => {
  const f = reviewedFixture();
  try {
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan" }), /先保存完整规划正文/);
    f.work.saveDocument({ id: "plan", title: "完整文稿规划", content: "# 规划\n\n规则、例外和跨仓说明分别形成三份文稿。" });
    f.work.setPlan({ document_ids: ["guide", "exceptions", "cross-repo"], work_document_id: "plan" });
    assert.deepEqual(f.work.state.plan?.document_ids, ["guide", "exceptions", "cross-repo"]);
    assert.equal(f.work.state.steps.length, 1, "完整计划不会自动调度遗漏的文稿");
    const previous = readFileSync(f.file, "utf8");
    for (const ids of [["guide", "guide"], ["../guide"], ["space name"], Array.from({ length: 5001 }, (_, i) => `doc-${i}`)]) {
      assert.throws(() => f.work.setPlan({ document_ids: ids, work_document_id: "plan" }), /有效且不重复|最多 5000/);
    }
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan" }), /移除已规划文稿必须.*exceptions、cross-repo/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide", "exceptions", "cross-repo"], work_document_id: "plan", exclusions: [{ document_id: "guide", reason: "重复内容" }] }), /不能同时/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [{ document_id: "exceptions", reason: " " }] }), /逐项说明具体原因/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [{ document_id: "exceptions", reason: "重复" }, { document_id: "exceptions", reason: "重复" }] }), /不重复/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: null } as any), /排除项需要/);
    assert.equal(readFileSync(f.file, "utf8"), previous, "无效更新不改变已保存计划");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("计划缩减必须逐项解释，排除说明跨更新和重启保留，重新加入不放弃已有步骤", () => {
  const f = reviewedFixture();
  try {
    f.work.saveDocument({ id: "plan", title: "完整规划", content: "# 完整规划\n规则、例外与仓库索引。" });
    f.work.setPlan({ document_ids: ["guide", "exceptions", "index"], work_document_id: "plan" });
    f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [
      { document_id: "exceptions", reason: "例外已有独立维护文档，本次范围只引用其入口" },
      { document_id: "index", reason: "仓库索引本次不变，继续沿用既有索引" },
    ] });
    f.work.setPlan({ document_ids: ["guide", "cross-repo"], work_document_id: "plan" });
    let restored = new DomainSkillWork(f.file, "skill");
    assert.equal(restored.state.plan?.exclusions?.length, 2);
    assert.match(restored.state.plan?.exclusions?.[0].reason ?? "", /例外已有独立维护文档/);
    assert.equal(restored.state.steps[0].status, "pending", "更新计划不会自动执行或放弃任何步骤");
    assert.equal(restored.state.documents?.[0].content, "# 完整规划\n规则、例外与仓库索引。", "更新计划不会改写规划正文");
    restored.setPlan({ document_ids: ["guide", "cross-repo", "exceptions"], work_document_id: "plan" });
    restored = new DomainSkillWork(f.file, "skill");
    assert.deepEqual(restored.state.plan?.exclusions?.map(item => item.document_id), ["index"]);
    assert.deepEqual(restored.state.plan?.document_ids, ["guide", "cross-repo", "exceptions"]);
    assert.throws(() => restored.setPlan({ document_ids: ["guide", "cross-repo"], work_document_id: "plan" }), /exceptions/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("完整计划扫描排除说明中的秘密，拒绝后保留原计划", () => {
  const f = reviewedFixture();
  try {
    f.work.saveDocument({ id: "plan", title: "规划", content: "# 规划\n规则与例外。" });
    f.work.setPlan({ document_ids: ["guide", "exceptions"], work_document_id: "plan" });
    const previous = readFileSync(f.file, "utf8");
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [{ document_id: "exceptions", reason: "api_key: sk_live_fixture1234" }] }), /密钥/);
    assert.equal(readFileSync(f.file, "utf8"), previous);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("空的评审对象和评审说明返回明确错误，不抛 TypeError", () => {
  const f = reviewedFixture();
  try {
    for (const review of [null, { instructions: null }, { instructions: " " }]) {
      assert.throws(() => f.work.schedule([{ ...step("invalid"), review } as any]), error => {
        assert.ok(error instanceof Error); assert.equal(error instanceof TypeError, false); assert.match(error.message, /独立评审需要具体/); return true;
      });
    }
    assert.equal(f.work.state.steps.length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("1200份文稿完整计划与2400个分批步骤跨重启保留，已通过结果仍可复用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-plan-scale-")), file = join(dir, "work.json"), signal = new AbortController().signal;
  const ids = Array.from({ length: 1200 }, (_, i) => `doc-${String(i).padStart(4, "0")}`);
  try {
    let work = new DomainSkillWork(file, "skill");
    work.saveDocument({ id: "full-plan", title: "多仓完整文稿规划", content: "# 完整文稿清单\n\n" + ids.map((id, i) => `- ${id}：仓库 ${i % 4 + 1} 的第 ${i + 1} 项业务主题`).join("\n") });
    work.setPlan({ document_ids: ids, work_document_id: "full-plan" });
    const steps = ids.flatMap(id => [{ ...step(`source-${id}`), title: `核对 ${id} 的来源` },
      { ...reviewedStep(id), id: `write-${id}`, depends_on: [`source-${id}`] }]);
    for (let offset = 0; offset < steps.length; offset += 100) {
      work.schedule(steps.slice(offset, offset + 100));
      if (offset === 500) {
        work = new DomainSkillWork(file, "skill");
        assert.equal(work.state.plan?.document_ids.length, 1200, "分批登记步骤不会缩减完整必交清单");
        assert.equal(work.state.steps.length, 600);
      }
    }
    let calls = 0;
    await work.run(`source-${ids[0]}`, async () => { calls++; return { summary: "来源已核对", document_ids: [] }; }, signal);
    const callbacks = { fingerprint: () => "version-1", review: async () => { calls++; return { pass: true, feedback: "当前文稿与来源一致" }; } };
    await work.run(`write-${ids[0]}`, async () => { calls++; return candidate(ids[0]); }, signal, callbacks);
    work = new DomainSkillWork(file, "skill");
    assert.deepEqual(work.state.plan?.document_ids, ids);
    assert.equal(work.state.plan?.work_document_id, "full-plan");
    assert.equal(work.state.steps.length, 2400); assert.equal(new Set(work.state.steps.map(item => item.id)).size, 2400);
    assert.deepEqual(work.state.steps.at(-1)?.depends_on, [`source-${ids.at(-1)}`]);
    assert.equal(work.state.steps.filter(item => item.status === "pending").length, 2398);
    await work.run(`write-${ids[0]}`, async () => { calls++; throw new Error("不能重复成功工作"); }, signal, callbacks);
    assert.equal(calls, 3, "重启复用已通过工作，未运行其余2398项");
    assert.match(work.state.documents?.[0].content ?? "", /doc-1199/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
