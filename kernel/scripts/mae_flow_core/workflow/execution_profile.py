"""Legacy layered execution guidance, kept separate from structural plans."""

import hashlib
import json
import os


PROFILE_SCHEMA = "mae-flow-execution-profile/1"
PROFILE_PATH = os.path.join(".mae-flow-work", "execution-profile.json")
_PLUGIN_ROOT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", ".."))
_CATALOG_PATH = os.path.join(_PLUGIN_ROOT, "flow", "playbooks.json")
_SCOPE_ORDER = {
    "team": 0,
    "business_module": 1,
    "repository": 2,
    "task": 3,
}


def _layer_revision_row(layer):
    return "\0".join(str(layer.get(key) or "") for key in (
        "scope", "source_id", "title", "instructions"))


def _stage_revision_row(item):
    values = [str(item.get(key) or "") for key in (
        "scope", "source_id", "title", "playbook_id", "instructions")]
    values.extend((
        "\x1f".join(item.get("optional_activities") or ()),
        "\x1f".join(item.get("preferred_resources") or ()),
    ))
    return "\0".join(values)


def _profile_revision(layers, stage_customizations=None):
    payload = "\n".join(_layer_revision_row(layer) for layer in layers)
    stages = stage_customizations or []
    if stages:
        payload += (("\n" if payload else "") +
                    "--stage-customizations--\n")
        payload += "\n".join(_stage_revision_row(item) for item in stages)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _missing_text_keys(item, keys):
    return [key for key in keys
            if not isinstance(item.get(key), str) or not item.get(key).strip()]


def _profile_layer_errors(layer):
    if not isinstance(layer, dict):
        return ["execution profile layer must be an object"]
    errors = []
    scope = str(layer.get("scope") or "")
    if scope not in _SCOPE_ORDER:
        errors.append("execution profile has unknown scope %s" % scope)
    errors.extend("execution profile layer has no %s" % key
                  for key in _missing_text_keys(
                      layer, ("source_id", "title", "instructions")))
    if len(str(layer.get("instructions") or "")) > 2000:
        errors.append("execution profile layer exceeds 2000 characters")
    return errors


def _ordered_errors(items, key_builder, message):
    keys = [key_builder(item) for item in items if isinstance(item, dict)]
    known = [key for key in keys
             if (key[0] if isinstance(key, tuple) else key) >= 0]
    return [] if known == sorted(known) else [message]


def _profile_precedence_errors(layers):
    return _ordered_errors(
        layers,
        lambda item: _SCOPE_ORDER.get(str(item.get("scope") or ""), -1),
        "execution profile layers are out of precedence order",
    )


def _stage_identity_errors(item):
    errors = []
    scope = str(item.get("scope") or "")
    if scope not in _SCOPE_ORDER:
        errors.append("execution stage customization has unknown scope %s" %
                      scope)
    errors.extend("execution stage customization has no %s" % key
                  for key in _missing_text_keys(
                      item, ("source_id", "title", "playbook_id")))
    return errors


def _stage_instruction_errors(item):
    instructions = item.get("instructions")
    if instructions is not None and not isinstance(instructions, str):
        return ["execution stage customization instructions must be text"]
    if len(str(instructions or "")) > 2000:
        return ["execution stage customization exceeds 2000 characters"]
    return []


def _stage_list_errors(item, key):
    values = item.get(key)
    if not isinstance(values, list):
        return ["execution stage customization %s must be a list" % key]
    invalid = (len(values) > 24 or values != sorted(set(values)) or
               any(not isinstance(value, str) or not value.strip()
                   for value in values))
    return (["execution stage customization has invalid %s" % key]
            if invalid else [])


def _stage_customization_errors(item):
    if not isinstance(item, dict):
        return ["execution stage customization must be an object"]
    return (_stage_identity_errors(item) + _stage_instruction_errors(item) +
            _stage_list_errors(item, "optional_activities") +
            _stage_list_errors(item, "preferred_resources"))


def _stage_precedence_key(item):
    return (_SCOPE_ORDER.get(str(item.get("scope") or ""), -1),
            str(item.get("playbook_id") or ""),
            str(item.get("source_id") or ""))


def _stage_precedence_errors(items):
    return _ordered_errors(
        items, _stage_precedence_key,
        "execution stage customizations are out of precedence order")


def _playbook_map(catalog):
    return {str(item.get("id") or ""): item
            for item in catalog.get("playbooks") or ()
            if isinstance(item, dict)}


def _optional_ids(playbook):
    return {str(item.get("id") or "")
            for item in playbook.get("activities") or ()
            if isinstance(item, dict) and not item.get("required")}


