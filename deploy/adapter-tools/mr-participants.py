#!/usr/bin/env python3
"""Read, merge and verify MR participants without guessing CodeHub response fields.

Arguments: encoded project path, MR iid or URL, participant JSON, token.
MFC_CODEHUB_MR_PARTICIPANT_FIELDS must map requested roles to verified dot paths
in the MR detail response. No default mapping is assumed. A field must contain
the complete role list, as account strings or objects with a username property.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


ROLES = ("reviewers", "approval_approvers")
FLAGS = dict(reviewers="--reviewers", approval_approvers="--approval-approvers")
ACCOUNT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}", re.ASCII)


class ParticipantError(Exception):
    """Credential-free messages authored here, never upstream exception text."""


def account(value):
    if not isinstance(value, str) or not ACCOUNT.fullmatch(value):
        raise ParticipantError("人员名单中存在无效的 CodeHub 账号，未执行更新")
    return value


def requested_participants(raw):
    if not isinstance(raw, dict) or any(key not in ROLES for key in raw):
        raise ParticipantError("MR 人员只能包含检视人和审批人账号数组")
    result = dict()
    for role in ROLES:
        values = raw.get(role, [])
        if not isinstance(values, list):
            raise ParticipantError("MR 人员必须使用账号数组")
        result[role] = list(dict.fromkeys(account(value) for value in values))
    return result


def role_fields(roles):
    raw = os.environ.get("MFC_CODEHUB_MR_PARTICIPANT_FIELDS", "")
    if not raw:
        raise ParticipantError("人员读取字段尚未配置：请用内网 MR 详情样例确认完整名单字段后设置 MFC_CODEHUB_MR_PARTICIPANT_FIELDS")
    try:
        fields = json.loads(raw)
    except (ValueError, TypeError):
        raise ParticipantError("人员读取字段配置不是有效的 JSON 对象")
    if not isinstance(fields, dict) or any(key not in ROLES for key in fields):
        raise ParticipantError("人员读取字段配置包含未知角色或不是对象")
    paths = []
    for role in roles:
        path = fields.get(role)
        if not isinstance(path, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*", path):
            raise ParticipantError("人员读取字段尚未配置或路径无效：" + role)
        paths.append(path)
    if len(set(paths)) != len(paths):
        raise ParticipantError("不同角色不能读取同一个人员名单字段")
    return fields


def read_role(detail, role, path):
    value = detail
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise ParticipantError("MR 详情缺少已配置的完整人员名单字段：" + role)
        value = value[part]
    if not isinstance(value, list):
        raise ParticipantError("MR 详情的人员字段不是完整数组：" + role)
    result = []
    for item in value:
        username = item.get("username") if isinstance(item, dict) else item
        result.append(account(username))
    return list(dict.fromkeys(result))


def apply_participants(repo, mr, requested, token):
    roles = [role for role in ROLES if requested[role]]
    if not roles:
        return dict(status="skipped", requested=requested, message="未配置 MR 人员，无需更新")
    fields = role_fields(roles)
    if not mr.isdigit():
        match = re.search(r"/merge_requests/(\d+)$", urllib.parse.urlparse(mr).path.rstrip("/"))
        if not match:
            raise ParticipantError("MR 标识必须是 iid 或 MR URL")
        mr = match.group(1)
    project = urllib.parse.unquote(repo)
    if not project or not token:
        raise ParticipantError("人员设置缺少仓库或身份凭据")
    api = os.environ.get("MFC_CODEHUB_API", "https://codehub-y.huawei.com/api/v4").rstrip("/")
    url = api + "/projects/" + urllib.parse.quote(project, safe="") + "/merge_requests/" + mr
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(dict()))
    deadline = time.monotonic() + 25

    def remaining(limit):
        budget = deadline - time.monotonic()
        if budget <= 0:
            raise ParticipantError("人员设置超时，结果未确认；重试时将先读取远端名单")
        return min(limit, budget)

    def read():
        request = urllib.request.Request(url, headers={"Private-Token": token, "Cache-Control": "no-cache"})
        with opener.open(request, timeout=remaining(5)) as response:
            detail = json.load(response)
        if not isinstance(detail, dict) or str(detail.get("iid", "")) != mr:
            raise ParticipantError("MR 详情未返回匹配的 iid，未确认人员设置")
        if detail.get("state") != "opened":
            raise ParticipantError("MR 未处于打开状态，人员设置结果未确认")
        return {role: read_role(detail, role, fields[role]) for role in roles}

    current = read()
    merged = {role: list(dict.fromkeys(current[role] + requested[role])) for role in roles}
    if all(set(requested[role]).issubset(current[role]) for role in roles):
        return dict(status="applied", requested=requested, message="远端已包含请求的 MR 人员")
    command = ["codehub-cli", "mr", "update", "--host",
               os.environ.get("MFC_CODEHUB_CLI_HOST", "yellow"), "--project", project, mr]
    for role in roles:
        command.extend([FLAGS[role], ",".join(merged[role])])
    command.extend(["--format", "json", "-k"])
    env = os.environ.copy()
    env["CODEHUB_TOKEN"] = token
    # 平台尚无已确认的条件更新契约；读写之间的人工修改仍可能发生竞争。
    completed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=remaining(12))
    if completed.returncode != 0:
        raise ParticipantError("MR 人员更新命令失败，退出码 " + str(completed.returncode) + "；可能已部分生效，重试时将先读取远端名单")
    actual = read()
    if any(not set(merged[role]).issubset(actual[role]) for role in roles):
        raise ParticipantError("平台回读未确认全部原有及新增人员；未标记成功，请检查 MR 后重试")
    return dict(status="applied", requested=requested)


def main(argv):
    requested = {role: [] for role in ROLES}
    try:
        if len(argv) != 5:
            raise ParticipantError("人员设置参数不完整")
        requested = requested_participants(json.loads(argv[3]))
        result = apply_participants(argv[1], argv[2], requested, argv[4])
    except Exception as error:
        if isinstance(error, ParticipantError):
            message = str(error)
        elif isinstance(error, urllib.error.HTTPError):
            message = "MR 人员查询失败，HTTP " + str(error.code)
        elif isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
            message = "人员设置超时，结果未确认；重试时将先读取远端名单"
        elif isinstance(error, FileNotFoundError):
            message = "人员更新命令不可用，请检查 codehub-cli 安装"
        else:
            message = "人员设置未完成：" + type(error).__name__
        result = dict(status="failed", requested=requested, message=message)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
