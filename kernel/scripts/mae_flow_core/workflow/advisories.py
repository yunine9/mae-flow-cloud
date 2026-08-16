"""Non-blocking Gate signals routed to a channel the Agent actually reads.

A Hook that allows the action exits 0, and on exit 0 the host shows the Hook's
stdout/stderr to the human in transcript mode only — it never reaches the
model. Every "suggestion, not a block" the Gate printed that way was therefore
invisible to the Agent it was written for: pre-commit lightcheck findings and
compile side-effect attribution both silently went nowhere.

Advisories are recorded here instead, and ``current``/``done`` render the ones
belonging to the current round. Staleness needs no cleanup pass: an advisory is
addressed to one round of one step, so filtering by that step's entry time is
enough.
"""

from mae_flow_core.state_store import safe_read_json, update_json


_LIMIT = 40


def advisory_path(state_path):
    return str(state_path) + ".advisories"


def record_advisory(state_path, step, kind, message, at):
    """Record one non-blocking signal for the current step."""
    entry = {
        "step": str(step or ""),
        "kind": str(kind or ""),
        "message": str(message or "").strip(),
        "at": str(at or ""),
    }
    if not entry["message"]:
        return None

    def mutate(data):
        notices = data.setdefault("advisories", [])
        if not isinstance(notices, list):
            notices = []
            data["advisories"] = notices
        duplicate = any(
            isinstance(item, dict)
            and item.get("step") == entry["step"]
            and item.get("kind") == entry["kind"]
            and item.get("message") == entry["message"]
            for item in notices
        )
        if not duplicate:
            notices.append(entry)
            if len(notices) > _LIMIT:
                del notices[:-_LIMIT]
        return data

    update_json(
        advisory_path(state_path), mutate,
        default={"advisories": []}, recover_corrupt=True)
    return entry


def pending_advisories(state_path, step, since=""):
    """Advisories raised for this step during the current round."""
    data, error = safe_read_json(advisory_path(state_path))
    if error or not isinstance(data, dict):
        return ()
    notices = data.get("advisories", [])
    if not isinstance(notices, list):
        return ()
    return tuple(
        dict(item) for item in notices
        if isinstance(item, dict)
        and item.get("step") == str(step or "")
        and str(item.get("at", "")) >= str(since or "")
    )


def render_advisories(notices):
    """One compact block; empty when there is nothing to say."""
    if not notices:
        return ""
    lines = [
        "[mae-flow] ⚠ 本步待确认的非阻断提示(%d 条,门禁已放行,由你判断是否处理):"
        % len(notices)
    ]
    for item in notices:
        for index, line in enumerate(item["message"].splitlines()):
            if line.strip():
                lines.append(("  - " if index == 0 else "    ") + line.strip())
    return "\n".join(lines) + "\n"
