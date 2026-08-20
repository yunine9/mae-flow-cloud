"""Pure Gate decisions for repository edit requests."""

from dataclasses import dataclass
import re


@dataclass(frozen=True)
class GateDecision:
    kind: str
    rule: str = ""
    message: str = ""

    def __iter__(self):
        return iter((self.kind, self.rule, self.message))


@dataclass(frozen=True)
class EditGateContext:
    path: str
    match_path: str
    step: str
    inside_plugin: bool
    is_source: bool
    tests_only_patterns: tuple
    source_unlocked: bool
    # 交付方式(choices.workflow)是否已选定。它必然发生在配置确认之后,
    # 是"流程头部已走完"的单一干净信号。默认 True:老调用点/流程中段
    # 行为不变——逐步的"本步不许改源码"是退役决定,这里只封头部。
    workflow_chosen: bool = True
    # UT 抢跑提醒的三个事实:编码步(证据含 COMPILE agent)、新建文件、
    # 命中测试路径。默认全 False:老调用点不触发提醒,行为不变。
    compile_step: bool = False
    new_file: bool = False
    is_test_path: bool = False


@dataclass(frozen=True)
class BashWriteContext:
    command: str
    tokens: tuple
    writeish: bool
    hits_internal_state: bool
    step: str
    offenders: tuple
    tests_only_patterns: tuple
    source_unlocked: bool
    bad_test_sources: tuple
    workflow_chosen: bool = True


def _absolute(message, rule="absolute-policy"):
    return GateDecision("absolute", rule=rule, message=message)


def _block(rule, message):
    return GateDecision("block", rule=rule, message=message)


def _protected_file_decision(context):
    path = context.path
    if path.lower().endswith((".comet.yaml", ".openspec.yaml")):
        return _absolute(
            "禁止手动编辑 comet/openspec 状态文件(.comet.yaml/.openspec.yaml),"
            "它们由 comet-state 维护(黑名单#4)。")
    if re.search(
            r"\.mae-flow\.json(?:\.[\w-]+)*$"
            r"|\.mae-flow-history\.jsonl$|\.mae-flow-need-reload$"
            r"|(^|/)\.mae-flow-work/moonlight-report\.md$",
            path, re.I):
        return _absolute(
            "流程状态/令牌/历史账本/待重启标记/月光宝盒报告由 mae-flow 与 hook "
            "维护,禁止直接编辑或删除。待重启标记只能靠**重启会话**清除"
            "(SessionStart 自动删),不许手动绕过——绕过 = skill 没加载就往下走。")
    if re.search(r"(^|/)\.mae-flow-defaults\.json$", path, re.I):
        return _absolute(
            "流程运行期间禁止修改 .mae-flow-defaults.json:它决定源码/测试路径的"
            "判定口径,改它等于改门禁规则。团队预设请在流程外走正常评审提交。")
    if (
        re.search(r"(^|/)\.env(\.[\w.-]+)?$", path, re.I)
        and not re.search(
            r"\.env\.(example|sample|template|dist|defaults)$",
            path, re.I)
    ):
        return _absolute(
            ".env 类密钥文件禁止写入(凭据保护);确需修改请用户手动操作。")
    return None


def _repository_edit_decision(context):
    if context.inside_plugin:
        return _absolute(
            "禁止修改插件自身(flow/steps/hooks/scripts):流程规则不是交付改动的对象。")
    return None


def _flow_head_decision(context):
    """流程头部(交付方式未选定)不存在合法的源码修改。

    2026-08-19 内网跨仓实战:需求正文里带了整份实施方案,模型跳过
    init→配置确认直接开写代码和 UT,写完才回头问配置——过程文档为零,
    工作区一堆脱缰的未提交改动。逐步的"本步不许改源码"是退役决定
    (可逆动作交给 done 的证据检查),但那说的是流程**中段**;头部
    这段连分支都还没建,写下的每一行都在污染基线,必须同步打回。
    需求/方案/规格文档(非源码)不受限;用户裁决解锁(unlock source)
    照旧尊重。"""
    if not context.is_source:
        return None
    if context.workflow_chosen or context.source_unlocked:
        return None
    return _block(
        "edit-before-workflow",
        "当前流程还在需求/配置阶段(step=%s),交付方式尚未选定,禁止"
        "修改源码——现在写的代码没有分支、没有确认过的配置,全是废功。"
        "请执行 current 按内核指引走完配置确认与交付方式选择,进入"
        "交付链后再动代码。分析结论请先写进方案/需求文档(不受限)。"
        % (context.step or "?"))


