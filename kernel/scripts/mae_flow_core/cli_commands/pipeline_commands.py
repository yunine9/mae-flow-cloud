"""流水线证据口(云端):宿主喂平台事实,内核裁决并落盘现场。

为什么存在:云端契约把编译/UT"推迟给流水线"(host_env.build_runs_locally
等三个开关),但推迟只是一句承诺——此前那三个 deferred 标记只活在
ContractDecision.details 的内存里,没人落盘、没人事后核销。这里补上
兑现的一半:宿主在流水线终态时把平台事实(SHA/状态/来源)写成 JSON
递进来,内核绑工作区当前 HEAD 裁决,结论写进 .mae-flow.json 的
quality.pipeline——现场文件是唯一真相,云端页面与投影只是它的镜像。

裁决规则(判定只在这里,宿主一行不判):
- 事实里的 sha 必须等于当前 HEAD,否则 STALE——旧绿灯不背书新代码
  (mvp 设计 14.5;STALE 照记不拒登,记录本身就是诚实的物证);
- SHA 对上且 status=success → PASS;status=failed → RED(留痕;
  修复环是宿主的事,内核只记事实与结论);
- 事实缺 sha / status 不认识 → 拒绝登记退 2,不猜。

这不是门禁(第一期):登记不推动任何步骤——流程此刻通常已在 end,
它是物证,让"推迟给流水线"的承诺兑现与否从此有据可查。record 不要求
--message-id:事实来自平台 API(宿主转递),不是人的断言;source/url
字段留审计线索。本地 CLI 行为不变:命令是新增的,本地没人喂事实就
永远不会被调用。
"""

import json

from .shared import os, time
from .wiring import api


_VALID_STATUS = ("success", "failed")


def adjudicate(facts, head):
    """纯判定:平台事实 + 当前 HEAD → (verdict, reason)。

    单独成函数是为了测试可直插(不用装配整个 CLI 运行时),也为了
    让"判定规则"与"落盘仪式"分开审——改规则不该动 IO。
    """
    sha = str(facts.get("sha") or "")
    status = str(facts.get("status") or "")
    if not sha or status not in _VALID_STATUS:
        return "INVALID", "事实缺 sha,或 status 不是 success/failed"
    if sha != head:
        return ("STALE",
                "流水线绑的是 %s,当前 HEAD 是 %s——旧结果不背书新代码"
                % (sha[:12], head[:12]))
    if status == "success":
        return "PASS", "流水线成功且绑定当前 HEAD"
    return "RED", "流水线失败(已绑定当前 HEAD),待修复或人工"


def cmd_pipeline(flow, st, args):
    quality = st.setdefault("quality", {})
    if args.action == "show":
        record = quality.get("pipeline")
        print(json.dumps(record, ensure_ascii=False) if record else "null")
        return
    path = os.path.abspath(args.file)
    try:
        with open(path, "r", encoding="utf-8") as stream:
            facts = json.load(stream)
    except Exception as exc:
        api.die("pipeline record 读不了事实文件 %s: %s" % (path, exc), 2)
    if not isinstance(facts, dict):
        api.die("pipeline record 的事实文件必须是 JSON 对象。", 2)
    head = api.sh("git rev-parse --verify HEAD")
    verdict, reason = adjudicate(facts, head)
    if verdict == "INVALID":
        api.die("pipeline record 拒绝登记:" + reason, 2)
    record = {
        "step": st.get("current", ""),
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "head": head,
        "sha": str(facts.get("sha")),
        "status": str(facts.get("status")),
        "verdict": verdict,
        "reason": reason,
        "source": str(facts.get("source") or ""),
        "url": str(facts.get("url") or ""),
    }
    quality["pipeline"] = record
    api.save_state(st)
    print("[mae-flow] 流水线裁决 %s: %s" % (verdict, reason))
    # 机器可读的最后一行:宿主(mae-flow-cloud)按"末行 JSON"消费。
    print(json.dumps(record, ensure_ascii=False))
