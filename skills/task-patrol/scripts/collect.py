#!/usr/bin/env python3
"""Read bounded task evidence. Can run via ssh python3 - DATA_DIR."""
import collections
import datetime as dt
import json
from pathlib import Path
import re
import sys

LIMIT = 2 * 1024 * 1024
TERMINAL = {"completed", "canceled", "failed"}


def scrub(value):
    text = str(value)
    text = re.sub(r'(?i)(authorization\s*[:=]\s*|bearer\s+)[^\s,;]+', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+', r'\1[REDACTED]', text)
    text = re.sub(r'(https?://)[^/@\s]+:[^/@\s]+@', r'\1[REDACTED]@', text)
    return text[:1200]


def read_json(path):
    if path.is_symlink() or path.stat().st_size > LIMIT:
        raise ValueError("symlink or oversized file")
    return json.loads(path.read_text())


def collect(root, maximum=30, offset=0):
    root = Path(root).resolve(strict=True)
    candidates, errors = [], []
    for directory in root.glob("task-*"):
        if not directory.is_dir() or directory.is_symlink():
            continue
        try:
            summary = read_json(directory / "task.json")["summary"]
            if not isinstance(summary, dict):
                raise ValueError("summary is not an object")
            candidates.append((directory, summary))
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append({"file": str(directory / "task.json"), "error": str(error)})
    # Include old unfinished tasks as well as recent tasks; describe sampling, not a full audit.
    recent = sorted(candidates, key=lambda x: str(x[1].get("updated_at", "")), reverse=True)
    old = sorted((x for x in candidates if x[1].get("status") not in TERMINAL),
                 key=lambda x: str(x[1].get("last_progress_at", x[1].get("updated_at", ""))))
    rotating = sorted(candidates, key=lambda x: x[0].name)
    offset = offset % len(rotating) if rotating else 0
    rotating = rotating[offset:] + rotating[:offset]
    priority = max(0, maximum // 6)
    selected = dict((str(p), (p, s)) for p, s in old[:priority] + recent[:priority] + rotating)
    selected = list(selected.values())[:maximum]
    tasks = []
    for directory, summary in selected:
        task = {"id": summary.get("id"), "directory": str(directory),
                "summary": {k: scrub(summary[k]) for k in
                            ("status", "created_at", "updated_at", "last_progress_at", "detail") if k in summary},
                "errors": []}
        delivery = summary.get("delivery") or {}
        if not isinstance(delivery, dict):
            task["errors"].append({"file": "task.json", "error": "delivery is not an object"})
            delivery = {}
        task["delivery"] = {k: scrub(delivery[k]) for k in
                            ("sha", "mr_id", "pipeline", "waiting_on", "stalled", "stall_class") if k in delivery}
        try:
            path = directory / "waiting.json"
            if path.exists():
                records = read_json(path).get("records", {})
                task["waiting"] = [{k: scrub(record[k]) for k in
                                    ("waiting_id", "step", "status", "decision", "created_at", "resolved_at") if k in record}
                                   for record in list(records.values())[-100:]]
                task["waiting_truncated"] = len(records) > 100
        except (OSError, ValueError, AttributeError, TypeError) as error:
            task["errors"].append({"file": "waiting.json", "error": str(error)})
        try:
            path = directory / "events.jsonl"
            if path.is_symlink():
                raise ValueError("symlink rejected")
            with path.open("rb") as stream:
                size = path.stat().st_size
                start = max(0, size - LIMIT)
                stream.seek(start)
                if start:
                    stream.readline()  # drop partial first line
                lines = stream.read(LIMIT).decode("utf-8", errors="replace").splitlines()
            events, bad = [], 0
            for line in lines:
                try:
                    event = json.loads(line)
                    payload = event.get("payload") or {}
                    if not isinstance(event.get("kind"), str):
                        raise ValueError("event kind is missing or invalid")
                    item = {k: event.get(k) for k in ("eventId", "ts", "kind", "sessionId")}
                    item["payload"] = {k: scrub(payload[k]) for k in
                                       ("call_id", "name", "reason", "is_error", "result", "text") if k in payload}
                    events.append(item)
                except (ValueError, AttributeError, TypeError):
                    bad += 1
            task["event_counts_in_tail"] = dict(collections.Counter(e["kind"] for e in events))
            task["events"] = events[-100:]
            task["events_truncated"] = bool(start or len(events) > 100)
            task["malformed_event_lines"] = bad
        except (OSError, ValueError) as error:
            task["errors"].append({"file": "events.jsonl", "error": str(error)})
        tasks.append(task)
    return {"schema": "task-patrol-evidence/1", "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "data_dir": str(root), "discovered": len(candidates), "selected": len(tasks),
            "sampling": "old unfinished and recent priorities, then rotating requirement tasks",
            "next_offset": (offset + max(1, maximum - 2 * priority)) % len(candidates) if candidates else 0,
            "errors": errors[:100], "error_count": len(errors), "tasks": tasks}


if __name__ == "__main__":
    print(json.dumps(collect(sys.argv[1], max(1, min(200, int(sys.argv[2]))) if len(sys.argv) > 2 else 30, int(sys.argv[3]) if len(sys.argv) > 3 else 0), ensure_ascii=False))
