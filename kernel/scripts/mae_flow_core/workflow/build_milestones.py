"""Append-only, observational milestones for one build step.

Milestones deliberately live outside workflow evidence. They let a host show
which confirmed implementation task is being worked on without turning every
implementation block into a state-machine step or an approval card.
"""

from dataclasses import dataclass
import hashlib
import json
import re


SCHEMA = "mae-flow-build-milestones/1"
EVENTS = frozenset(("started", "completed", "blocked"))
_CHECKBOX = re.compile(
    r"^\s*-\s*\[[ xX]\]\s*(?P<id>\d+(?:\.\d+)*)"
    r"(?:[.)、:]\s*|\s+)(?P<title>.+?)\s*$")
_TASK = re.compile(r"任务\s*(?P<id>\d+(?:\.\d+)*)")


@dataclass(frozen=True)
class ImplementationTask:
    task_id: str
    title: str


def _task_sort_key(value):
    return tuple(int(part) for part in str(value).split("."))


def implementation_tasks(text):
    """Extract stable task ids without imposing a second document format."""
    found = {}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        checkbox = _CHECKBOX.match(line)
        if checkbox:
            found.setdefault(
                checkbox.group("id"), checkbox.group("title").strip())
            continue
        for match in _TASK.finditer(line):
            task_id = match.group("id")
            # The implementation template assigns file rows to "任务 N" and
            # does not require a second checkbox list. Keep that id canonical.
            found.setdefault(task_id, "任务 " + task_id)
    return tuple(
        ImplementationTask(task_id, title)
        for task_id, title in sorted(
            found.items(), key=lambda item: _task_sort_key(item[0]))
    )


def select_task(tasks, task_id):
    wanted = str(task_id or "").strip()
    return next((task for task in tasks if task.task_id == wanted), None)


def digest_payload(value):
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_event(
        *, event, task, step, state_revision, step_head,
        implementation_path, implementation_digest, worktree_snapshot,
        at, reason="", nonce=""):
    """Create a self-contained event; callers append it without rewriting it."""
    if event not in EVENTS:
        raise ValueError("未知 build milestone 事件: " + str(event))
    if not isinstance(task, ImplementationTask):
        raise TypeError("task 必须来自 implementation.md")
    snapshot = dict(worktree_snapshot or {})
    record = {
        "schema": SCHEMA,
        "event": event,
        "task_id": task.task_id,
        "task_title": task.title,
        "step": str(step or ""),
        "step_revision": int(state_revision or 0),
        "step_head": str(step_head or ""),
        "implementation_path": str(implementation_path or ""),
        "implementation_sha256": str(implementation_digest or ""),
        "changed_paths": sorted(str(path) for path in snapshot),
        "worktree_sha256": digest_payload(snapshot),
        "at": str(at or ""),
        "nonce": str(nonce or ""),
    }
    if reason:
        record["reason"] = str(reason)
    record["id"] = digest_payload(record)[:20]
    return record


def append_event(document, event):
    """Append exactly once; prior events are never updated or collapsed."""
    data = dict(document or {}) if isinstance(document, dict) else {}
    rows = data.get("events")
    rows = list(rows) if isinstance(rows, list) else []
    rows.append(dict(event))
    data.update({"schema": SCHEMA, "events": rows})
    return data
