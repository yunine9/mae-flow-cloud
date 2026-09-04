"""Reconcile Cloud's checked delivery paths with Core-owned projections."""

import hashlib
import json

from .shared import os
from .wiring import api
from .host_receipts import save_with_host_proof
from mae_flow_core.guard.manifest import (
    DeliveryManifest, validate_delivery_document_boundary)
from mae_flow_core.orchestration.domain_archive import input_digest
from mae_flow_core.orchestration.work_package import ensure_work_package


SELECTION_SCHEMA = "mae-flow-delivery-selection/1"


def _die(message):
    api.die("delivery: " + message, 2)


def _text(value, name, limit=4000, required=True):
    result = str(value or "").strip()
    if required and not result:
        _die("%s 不能为空" % name)
    if len(result) > limit:
        _die("%s 超过 %s 字符" % (name, limit))
    return result


def _selection_digest(value):
    selected = {
        "task_id": value.get("task_id"),
        "waiting_id": value.get("waiting_id"),
        "head": value.get("head"),
        "paths": value.get("paths"),
        "excluded_paths": value.get("excluded_paths"),
        "actor": value.get("actor"),
    }
    encoded = json.dumps(selected, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _path_ids(paths):
    return {
        str(path).replace("\\", "/").casefold()
        for path in paths
    }


def _domain_archive_unchanged(state, rejected_paths, payload):
    """Reset the formal archive projection after the user rejects its group."""
    archive = state.get("domain_archive") or {}
    applied = DeliveryManifest.from_paths(
        archive.get("applied_paths") or (),
        repository_root=os.getcwd()).files
    rejected_ids = _path_ids(rejected_paths)
    rejected = [path for path in applied if path.casefold() in rejected_ids]
    if not rejected:
        return ()
    dirty_ids = _path_ids(api._dirty_paths())
    remaining = [path for path in rejected if path.casefold() in dirty_ids]
    if remaining:
        _die("领域归档拒绝项尚未从工作区恢复，不能只改状态账: "
             + "、".join(remaining))
    ticket = _text(((state.get("config") or {}).get("单号")), "单号", 200)
    package = ensure_work_package(os.getcwd(), ticket)
    git_facts = "%s\n%s" % (
        api.sh("git -c core.quotepath=false diff --no-ext-diff --binary HEAD -- ."),
        api.sh("git -c core.quotepath=false status --porcelain --untracked-files=all"),
    )
    digest = input_digest(
        os.getcwd(),
        (package.spec, package.grill, package.story,
         package.implementation, package.decisions),
        git_facts, (),
    )
    state["domain_archive"] = {
        "status": "applied",
        "result": "unchanged",
        "domains": [],
        "input_sha256": digest,
        "applied_paths": [],
        "declined_paths": list(rejected),
        "authorization": {
            "mode": "cloud-delivery-selection",
            "waiting_id": payload.get("waiting_id"),
            "actor": payload.get("actor"),
        },
    }
    _remove_declined_from_repair_authorizations(state, rejected)
    return tuple(rejected)


def _remove_declined_from_repair_authorizations(state, rejected):
    rejected_ids = _path_ids(rejected)
    for name in ("delivery_repair_authorization",
                 "external_repair_authorization"):
        authorization = state.get(name)
        if not isinstance(authorization, dict):
            continue
        for key in ("baseline_dirty", "allowed_paths"):
            authorization[key] = [
                path for path in authorization.get(key) or ()
                if str(path).replace("\\", "/").casefold()
                not in rejected_ids
            ]


def _archive_rejections(state, paths, excluded):
    archive = state.get("domain_archive") or {}
    applied = list(archive.get("applied_paths") or ()) \
        if archive.get("status") == "applied" else []
    excluded_ids = _path_ids(excluded)
    rejected = [path for path in applied
                if str(path).replace("\\", "/").casefold() in excluded_ids]
    if rejected and _path_ids(paths) & _path_ids(applied):
        _die("领域归档是一个原子组；不能只勾选其中一部分")
    return rejected


def _write_manifest(state, payload, paths):
    old_manifest = state.get("delivery_manifest") or {}
    target = str(old_manifest.get("target_branch")
                 or (state.get("config") or {}).get("基线分支") or "").strip()
    if not target:
        _die("交付清单缺少目标分支")
    if not paths:
        _die("当前交付清单为空；请结束本次交付，而不是生成空 push")
    selected_ids = _path_ids(paths)
    state["delivery_manifest"] = {
        "files": sorted(paths, key=str.casefold),
        "commit_message": api.sh("git log -1 --format=%s"),
        "target_branch": target,
        "adopted_dirty": {
            path: decision
            for path, decision in (old_manifest.get("adopted_dirty") or {}).items()
            if str(path).replace("\\", "/").casefold() in selected_ids
        },
        "confirmed": True,
        "confirmation": {
            "mode": "cloud-delivery-selection",
            "waiting_id": payload.get("waiting_id"),
            "actor": payload.get("actor"),
        },
    }


def reconcile_selection(state, args, *, load_payload, verify_host_proof,
                        capability, head, history, state_schema):
    payload = load_payload(args.file, SELECTION_SCHEMA)
    proof_nonce = verify_host_proof(
        state, args, "selection-reconcile", payload)
    capability(state)
    selected_head = _text(payload.get("head"), "head", 80)
    current_head = head()
    if selected_head != current_head:
        _die("交付清单绑定的 HEAD %s 与当前 %s 不一致"
             % (selected_head[:12], current_head[:12]))
    paths = list(DeliveryManifest.from_paths(
        payload.get("paths") or (), repository_root=os.getcwd()).files)
    excluded = list(DeliveryManifest.from_paths(
        payload.get("excluded_paths") or (),
        repository_root=os.getcwd()).files)
    if _path_ids(paths) & _path_ids(excluded):
        _die("交付清单的勾选项与排除项重叠")
    digest = _selection_digest(payload)
    if (state.get("delivery_selection") or {}).get("payload_digest") == digest:
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": state_schema, "idempotent": True,
            "status": "selection-reconciled", "current": state.get("current"),
        }, ensure_ascii=False))
        return

    rejected = _archive_rejections(state, paths, excluded)
    declined = _domain_archive_unchanged(state, rejected, payload)
    archive_paths = ((state.get("domain_archive") or {}).get("applied_paths")
                     or ())
    validate_delivery_document_boundary(paths, archive_paths)
    _write_manifest(state, payload, paths)
    state["delivery_selection"] = {
        "schema": SELECTION_SCHEMA,
        "head": selected_head,
        "paths": paths,
        "excluded_paths": excluded,
        "waiting_id": payload.get("waiting_id"),
        "actor": payload.get("actor"),
        "payload_digest": digest,
    }
    history(state, str(state.get("current") or ""),
            "selection-reconcile:" + selected_head[:12],
            "Cloud 人工勾选 %s 个文件；排除 %s 个；拒绝领域归档 %s 个"
            % (len(paths), len(excluded), len(declined)))
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": state_schema, "idempotent": False,
        "status": "selection-reconciled", "current": state.get("current"),
        "sha": selected_head,
    }, ensure_ascii=False))
