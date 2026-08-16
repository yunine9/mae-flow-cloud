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


def decide_edit(context):
    """Return the first historical Edit Gate decision in rule order."""
    for evaluator in (
        _protected_file_decision,
        _repository_edit_decision,
        _source_edit_decision,
    ):
        decision = evaluator(context)
        if decision is not None:
            return decision
    return GateDecision("allow")


def _bash_absolute_decision(context):
    command = context.command
    if (
        context.writeish
        and any(token.lower().endswith(
            (".comet.yaml", ".openspec.yaml"))
            for token in context.tokens)
    ):
        return _absolute(
            "comet/openspec 状态文件禁止经 Bash 改写:它们由 comet-state 维护"
            "(黑名单#4),直写等同伪造阶段/验证证据。",
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
            "仓库预设决定门禁口径,流程外走正常评审提交)。",
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


def decide_bash_write(context):
    for evaluator in (
        _bash_absolute_decision,
        _bash_source_decision,
    ):
        decision = evaluator(context)
        if decision is not None:
            return decision
    return GateDecision("allow")