def _source_edit_decision(context):
    match_path = context.match_path
    if not context.is_source:
        return None
    if (
        context.tests_only_patterns
        and not context.source_unlocked
        and not any(
            re.search(pattern, match_path, re.I)
            for pattern in context.tests_only_patterns)
    ):
        return _block(
            "edit-tests-only",
            "当前步骤 %s 仅允许写测试路径(当前生效规则: %s)。"
            "UT 暴露的疑似源码缺陷不是死路:自查确认后带报告呈用户裁决,"
            "用户判定确为代码缺陷时先执行 messages 取得回答 ID，再执行 "
            "python \".mae-flow-work/bin/mae-flow.py\" unlock source "
            "--reason <裁决结论> "
            "--message-id <ID> 解锁本步修复;"
            "禁止未经用户裁决自行改源码。"
            % (context.step, "|".join(context.tests_only_patterns)),
        )
    return None


def _ut_preempt_advisory(context):
    """编码步新建测试文件:放行,但提醒这是抢跑白费。

    2026-08-20 云端实战:模型在 build 步写完源码顺手开写 UT。流程语义上
    这不越闸(build_review 的检视卡照弹,verify_ut 只认 UT 子 agent 的
    分批证据),但主会话手写的 UT 一行不计证据,到了 verify_ut 仍由
    子 agent 重做——纯烧 token。只提醒不拦:编码中**修改已有**测试是
    合法的(重构本来就会弄坏旧测试),所以只盯"新建";真有先建测试
    骨架的正当场景,advisory 也不挡路。"""
    if not (context.compile_step and context.new_file
            and context.is_test_path):
        return None
    return GateDecision(
        "advisory", rule="edit-ut-preempt",
        message="检测到在编码步新建测试文件。UT 由 verify_ut 步的 UT 子 "
                "agent 按任务卡分批生成,现在手写的测试不计任何证据,到了 "
                "verify_ut 仍会由子 agent 重做——纯属浪费。请专注本步交付"
                "源码,测试交给后续流程。")


def decide_edit(context):
    """Return the first historical Edit Gate decision in rule order."""
    for evaluator in (
        _protected_file_decision,
        _repository_edit_decision,
        _flow_head_decision,
        _source_edit_decision,
        _ut_preempt_advisory,
    ):
        decision = evaluator(context)
        if decision is not None:
            return decision
    return GateDecision("allow")


def _pipeline_record_decision(context):
    """流水线事实只收宿主递的,不收会话自述。

    2026-08-20 复核实锤:`pipeline record` 是权限最大的命令——它能把
    整单交付判绿——却是唯一一个不要 message-id、不要任何授权锚的命令
    (manifest confirm / accept-risk / goto / allow / unlock 全都要)。
    实测:手写一份两字段 JSON 递进去,内核就记下 PASS、三项全 passed、
    连"宿主已推送"的收据也照收,义务核销当场放行——什么都没编译、
    没测、没扫、没推。宿主是直接子进程调用,不走这条门禁,所以挡住
    会话这一条路不影响正常交付。这不是防坏人,是防"流水线一直不通,
    我先登记一下"的糊弄——本仓所有证据闸门都是这个量级的防御。"""
    if re.search(
        r"mae-flow(?:\.py)?[^\n;|&]*\bpipeline\b[^\n;|&]*\brecord\b",
        context.command, re.I,
    ):
        return _absolute(
            "流水线事实由宿主从平台取回后递交内核登记,不接受会话自述"
            "——自己写一份结果登记等于自己给自己发绿灯。"
            "本步在等流水线就结束当前回合,宿主拿到平台结果会自己登记;"
            "想看已登记的结论执行 pipeline show。",
            rule="bash-pipeline-record-self-report")
    return None


