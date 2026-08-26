"""Late in-memory approval-subject binding for captured human answers.

2026-08-26 单次确认修复:模型天然"产物定稿即刻询问",而内容绑定审批卡
历史上要到首次 done 才生成,第一份答案因无印章被 ack 验真过滤,用户被
原样重问一遍(spec/story 双确认,run8b/run9 双跑必现)。答案捕获的瞬间
产物若已就绪,就地按当前内容现算审批主体、只在内存盖章——done 用同一
算法复核"印章 sha == 彼时内容 sha",防线不降级;产物未就绪则构建失败,
走原有的展示-确认路径。状态文件的写入权仍只归 CLI,这里一个字节不落盘。
"""

import os
import time


def bind_missing_approval_subject(flow_state, step, log=None):
    """当前步该有审批卡而 state 尚未绑定时,按此刻产物内容现算主体,
    仅写入内存供本条消息盖章。任何失败都静默放弃(fail-open):
    没有印章时 done 会按老路径要求重新展示,不会放过任何东西。"""
    try:
        if not step:
            return
        subject = (flow_state or {}).get("approval_subject") or {}
        if subject.get("step") == step and subject.get("sha256"):
            return
        flow_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "..", "..", "flow", "flow.json")
        from mae_flow_core.state_store import safe_read_json
        raw, err = safe_read_json(flow_path)
        step_def = ((raw or {}).get("steps") or {}).get(step) or {}
        if err or not isinstance(step_def.get("approval_subject"), dict):
            return
        from mae_flow_core.cli_commands.approval_subject import build_subject
        built = build_subject(os.getcwd(), flow_state, step, step_def)
        if built:
            built["presented_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            flow_state["approval_subject"] = built
    except Exception as exc:
        if log:
            log("late approval-subject bind skipped: %s" % exc)
