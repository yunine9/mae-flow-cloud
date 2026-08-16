"""Deterministic adaptive batching for one logical UT session."""

from dataclasses import dataclass


@dataclass(frozen=True)
class UtBatchPlan:
    batches: tuple
    requires_batch_commit: bool = False


@dataclass(frozen=True)
class UtSessionAdvance:
    record: dict
    task_batches: tuple
    complete: bool = False


def plan_ut_batches(targets):
    ordered = tuple(dict.fromkeys(
        str(target) for target in targets if str(target).strip()))
    if not ordered:
        return UtBatchPlan(())
    if len(ordered) <= 5:
        return UtBatchPlan((ordered,))
    count = (len(ordered) + 4) // 5
    base, extra = divmod(len(ordered), count)
    sizes = [base + (1 if index < extra else 0) for index in range(count)]
    batches = []
    offset = 0
    for size in sizes:
        batches.append(ordered[offset:offset + size])
        offset += size
    return UtBatchPlan(tuple(batches))


def accumulated_ut_paths(
        dirty_paths, *, same_step, prior_returned, owned_paths,
        review_authorized=False, is_test, is_build):
    """Split legal same-session test outputs from unrelated dirty files."""
    if not ((same_step and prior_returned) or review_authorized):
        return (), tuple(dirty_paths)
    owned = set(owned_paths or ())
    allowed, blocked = [], []
    for path in dirty_paths:
        target = (
            allowed if path in owned and (is_test(path) or is_build(path))
            else blocked)
        target.append(path)
    return tuple(allowed), tuple(blocked)


def advance_ut_session(existing, batches, prior_returned):
    """Advance exactly one generated batch, then one mandatory final run."""
    normalized = tuple(tuple(batch) for batch in batches)
    previous = existing if isinstance(existing, dict) else {}
    if tuple(tuple(row) for row in previous.get("batches", ())) != normalized:
        previous = {}
    completed = list(previous.get("completed_batches", ()))
    active = previous.get("active_batch")
    phase = previous.get("phase", "")
    if prior_returned and phase == "generate" and active is not None:
        if active not in completed:
            completed.append(active)
    if prior_returned and phase == "final":
        record = dict(previous)
        record["complete"] = True
        return UtSessionAdvance(record, (), True)
    pending = [index for index in range(len(normalized))
               if index not in completed]
    if pending:
        active, phase = pending[0], "generate"
        task_batches = (normalized[active],)
    else:
        active, phase, task_batches = None, "final", ()
    record = dict(previous)
    record.update({
        "batches": [list(batch) for batch in normalized],
        "completed_batches": completed,
        "active_batch": active,
        "phase": phase,
        "complete": False,
        "requires_batch_commit": False,
    })
    return UtSessionAdvance(record, task_batches, False)
