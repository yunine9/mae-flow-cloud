import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeliveryOutbox,
  parseReviewReplies,
} from "../src/deliveryOutbox.ts";

test("检视回复解析支持同行正文，并点名缺失讨论", () => {
  const parsed = parseReviewReplies([
    "[d-1] 已补判空",
    "证据在 src/a.ts:10",
    "[not-this-batch] 不应切段",
    "[d-2]", "这里无需修改，原因是平台误报",
  ].join("\n"), ["d-1", "d-2", "d-3"]);
  assert.deepEqual(parsed.replies.map((item) => item.id), ["d-1", "d-2"]);
  assert.match(parsed.replies[0].body, /not-this-batch/,
    "非本批方括号文本只是正文，不应误切");
  assert.deepEqual(parsed.missing_ids, ["d-3"]);
});

test("outbox 部分成功可恢复：成功项不重投，失败项保留重试", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-outbox-")), "outbox.jsonl");
  const outbox = new DeliveryOutbox(path);
  const one = outbox.enqueueReviewReply({
    discussion_id: "d-1", body: "已修", repo: "repo", resolve: false,
    expected_sha: "abc",
  });
  const duplicate = outbox.enqueueReviewReply({
    discussion_id: "d-1", body: "已修", repo: "repo", resolve: false,
    expected_sha: "abc",
  });
  assert.equal(duplicate.id, one.id, "同一动作入队必须幂等");
  const two = outbox.enqueueReviewReply({
    discussion_id: "d-2", body: "无需修改", repo: "repo", resolve: false,
  });
  outbox.markAttempt(one.id);
  outbox.markDelivered(one.id);
  outbox.markAttempt(two.id);
  outbox.markFailed(two.id, "HTTP 503");

  const recovered = new DeliveryOutbox(path);
  assert.deepEqual(recovered.pendingReviewReplies().map((item) => item.id),
    [two.id]);
  assert.equal(recovered.list().find((item) => item.id === one.id)?.state,
    "delivered");
  assert.equal(recovered.list().find((item) => item.id === two.id)?.attempts, 1);
  assert.match(recovered.list().find((item) => item.id === two.id)?.last_error ?? "",
    /503/);

  appendFileSync(path, '{"op":"attempt"', "utf-8");
  assert.equal(new DeliveryOutbox(path).list().length, 2,
    "崩在半行只丢该行，不能炸掉整份 outbox");
});
