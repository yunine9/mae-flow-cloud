"""Narrow Core-owned authorization for one Cloud pipeline repair commit.

The original delivery manifest remains the human-approved delivery scope.  A
pipeline RED can legitimately require an additional test or source file, but
asking for another human Diff approval would turn the lightweight repair loop
back into the heavyweight workflow.  This authorization is deliberately valid
only while HEAD is still the failed SHA; the first repair commit changes HEAD
and therefore consumes it without a mutable counter or fail-open cleanup.
"""

from mae_flow_core.foundation.source_paths import repository_path_identity
from mae_flow_core.guard.manifest import validate_delivery_document_boundary


def issue_repair_authorization(state, decision, *, head, at, dirty_paths=()):
    """Issue/clear a failed-SHA-bound repair window from a pipeline verdict."""
    if getattr(decision, "verdict", "") != "RED":
        state.pop("external_repair_authorization", None)
        return None
    authorization = {
        "schema": "mae-flow-external-repair/1",
        "status": "ready",
        "failed_sha": str(head or ""),
        "issued_at": str(at or ""),
        # Anything already dirty when RED was registered is not attributable
        # to the repair Agent and may not hitch a ride in its automatic commit.
        "baseline_dirty": list(dict.fromkeys(
            str(path) for path in dirty_paths if str(path))),
    }
    state["external_repair_authorization"] = authorization
    return authorization


def active_repair_authorization(state, head):
    authorization = (state or {}).get("external_repair_authorization") or {}
    external = (((state or {}).get("quality") or {}).get(
        "external_verification") or {})
    active = bool(
        (state or {}).get("current") == "external_verify"
        and authorization.get("schema") == "mae-flow-external-repair/1"
        and authorization.get("status") == "ready"
        and authorization.get("failed_sha") == head
        and external.get("verdict") == "RED"
        and external.get("sha") == head
    )
    return active, authorization


def _identity(path):
    return repository_path_identity(path, case_insensitive=True)


def eligible_repair_paths(state, head, dirty_paths, repository_root=None):
    """Return exact business paths attributable to the active RED repair."""
    active, authorization = active_repair_authorization(state, head)
    if not active:
        return ()
    excluded = {
        _identity(path) for path in (
            list((state or {}).get("initial_dirty") or ())
            + list(authorization.get("baseline_dirty") or ()))
        if isinstance(path, str)
    }
    eligible = []
    for path in dirty_paths:
        if not isinstance(path, str) or _identity(path) in excluded:
            continue
        try:
            validate_delivery_document_boundary((path,))
        except ValueError:
            continue
        eligible.append(path)
    return tuple(dict.fromkeys(eligible))
