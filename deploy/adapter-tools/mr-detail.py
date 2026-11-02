#!/usr/bin/env python3
"""Read the MR and authoritative repository clone address for independent repair."""
import json
import os
import re
import sys
import urllib.parse
import urllib.request


class DetailError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise DetailError('代码平台详情请求发生跳转，请管理员检查平台地址')


try:
    mr_url, token = sys.argv[1:]
    mr = urllib.parse.urlsplit(mr_url)
    api = urllib.parse.urlsplit(os.environ.get('MFC_CODEHUB_API', 'https://codehub-y.huawei.com/api/v4').rstrip('/'))
    if mr.scheme not in ('http', 'https') or mr.netloc != api.netloc or mr.username or mr.password:
        raise DetailError('MR 链接必须属于已配置的代码平台')
    match = re.fullmatch(r'/(.+?)/(?:-/)?merge_requests/([1-9][0-9]*)/?', mr.path)
    if not match:
        raise DetailError('MR 链接格式无效')
    project, iid = match.groups()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def get(path):
        url = urllib.parse.urlunsplit((api.scheme, api.netloc, api.path + path, '', ''))
        request = urllib.request.Request(url, headers={'Private-Token': token})
        with opener.open(request, timeout=4) as response:
            value = json.load(response)
        if not isinstance(value, dict):
            raise DetailError('代码平台详情不是对象')
        return value

    detail = get('/projects/' + urllib.parse.quote(urllib.parse.unquote(project), safe='') + '/merge_requests/' + iid)
    if str(detail.get('iid')) != iid:
        raise DetailError('MR 详情与链接不匹配')
    source_id, target_id = detail.get('source_project_id'), detail.get('target_project_id')
    if not isinstance(source_id, int) or source_id != target_id:
        raise DetailError('当前流水线修复仅支持同一仓库内的 MR')
    repo = get('/projects/' + str(source_id))
    if repo.get('id') != source_id or not repo.get('http_url_to_repo'):
        raise DetailError('平台未返回源仓库的 HTTPS 克隆地址')
    print(json.dumps(dict(url=detail.get('web_url'), iid=iid, title=detail.get('title'),
        repo=repo['http_url_to_repo'], source_branch=detail.get('source_branch'),
        target_branch=detail.get('target_branch'), sha=detail.get('sha'), state=detail.get('state')), ensure_ascii=False))
except Exception as error:
    message = str(error) if isinstance(error, DetailError) else type(error).__name__
    print('MR 详情查询失败: ' + message, file=sys.stderr)
    sys.exit(1)
