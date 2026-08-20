"""Bind captured human messages to the exact card content on screen."""


def decision_bindings(flow_state, step):
    fields = {}
    config = (flow_state or {}).get("config_review") or {}
    if step == "config_confirm" and config.get("step") == step:
        fields.update({
            "config_review_sha256": str(config.get("sha256", "")),
            "config_review_id": str(config.get("id", "")),
        })
    subject = (flow_state or {}).get("approval_subject") or {}
    if subject.get("step") == step:
        fields.update({
            "approval_subject_sha256": str(subject.get("sha256", "")),
            "approval_subject_id": str(subject.get("id", "")),
        })
    return {key: value for key, value in fields.items() if value}
