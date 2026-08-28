"""Explain the current step without moving or weakening the workflow.

The state machine owns *what must be true*.  Versioned Playbooks explain the
platform's default *way of getting there*.  This module joins those two facts
into a read-only manifest for hosts, people and a compact Agent guidance block;
it never changes workflow state or replaces the authoritative step contract.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os


SCHEMA = "mae-flow-execution-plan/1"
CATALOG_SCHEMA = "mae-flow-playbook-catalog/1"
PROFILE_SCHEMA = "mae-flow-execution-profile/1"
_PLUGIN_ROOT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", ".."))
CATALOG_PATH = os.path.join(_PLUGIN_ROOT, "flow", "playbooks.json")
PROFILE_PATH = os.path.join(".mae-flow-work", "execution-profile.json")
_PROFILE_SCOPE_ORDER = {
    "team": 0,
    "business_module": 1,
    "repository": 2,
    "task": 3,
}


_EVIDENCE_LABELS = {
    "agent_ran": "指定 Agent 已真实执行",
    "branch_ok": "任务分支已经创建并验证",
    "content_free": "产物没有未完成占位或待裁决项",
    "glob": "必需产物已经生成",
    "local_spec_valid": "本单 Spec 已通过结构校验",
    "pipeline": "权威流水线结果已核销",
}


def load_catalog(path=CATALOG_PATH):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def _profile_revision(layers):
    payload = "\n".join("\0".join((
        str(layer.get("scope") or ""),
        str(layer.get("source_id") or ""),
        str(layer.get("title") or ""),
        str(layer.get("instructions") or ""),
    )) for layer in layers)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _profile_layer_errors(layer):
    if not isinstance(layer, dict):
        return ["execution profile layer must be an object"]
    errors = []
    scope = str(layer.get("scope") or "")
    if scope not in _PROFILE_SCOPE_ORDER:
        errors.append("execution profile has unknown scope %s" % scope)
    missing = [
        key for key in ("source_id", "title", "instructions")
        if not isinstance(layer.get(key), str) or not layer.get(key).strip()
    ]
    errors.extend("execution profile layer has no %s" % key for key in missing)
    if len(str(layer.get("instructions") or "")) > 2000:
        errors.append("execution profile layer exceeds 2000 characters")
    return errors


def _profile_precedence_errors(layers):
    orders = [
        _PROFILE_SCOPE_ORDER.get(str(layer.get("scope") or ""), -1)
        for layer in layers if isinstance(layer, dict)
    ]
    known = [order for order in orders if order >= 0]
    return ([] if known == sorted(known) else
            ["execution profile layers are out of precedence order"])


def profile_errors(profile):
    """Validate the immutable host snapshot without turning it into a gate."""
    if not isinstance(profile, dict):
        return ["execution profile must be an object"]
    errors = ([] if profile.get("schema") == PROFILE_SCHEMA else
              ["execution profile schema must be %s" % PROFILE_SCHEMA])
    layers = profile.get("layers")
    if not isinstance(layers, list) or not layers:
        return errors + ["execution profile must contain layers"]
    errors.extend([] if len(layers) <= 12 else
                  ["execution profile has too many layers"])
    for layer in layers:
        errors.extend(_profile_layer_errors(layer))
    errors.extend(_profile_precedence_errors(layers))
    total = sum(len(str(layer.get("instructions") or ""))
                for layer in layers if isinstance(layer, dict))
    if total > 8000:
        errors.append("execution profile exceeds 8000 characters")
    if profile.get("revision") != _profile_revision(layers):
        errors.append("execution profile revision does not match its layers")
    return errors


def load_execution_profile(root=None):
    """Load a host snapshot; bad optional input is ignored with a visible hint."""
    path = os.path.join(root or os.getcwd(), PROFILE_PATH)
    if not os.path.exists(path):
        return None, ""
    try:
        with open(path, encoding="utf-8-sig") as stream:
            profile = json.load(stream)
        errors = profile_errors(profile)
        if errors:
            return None, ("⚠ 本任务执行补充无效，已采用平台默认方案：" +
                          "；".join(errors))
        return profile, ""
    except Exception as exc:
        return None, ("⚠ 本任务执行补充无法读取，已采用平台默认方案：%s" % exc)


def render_execution_profile(profile):
    """Render lower-priority guidance for ``current`` and non-kernel fallback."""
    if not profile:
        return ""
    lines = ["──── 已固定的执行补充（建议层） ────"]
    for layer in profile.get("layers") or ():
        lines.extend(("【%s】" % layer["title"], layer["instructions"]))
    lines.append(
        "边界：这些补充只调整关注点、执行顺序和协作方式；若与当前阶段指令、"
        "真实证据、人工决定或 Git/写入/交付权限冲突，冲突部分无效，"
        "继续按平台规则执行并明确说明。")
    return "\n".join(lines)


def render_agent_execution_plan(plan):
    """Compile the same visible Playbook into compact, non-gating guidance."""
    strategy = plan["strategy"]
    lines = [
        "──── 平台默认执行方案（%s） ────" % plan["plan_id"],
        "%s：%s" % (strategy["title"], strategy["summary"]),
        "默认动作：",
    ]
    for activity in plan.get("activities") or ():
        lines.append("- %s：%s" % (
            activity["title"], activity["description"]))
    resources = plan.get("resources") or ()
    if resources:
        usage_labels = {
            "required": "必用",
            "when_needed": "按情况",
            "on_demand": "按需读取",
        }
        lines.append("能力索引（列出不等于把正文注入上下文）：")
        lines.extend("- [%s] %s" % (
            usage_labels.get(resource.get("usage"), "按情况"),
            resource["name"])
                     for resource in resources)
    outputs = plan.get("contract", {}).get("outputs") or ()
    if outputs:
        lines.append("完成时应得到：" + "、".join(outputs))
    lines.append("平台兜底：" + "、".join(
        plan.get("customization", {}).get("locked") or ()))
    return "\n".join(lines)


def _identity_errors(item, identities):
    identity = (item.get("id"), item.get("version"))
    errors = []
    if not all(isinstance(value, str) and value.strip() for value in identity):
        errors.append("playbook id and version are required")
    elif identity in identities:
        errors.append("duplicate playbook: %s@%s" % identity)
    identities.add(identity)
    return errors


def _metadata_errors(item):
    identity = item.get("id") or "?"
    errors = []
    if not str(item.get("title", "")).strip():
        errors.append("playbook %s has no title" % identity)
    if not str(item.get("summary", "")).strip():
        errors.append("playbook %s has no summary" % identity)
    return errors


def _step_binding_errors(item, known_steps, bound):
    errors = []
    identity = item.get("id") or "?"
    for step in item.get("steps") or ():
        if step not in known_steps:
            errors.append("playbook %s binds unknown step %s" % (
                identity, step))
        elif step in bound:
            errors.append("step %s is bound by both %s and %s" % (
                step, bound[step], identity))
        else:
            bound[step] = identity
    return errors


def _named_item_errors(item, field, name_key):
    identity = item.get("id") or "?"
    return [
        "playbook %s has an invalid %s" % (identity, field[:-1])
        for value in item.get(field) or ()
        if not isinstance(value, dict) or not str(value.get(name_key, "")).strip()
    ]


def _catalog_entry_errors(item, known_steps, bound, identities):
    if not isinstance(item, dict):
        return ["playbook entry must be an object"]
    return (
        _identity_errors(item, identities)
        + _metadata_errors(item)
        + _step_binding_errors(item, known_steps, bound)
        + _named_item_errors(item, "activities", "title")
        + _named_item_errors(item, "resources", "name")
    )


def catalog_errors(flow, catalog):
    """Return stable validation errors instead of partially explaining a flow."""
    errors = ([] if catalog.get("schema") == CATALOG_SCHEMA else
              ["playbook catalog schema must be %s" % CATALOG_SCHEMA])
    playbooks = catalog.get("playbooks")
    if not isinstance(playbooks, list) or not playbooks:
        return errors + ["playbook catalog must contain playbooks"]

    known_steps = set((flow.get("steps") or {}).keys())
    bound = {}
    identities = set()
    for item in playbooks:
        errors.extend(_catalog_entry_errors(
            item, known_steps, bound, identities))
    missing = sorted(known_steps - set(bound))
    if missing:
        errors.append("steps without a default playbook: " + ", ".join(missing))
    return errors


def _playbook_for(catalog, step_id):
    for item in catalog.get("playbooks") or ():
        if step_id in (item.get("steps") or ()):
            return item
    return None


def _evidence_contract(step):
    contract = []
    seen = set()
    for evidence in step.get("evidence") or ():
        kind = str(evidence.get("type") or "unknown")
        label = _EVIDENCE_LABELS.get(kind, "内核要求的 %s 证据" % kind)
        key = (kind, label)
        if key in seen:
            continue
        seen.add(key)
        contract.append({"type": kind, "label": label})
    return contract


def _selection_reason(state, playbook):
    workflow = str(((state.get("choices") or {}).get("workflow")) or "")
    phase = playbook.get("phase") or "当前"
    reason = "当前处于%s阶段，采用平台为该阶段验证过的默认做法。" % phase
    if workflow:
        reason += "本单交付方式为 %s。" % workflow
    return reason


def _validated_selection(flow, state, catalog, profile):
    errors = catalog_errors(flow, catalog)
    if errors:
        raise ValueError("; ".join(errors))
    if profile:
        errors = profile_errors(profile)
        if errors:
            raise ValueError("; ".join(errors))
    step_id = str(state.get("current") or "")
    step = (flow.get("steps") or {}).get(step_id)
    if step is None:
        raise ValueError("current step is not present in flow: " + step_id)
    playbook = _playbook_for(catalog, step_id)
    if playbook is None:
        raise ValueError("current step has no default playbook: " + step_id)
    return step_id, step, playbook


def _selected_playbook(playbook):
    selected = copy.deepcopy(playbook)
    selected.pop("steps", None)
    return selected


def _plan_revision(selected, step_id, step, profile):
    source = json.dumps({
        "playbook": selected,
        "step": step_id,
        "contract": step,
        "profile_revision": (profile or {}).get("revision"),
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def _plan_outputs(selected, step):
    outputs = list(selected.pop("outputs", ()))
    artifacts = list((step.get("approval_subject") or {}).get("artifacts") or ())
    outputs.extend(artifact for artifact in artifacts if artifact not in outputs)
    return outputs


def _customization(defaults, profile):
    layers = copy.deepcopy((profile or {}).get("layers") or [])
    return {
        "mode": "bounded",
        "customizable": list(defaults.get("customizable") or ()),
        "locked": list(defaults.get("locked") or ()),
        "effective_source": (
            "platform_default+overrides" if layers else "platform_default"),
        "profile_revision": (profile or {}).get("revision"),
        "layers": layers,
    }


def build_execution_plan(flow, state, catalog=None, profile=None):
    """Build one immutable, JSON-safe explanation for the current state."""
    catalog = catalog or load_catalog()
    step_id, step, playbook = _validated_selection(
        flow, state, catalog, profile)
    selected = _selected_playbook(playbook)
    identity = "%s@%s" % (selected["id"], selected["version"])
    plan_revision = _plan_revision(selected, step_id, step, profile)
    outputs = _plan_outputs(selected, step)
    defaults = catalog.get("defaults") or {}
    return {
        "schema": SCHEMA,
        "plan_id": identity,
        "plan_revision": plan_revision,
        "step": {
            "id": step_id,
            "title": str(step.get("title") or step_id),
            "phase": selected.get("phase") or "",
            "state_revision": state.get("revision"),
        },
        "strategy": {
            "id": selected["id"],
            "version": selected["version"],
            "title": selected["title"],
            "summary": selected["summary"],
            "source": "platform_default",
            "selection_reason": _selection_reason(state, selected),
        },
        "contract": {
            "human_decision": bool(
                step.get("user_ack") or step.get("approval_subject")),
            "evidence": _evidence_contract(step),
            "outputs": outputs,
        },
        "activities": selected.get("activities") or [],
        "resources": selected.get("resources") or [],
        "knowledge": {
            "loading": defaults.get(
                "knowledge_loading", "indexed_on_demand"),
            "explanation": "选中的知识和 Skill 先提供轻量索引，Agent 按任务需要读取正文；选中不等于全文注入。",
        },
        "customization": _customization(defaults, profile),
    }