def _resource_map(playbook):
    return {str(item.get("id") or ""): item
            for item in playbook.get("resources") or ()
            if isinstance(item, dict)}


def _activity_reference_errors(item, optional):
    return ["execution stage customization references unknown optional activity %s"
            % activity_id
            for activity_id in item.get("optional_activities") or ()
            if activity_id not in optional]


def _resource_reference_error(resource_id, resources):
    resource = resources.get(resource_id)
    if not resource:
        return ("execution stage customization references unknown resource %s" %
                resource_id)
    if resource.get("usage") == "required":
        return "required resource cannot be customized: %s" % resource_id
    return ""


def _resource_reference_errors(item, resources):
    errors = [_resource_reference_error(resource_id, resources)
              for resource_id in item.get("preferred_resources") or ()]
    return [error for error in errors if error]


def _catalog_item_errors(item, playbooks):
    if not isinstance(item, dict):
        return []
    playbook_id = str(item.get("playbook_id") or "")
    playbook = playbooks.get(playbook_id)
    if not playbook:
        return ["execution stage customization references unknown playbook %s" %
                playbook_id]
    return (_activity_reference_errors(item, _optional_ids(playbook)) +
            _resource_reference_errors(item, _resource_map(playbook)))


def _stage_catalog_errors(items, catalog):
    playbooks = _playbook_map(catalog)
    return [error for item in items
            for error in _catalog_item_errors(item, playbooks)]


def _layer_collection_errors(layers):
    errors = [] if len(layers) <= 12 else [
        "execution profile has too many layers"]
    errors.extend(error for layer in layers
                  for error in _profile_layer_errors(layer))
    errors.extend(_profile_precedence_errors(layers))
    return errors


def _stage_collection_errors(stages, catalog):
    errors = [] if len(stages) <= 32 else [
        "execution profile has too many stage customizations"]
    errors.extend(error for item in stages
                  for error in _stage_customization_errors(item))
    errors.extend(_stage_precedence_errors(stages))
    if catalog is not None:
        errors.extend(_stage_catalog_errors(stages, catalog))
    return errors


def _instruction_size(layers, stages):
    records = list(layers) + list(stages)
    return sum(len(str(item.get("instructions") or ""))
               for item in records if isinstance(item, dict))


def profile_errors(profile, catalog=None):
    """Validate the immutable host snapshot without turning it into a gate."""
    if not isinstance(profile, dict):
        return ["execution profile must be an object"]
    errors = ([] if profile.get("schema") == PROFILE_SCHEMA else
              ["execution profile schema must be %s" % PROFILE_SCHEMA])
    layers = profile.get("layers")
    stages = profile.get("stage_customizations") or []
    if not isinstance(layers, list):
        return errors + ["execution profile layers must be a list"]
    if not isinstance(stages, list):
        return errors + ["execution stage customizations must be a list"]
    if not layers and not stages:
        return errors + ["execution profile must contain guidance"]
    errors.extend(_layer_collection_errors(layers))
    errors.extend(_stage_collection_errors(stages, catalog))
    if _instruction_size(layers, stages) > 16000:
        errors.append("execution profile exceeds 16000 characters")
    if profile.get("revision") != _profile_revision(layers, stages):
        errors.append("execution profile revision does not match its layers")
    return errors


def _load_catalog():
    with open(_CATALOG_PATH, encoding="utf-8") as stream:
        return json.load(stream)


def load_execution_profile(root=None):
    """Load a host snapshot; bad optional input is ignored with a visible hint."""
    path = os.path.join(root or os.getcwd(), PROFILE_PATH)
    if not os.path.exists(path):
        return None, ""
    try:
        with open(path, encoding="utf-8-sig") as stream:
            profile = json.load(stream)
        errors = profile_errors(profile, _load_catalog())
        if errors:
            return None, ("⚠ 本任务执行补充无效，已采用平台默认方案：" +
                          "；".join(errors))
        return profile, ""
    except Exception as exc:
        return None, ("⚠ 本任务执行补充无法读取，已采用平台默认方案：%s" % exc)


def render_execution_profile(profile):
    """Render lower-priority guidance for ``current`` and fallback sessions."""
    if not profile or not profile.get("layers"):
        return ""
    lines = ["──── 已固定的执行补充（建议层） ────"]
    for layer in profile.get("layers") or ():
        lines.extend(("【%s】" % layer["title"], layer["instructions"]))
    lines.append(
        "边界：这些补充只调整关注点、执行顺序和协作方式；若与当前阶段指令、"
        "真实证据、人工决定或 Git/写入/交付权限冲突，冲突部分无效，"
        "继续按平台规则执行并明确说明。")
    return "\n".join(lines)
