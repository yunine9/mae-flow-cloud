"""Delivery Evidence policies with explicit repository ports."""

import re
from dataclasses import dataclass

from ..foundation.models import EvidenceResult
from ..workflow.evidence import legacy_result


@dataclass(frozen=True)
class DeliveryEvidencePorts:
    moonlight: object
    source_changed_since: object
    archive_delivery_paths: object
    shell_output: object
    argv_output: object
    committed_initial_carryover: object
    committed_delivery_paths: object
    trusted_harness_commit_path: object
    dirty_paths: object
    path_fingerprint: object
    repo_path_identity: object
    agent_written_paths: object
    read_text_replace: object
    agent_ran: object
    push_runs_locally: object = lambda _state: True
    review_document: object = None


def review_status_count(text, status):
    count = 0
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [
            value.strip().strip("*`")
            for value in line.strip().strip("|").split("|")
        ]
        if (len(cells) < 4 or cells[0] == "#"
                or set(cells[0]) <= {"-", ":"}):
            continue
        if cells[-1] == status:
            count += 1
    return count


def review_statuses(text):
    result = {}
    section = "未分节"
    for line in text.splitlines():
        heading = re.match(r"^\s*##\s+(.+?)\s*$", line)
        if heading:
            section = re.sub(r"\s+", " ", heading.group(1)).strip()
            continue
        if not line.lstrip().startswith("|"):
            continue
        cells = [
            value.strip().strip("*`")
            for value in line.strip().strip("|").split("|")
        ]
        if (len(cells) < 4 or cells[0] == "#"
                or set(cells[0]) <= {"-", ":"}):
            continue
        base = "%s / #%s / %s" % (
            section, cells[0], re.sub(r"\s+", " ", cells[1])[:40])
        identity, duplicate = base, 2
        while identity in result:
            identity = "%s / 重复%d" % (base, duplicate)
            duplicate += 1
        result[identity] = cells[-1]
    return result


def review_has_confirmed_fix(text):
    return review_status_count(text, "修复(已确认)") > 0


def _unchanged_manifest_result(manifest, archive, dirty_paths):
    valid = (
        manifest.get("no_changes") is True
        and manifest.get("confirmed") is True
        and archive.get("status") == "applied"
        and archive.get("result") == "unchanged"
        and not (archive.get("applied_paths") or ())
    )
    if not valid:
        return EvidenceResult(
            False, "尚未生成精确交付清单；先执行 manifest set")

    def normalize(path):
        return str(path).replace("\\", "/").casefold()

    preserved = {
        normalize(path) for path in
        (manifest.get("unchanged_initial_dirty") or ())
    }
    leaked = [
        path for path in dirty_paths if normalize(path) not in preserved
    ]
    if leaked:
        return EvidenceResult(
            False, "空交付清单之后仍有新增未提交文件: "
            + "、".join(leaked[:8]))
    return EvidenceResult(True, "领域归档 unchanged，无需创建空提交")