def _bash_absolute_decision(context):
    command = context.command
    decision = _pipeline_record_decision(context)
    if decision is not None:
        return decision
    if (
        context.writeish
        and any(token.lower().endswith(
            (".comet.yaml", ".openspec.yaml"))
            for token in context.tokens)
    ):
        return _absolute(
            "comet/openspec 状态文件禁止经 Bash 改写:它们由 comet-state 维护"
            "(黑名单#4),直写等同伪造阶段/验证证据。"
            "要推进流程请执行 current 按本步指引走。",
            rule="bash-comet-state-write")
    if re.search(r"COMET_FORCE_PHASE", command, re.I):
        return _absolute(
            "COMET_FORCE_PHASE 属于已退役的外部阶段引擎逃生口,本流程不再使用;"
            "阶段由 mae-flow 管理,异常先执行 current 输出中的 doctor 命令。",
            rule="bash-retired-force-phase")
    if re.search(
        r"runtime/vendor/(comet|openspec|superpowers|ponytail)/\S*"
        r"\.(sh|mjs|js)\b|runtime/bin/openspec\b",
        command,
        re.I,
    ):
        return _absolute(
            "禁止直接执行插件内嵌脚本:绕过 capability 包装会丢失内嵌 OpenSpec "
            "路由等环境,退落到机器全局版本(版本锁失效)。请使用 current 给出的 "
            "capability 命令。",
            rule="bash-vendored-runtime")
    if re.search(r"(?:^|[;&|(])\s*openspec\b", command):
        return _absolute(
            "禁止调用机器全局 openspec CLI:schema 与归档语义锁定在内嵌 1.6.0,"
            "全局版本随上游发布漂移(版本锁失效);init 还会交互式生成工具目录污染"
            "仓库。请使用 current 给出的 capability openspec 命令。",
            rule="bash-global-openspec")
    if context.writeish and context.hits_internal_state:
        return _absolute(
            "流程状态/历史账本/待重启标记/仓库预设/月光宝盒报告由 mae-flow "
            "维护,禁止经 Bash 改写/删除(待重启标记只能靠重启会话清;"
            "仓库预设决定门禁口径,流程外走正常评审提交)。"
            "要推进或纠正流程请执行 current 按本步指引走。",
            rule="bash-internal-state-write")
    return None


def _bash_source_decision(context):
    if (
        context.offenders
        and context.tests_only_patterns
        and not context.source_unlocked
        and context.bad_test_sources
    ):
        return _block(
            "bash-tests-only",
            "当前步骤 %s 仅允许写测试路径(当前生效规则: %s);"
            "命中非测试源码: %s。经用户裁决确为代码缺陷时用 unlock source 解锁。"
            % (
                context.step,
                "|".join(context.tests_only_patterns),
                "、".join(context.bad_test_sources[:3]),
            ),
        )
    return None


def _bash_flow_head_decision(context):
    """Bash 写源码与 Edit 同一条头部纪律(sed -i / 重定向同样是写码)。"""
    if not context.offenders:
        return None
    if context.workflow_chosen or context.source_unlocked:
        return None
    return _block(
        "bash-before-workflow",
        "当前流程还在需求/配置阶段(step=%s),交付方式尚未选定,禁止"
        "经 Bash 写源码(命中: %s)。请执行 current 走完配置确认与"
        "交付方式选择,进入交付链后再动代码。"
        % (context.step or "?", "、".join(context.offenders[:3])))


def decide_bash_write(context):
    for evaluator in (
        _bash_absolute_decision,
        _bash_flow_head_decision,
        _bash_source_decision,
    ):
        decision = evaluator(context)
        if decision is not None:
            return decision
    return GateDecision("allow")
