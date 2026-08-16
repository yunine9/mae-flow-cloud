"""宿主形态:用户和内核在不在同一台机器上。

内核的提示词长期默认"用户就坐在这台机器前"——于是会让用户去 IDE 里检视
代码、把现场面板的绝对路径念给用户听、让他用浏览器打开一个本地文件。这在
终端场景下都对。

接进云端控制台以后它们全错了:用户在浏览器里看的是另一台机器,那个路径他
打不开,IDE 也不存在,材料本来就已经摆在页面上。更糟的是这些话会被模型
**原样转述**给用户(内核为此还专门加了转述义务),于是用户看到一串做不到
的指令,只会以为流程坏了。

`MAE_FLOW_HOST=cloud` 表示用户在远端界面上;其余取值(含不设置)一律按
"用户就在这台机器上"处理——本地 CLI 的行为一字不变。
"""

import os

ENV = "MAE_FLOW_HOST"
CLOUD = "cloud"


def host_kind():
    return (os.environ.get(ENV) or "").strip().lower()


def user_on_this_machine():
    """用户能不能直接摸到这台机器上的文件、IDE 和浏览器。

    只有这一个判断:能摸到就照旧给路径、让他去 IDE 看;摸不到就闭嘴——
    宁可不说,也不能给一条他做不到的指令。
    """
    return host_kind() != CLOUD


def worker_agent_ledger_gates():
    """子 Agent 生命周期台账还作不作机器门禁。

    云端宿主(pi 进程内)取不到内核格式的子会话执行台账:agent 真跑了、
    真返回了,证据口就是看不见,同一批签发多少次都不前进,最后只能
    accept-risk——令牌仪式在云端退化成纯摩擦(实战 verify_ut 连撞 3 次)。

    云端的机器把关走另一条路:交付事实来自远端真实状态,流水线结果绑
    SHA(见 mae-flow-cloud 红线)。所以云端放开的只是"子会话记账"这一种
    证据形态,不是放弃验证;本地 CLI 一字不变。

    ASKUSER 不在此列——那是人工闸,云端决定卡走得通,放开它等于把人踢出局。
    """
    return host_kind() != CLOUD


def codecheck_runs_locally():
    """CodeCheck 本地扫描还做不做。

    CodeCheck 是内网 npm 工具(fullcheck,内部源安装)。云端宿主装不上,
    每次扫描都要空撞一次"尽力安装"(附带 30 分钟冷却),再落一个
    TOOL_ERROR 引人去走恢复通道——纯噪声(2026-08-15 云端 task-1 实锤)。
    用户拍板:云端 CodeCheck 交由流水线核对,本地不扫;lightcheck
    (内核自带轻检查,不依赖外部工具)不受影响照常跑。本地 CLI 一字不变。
    """
    return host_kind() != CLOUD
