"""Small presentation and Git helpers for Cloud delivery commands."""
import re

from .wiring import api


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
    loop = (state or {}).get("delivery_loop") or {}
    active_id = str(loop.get("active_batch_id") or "")
    batch = next((item for item in loop.get("batches", [])
                  if isinstance(item, dict)
                  and item.get("batch_id") == active_id), None)
    if not batch:
        return ""
    lines = ["──── 持续检视第 %s 轮（%s） ────" % (
        batch.get("round", "?"), batch.get("status", "open"))]
    for item in batch.get("items", []):
        lines.append("- [%s] %s：%s%s" % (
            item.get("source", "反馈"), item.get("id", "?"),
            item.get("summary", ""),
            ("（材料：%s）" % item.get("material"))
            if item.get("material") else ""))
    return "\n".join(lines)