class DeliveryEvidenceRules:
    def __init__(self, ports):
        self.ports = ports

    def archive_paths_clean(self, _spec, state):
        paths = self.ports.archive_delivery_paths(state)
        if not paths:
            return EvidenceResult(
                False,
                "缺少本次定稿的精确产物清单；重新执行 spec archive，"
                "或由维护人核对旧在途状态后再推进",
            )
        dirty = []
        for path in paths:
            output = self.ports.argv_output([
                "git", "status", "--porcelain", "--", path])
            if output:
                dirty.append(
                    "%s(%s)"
                    % (path, output.splitlines()[0][:2].strip()))
        if not dirty:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            "本次定稿产物尚未提交: " + "、".join(dirty)
            + "。只精确 git add 上述路径并提交；不要 git add openspec/，"
            "它可能卷入上一单遗留文件",
        )

    def commit_tagged(self, _spec, state):
        ticket = state["config"].get("单号", "")
        message = self.ports.shell_output(
            "git log -1 --pretty=%s")
        if not message:
            return EvidenceResult(False, "无法读取最新 commit")
        if re.match(
                r"^\[" + re.escape(ticket) + r"\]\[(feat|fix)\]",
                message):
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            "最新 commit「%s」不符合 [%s][feat|fix]描述 格式。"
            "修复只需一条命令(不动已提交的改动内容):"
            "git commit --amend -m \"[%s][fix|feat]<原描述>\""
            % (message, ticket, ticket),
        )

    def commit_tagged_after_entry(self, spec, state):
        step = state.get("current", "")
        base = (
            (state.get("step_heads", {}) or {}).get(step, ""))
        if (
            not base
            or self.ports.argv_output(
                ["git", "cat-file", "-t", base]) != "commit"
        ):
            return EvidenceResult(
                False,
                "缺少 %s 的入口 HEAD，无法证明本步真的产生过提交" % step,
            )
        commits = self.ports.argv_output([
            "git", "log", "--format=%H", base + "..HEAD"]).splitlines()
        if not commits:
            return EvidenceResult(
                False,
                "当前步骤之后没有新提交，不能拿上一步的提交冒充本步产出",
            )
        return self.commit_tagged(spec, state)

    def _branch_committed_paths(self, state):
        """本分支上已经提交过的路径——不只是本步入口之后那一段。

        交付清单是整单的产物清单,其中一部分文件常在更早的步骤就进了 commit
        (质量检视后的提交、build 之后的提交)。只比对本步入口 HEAD..HEAD 时,
        这些文件"没有形成提交",清单永远核不过——而它们其实早就提交了,
        Agent 拿着"仍未形成提交: X"也无从下手(X 已经在 HEAD 里了)。

        放宽的只是"在哪一段提交的",没放宽"必须已提交":diff 的两端都是 commit,
        工作区脏改动进不来;后面的 dirty 检查照旧;本步必须真的产生过提交由
        commit_tagged_after_entry 单独把关。
        """
        baseline = ((state.get("config") or {}).get("基线分支") or "").strip()
        if not baseline:
            return set()
        merge_base = self.ports.argv_output(
            ["git", "merge-base", baseline, "HEAD"]).strip()
        if not merge_base:
            return set()
        return set(self.ports.argv_output([
            "git", "diff", "--name-only", merge_base, "HEAD", "--",
        ]).splitlines())

    def delivery_manifest_committed(self, spec, state):
        manifest = state.get("delivery_manifest") or {}
        files = list(manifest.get("files") or ())
        if not files:
            return _unchanged_manifest_result(
                manifest, state.get("domain_archive") or {},
                self.ports.dirty_paths())
        if manifest.get("confirmed") is not True:
            return EvidenceResult(
                False, "精确交付清单尚未确认，不能进入 push")
        step = state.get("current", "")
        base = (state.get("step_heads", {}) or {}).get(step, "")
        if not base:
            return EvidenceResult(
                False, "缺少交付检视入口 HEAD，无法核对清单提交")
        committed = set(self.ports.argv_output([
            "git", "diff", "--name-only", base, "HEAD", "--",
        ]).splitlines())
        committed |= self._branch_committed_paths(state)
        missing = [path for path in files if path not in committed]
        if missing:
            return EvidenceResult(
                False, "交付清单仍未形成提交: " + "、".join(missing[:8]))
        dirty = set(self.ports.dirty_paths())
        pending = [path for path in files if path in dirty]
        if pending:
            return EvidenceResult(
                False, "交付清单提交后仍有未提交/暂存差异: "
                + "、".join(pending[:8]))
        return self.commit_tagged_after_entry(spec, state)

    def quality_review_committed(self, spec, state):
        context = state.get("quality_review") or {}
        files = list(context.get("changed_files") or ())
        if not files:
            return EvidenceResult(
                False, "质量检视上下文没有精确修改文件，禁止空提交推进")
        step = state.get("current", "")
        base = (state.get("step_heads", {}) or {}).get(step, "")
        if not base:
            return EvidenceResult(
                False, "缺少质量提交入口 HEAD，无法核对检视后的提交")
        committed = set(self.ports.argv_output([
            "git", "diff", "--name-only", base, "HEAD", "--",
        ]).splitlines())
        missing = [path for path in files if path not in committed]
        if missing:
            return EvidenceResult(
                False, "用户检视的质量改动仍未全部提交: "
                + "、".join(missing[:8]))
        extra = [path for path in committed if path not in set(files)]
        if extra:
            return EvidenceResult(
                False, "质量提交夹带了用户未检视的文件: "
                + "、".join(extra[:8])
                + "。请撤销该提交，回到完整 diff 检视后按精确清单重提")
        dirty = set(self.ports.dirty_paths())
        pending = [path for path in files if path in dirty]
        if pending:
            return EvidenceResult(
                False, "质量提交后仍有检视文件处于未提交/暂存状态: "
                + "、".join(pending[:8]))
        return self.commit_tagged_after_entry(spec, state)

    def _push_head_result(self, state):
        current = self.ports.shell_output(
            "git branch --show-current")
        wanted = state.get("config", {}).get("分支名", "")
        if wanted and current != wanted:
            return EvidenceResult(
                False,
                "当前分支 %s != 本单约定分支 %s，禁止在错误分支结束交付"
                % (current or "未知", wanted),
            )
        head = self.ports.shell_output(
            "git rev-parse --verify HEAD")
        upstream = self.ports.shell_output(
            "git rev-parse --verify @{u}")
        if not head:
            return EvidenceResult(False, "无法读取 HEAD")
        if not upstream:
            return EvidenceResult(
                False,
                "分支无上游跟踪——用 git push -u origin HEAD 推送并建立跟踪",
            )
        if head != upstream:
            return EvidenceResult(
                False,
                "本地 HEAD 与远端上游不一致(未推送/推送失败/远端有新提交):"
                "先尝试普通 git push -u origin HEAD；若远端领先，执行 git fetch "
                "后展示分叉，不要自动 rebase、reset 或 force-push"
                "（可能改写已检视代码）",
            )
        return None

    def _push_committed_result(self, state):
        carried, error = self.ports.committed_initial_carryover(state)
        if error:
            return EvidenceResult(
                False, "无法核对是否夹带上一单遗留文件:" + error)
        if carried:
            return EvidenceResult(
                False,
                "远端提交夹带了流程启动前已存在、且本单 Agent 未实际改写的文件: "
                + "、".join(carried[:8])
                + ("…" if len(carried) > 8 else "")
                + "。这通常是上一单选择“不上传”后遗留的文件。"
                "请用普通后续提交精确移除这些文件并重新 push；"
                "不要 amend/rebase/force-push 改写已检视历史。"
                "若本单确实需要它，先让 Agent 按本单需求实际修改并重新检视",
            )
        paths, error = self.ports.committed_delivery_paths(state)
        if error:
            return EvidenceResult(
                False, "无法核对已推送 OpenSpec 的归属:" + error)
        foreign = [
            path for path in paths
            if path.startswith("openspec/")
            and not self.ports.trusted_harness_commit_path(path, state)
        ]
        if foreign:
            return EvidenceResult(
                False,
                "远端提交含不属于当前 CHANGE_NAME/本次归档的 OpenSpec 文件: "
                + "、".join(foreign[:8])
                + ("…" if len(foreign) > 8 else "")
                + "。请用普通后续提交精确移除并重新 push；"
                "STORY 不入库时应移入 .mae-flow-work/story",
            )
        return None

    def _changed_during_flow(self, state):
        current = set(self.ports.dirty_paths())
        initial = set(state.get("initial_dirty", []))
        if "initial_dirty" not in state:
            return current
        fingerprints = (
            state.get("initial_dirty_fingerprints", {}) or {})
        changed_initial = set()
        if fingerprints:
            changed_initial = {
                path for path in current & initial
                if fingerprints.get(path)
                != self.ports.path_fingerprint(path)
            }
        return (current - initial) | changed_initial

    def _push_dirty_result(self, state):
        changed = self._changed_during_flow(state)
        written = self.ports.agent_written_paths()
        dirty = {
            path for path in changed
            if (
                self.ports.repo_path_identity(path) in written
                or self.ports.trusted_harness_commit_path(path, state)
            )
        }
        story_mode = str(
            state.get("config", {}).get("STORY入库", "")).lower()
        if any(value in story_mode for value in (
                "不生成", "不入库", "不提交", "no", "false")):
            story = "docs/story/STORY-%s.md" % (
                state.get("config", {}).get("单号", ""))
            tracked = self.ports.argv_output([
                "git", "ls-tree", "-r", "--name-only",
                "HEAD", "--", story])
            if tracked:
                return EvidenceResult(
                    False,
                    "STORY 已确认不入库，但 %s 仍在当前提交中。"
                    "用 git rm --cached 精确移出索引并按单号提交修正；"
                    "本地文件可以保留。" % story,
                )
            dirty = {
                path for path in dirty
                if not path.startswith("docs/story/")
            }
        if dirty:
            return EvidenceResult(
                False,
                "仍有 Agent 实际写入或流程明确维护的交付候选未处理，"
                "远端不包含这些变化: "
                + "、".join(sorted(dirty)[:8])
                + "。逐个查看 diff：需要交付的精确提交，不需要的撤销修改；"
                "候选范围不代表必须全部提交。",
            )
        return None

    def pushed(self, _spec, state):
        evaluators = [self._push_committed_result, self._push_dirty_result]
        if self.ports.push_runs_locally(state):
            evaluators.insert(0, self._push_head_result)
        for evaluator in evaluators:
            result = evaluator(state)
            if result is not None:
                return result
        return EvidenceResult(True, "")

    def review_fix_committed(self, spec, state):
        path = (
            self.ports.review_document(state)
            if self.ports.review_document is not None
            else ".mae-flow-work/%s/review.md" % (
                state.get("config", {}).get("单号", "")))
        try:
            text = self.ports.read_text_replace(path)
        except OSError:
            return EvidenceResult(
                False, "评审裁决文档不存在: " + path)
        baseline_rows = state.get("review_triage_statuses")
        current_rows = review_statuses(text)
        newly_transferred = []
        if isinstance(baseline_rows, dict):
            newly_transferred = [
                identity for identity, status in current_rows.items()
                if status == "转规格轮次(已确认)"
                and baseline_rows.get(identity) != "转规格轮次(已确认)"
            ]
        else:
            baseline = state.get("review_triage_transfer_count")
            transfers = review_status_count(
                text, "转规格轮次(已确认)")
            if isinstance(baseline, int) and transfers > baseline:
                newly_transferred = [
                    "旧状态新增%d条" % (transfers - baseline)]
        if newly_transferred:
            asked = legacy_result(self.ports.agent_ran(
                {"agent": "ASKUSER"}, state))
            if not asked.passed:
                return EvidenceResult(
                    False,
                    "返工阶段把以下意见新改成了「转规格轮次(已确认)」: "
                    + "、".join(newly_transferred[:8])
                    + "；但本步没有真实 AskUserQuestion 用户裁决。"
                    "修复中改变既有裁决必须先向用户展示代码证据与行为影响，"
                    "再由用户确认；" + asked.reason,
                )
        if not review_has_confirmed_fix(text):
            return EvidenceResult(True, "")
        return self.commit_tagged_after_entry(spec, state)
