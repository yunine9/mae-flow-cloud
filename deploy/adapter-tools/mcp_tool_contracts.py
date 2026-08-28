#!/usr/bin/env python3
"""内网 MCP tools/list 已对拍的参数构造器。

2026-08-28 五网关真实 inputSchema 回传后，CodeHub 的 request 嵌套、
Build 的 group_id 与各字段类型在这里集中落一份。状态链和 artifacts 链
必须共用，不能再各猜一套。这里只负责机械组装参数，不做流程判断。
"""
from __future__ import annotations


def _required_text(value, name: str) -> str:
    text = str(value or '').strip()
    if not text:
        raise ValueError(f'{name} 不能为空')
    return text


def _required_int(value, name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f'{name} 必须是整数') from None


def project_info_arguments(git_url: str) -> dict:
    """codehub.get_project_info:git_url 顶层，request 为可选增益。"""
    return {'git_url': _required_text(git_url, 'git_url')}


def mergeable_state_arguments(project_id, merge_request_iid) -> dict:
    """codehub.get_merge_request_mergeable_state:业务参数嵌在 request。"""
    return {
        'request': {
            'project_id': project_id,
            'merge_request_iid': _required_int(
                merge_request_iid, 'merge_request_iid'),
        },
    }


def actual_head_pipeline_arguments(
    project_id,
    merge_request_iid,
    show_job=True,
) -> dict:
    """codehub.actual_head_pipeline 同样要求业务参数嵌在 request。"""
    return {
        'request': {
            'project_id': project_id,
            'merge_request_iid': _required_int(
                merge_request_iid, 'merge_request_iid'),
            'show_job': bool(show_job),
        },
    }


def pipeline_quality_arguments(
    project_id,
    pipeline_id,
    merge_request_id=None,
) -> dict:
    """codehub.get_pipeline_quality 的真实 request 结构。"""
    request = {
        'project_id': project_id,
        'pipeline_id': _required_int(pipeline_id, 'pipeline_id'),
    }
    if merge_request_id not in (None, ''):
        request['merge_request_id'] = _required_int(
            merge_request_id, 'merge_request_id')
    return {'request': request}


_BUILD_OPTIONAL_FIELDS = {
    'start_offset', 'end_offset', 'size', 'sort', 'filter', 'level',
}


def build_record_arguments(record_id, group_id, **optional) -> dict:
    """Build 四个 record 工具共用 record_id + group_id 基础契约。"""
    unknown = sorted(set(optional) - _BUILD_OPTIONAL_FIELDS)
    if unknown:
        raise ValueError(f'Build MCP 未知参数：{", ".join(unknown)}')
    return {
        'record_id': _required_text(record_id, 'record_id'),
        'group_id': _required_text(group_id, 'group_id'),
        **{key: value for key, value in optional.items() if value is not None},
    }


def coverage_arguments(job_id, module_name=None) -> dict:
    """codecov.CodeCovDiffCoverageTool:jobId 必填，moduleName 可选。"""
    return {
        'jobId': _required_text(job_id, 'jobId'),
        **({'moduleName': str(module_name)} if module_name else {}),
    }
