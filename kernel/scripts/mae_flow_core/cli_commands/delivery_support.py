"""Small presentation and Git helpers for Cloud delivery commands."""
import json
import re

from .wiring import api


def original_feedback_order(rows, previous):
    """Ignore display order on replay while preserving every field and ID."""
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        return rows
    order = {str(row.get("id", "")): index for index, row in enumerate(previous or ())}
    return sorted(rows, key=lambda row: order.get(str(row.get("id", "")).strip(), len(order)))


def unpushed_commits(verified_sha, local_head, die):
    if local_head == verified_sha:
        return []
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", str(verified_sha or "")):
        die("合入源 SHA 格式不合法")
    ancestor = api.sh(
        "git merge-base --is-ancestor %s HEAD >/dev/null 2>&1 && echo yes"
        % verified_sha)
    if str(ancestor or "").strip() != "yes":
        return [{
            "sha": local_head,
            "subject": "本地 HEAD 不在已合入提交之后，需人工核对",
        }]
    rows = api.sh("git log --format='%H%x09%s' --reverse " + verified_sha + "..HEAD")
    result = []
    for line in str(rows or "").splitlines():
        sha, separator, subject = line.partition("\t")
        if separator and re.fullmatch(r"[0-9a-fA-F]{40,64}", sha):
            result.append({"sha": sha, "subject": subject[:500]})
    return result


def render_delivery_feedback(state):
    from .feedback_control import deferred_feedback, scheduled_items

    loop = (state or {}).get("delivery_loop") or {}
    lines = []
    target = (loop.get("target") or {}).get("target")
    if target:
        lines.append("当前优先目标：%s。未暂缓的其他反馈仍保留。" % target)
    deferred = deferred_feedback(state)
    if deferred:
        lines.append("已由责任人暂缓自动修复：%s。保留原问题，不要求为这些条目补处理回执。"
                     % "、".join(deferred))
    active_id = str(loop.get("active_batch_id") or "")
    batch = next((item for item in loop.get("batches", [])
                  if isinstance(item, dict)
                  and item.get("batch_id") == active_id), None)
    if not batch:
        return "\n".join(lines)
    items = scheduled_items(state, batch)
    if not items:
        return "\n".join(lines)
    lines.append("──── 持续检视第 %s 轮（%s） ────" % (
        batch.get("round", "?"), batch.get("status", "open")))
    lines.append("反馈 ID 与正文分开列出；写回执时原样使用 id，不拼接摘要或状态：")
    lines.append(json.dumps([
        {key: item[key] for key in ("id", "source", "source_id", "summary", "material")
         if key in item}
        for item in items
    ], ensure_ascii=False, indent=2))
    return "\n".join(lines)
