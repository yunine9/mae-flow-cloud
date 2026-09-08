"""CodeHub trigger adapter. Errors exit nonzero so the adapter returns 502."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ACTIVE = {'running', 'pending', 'created', 'preparing', 'waiting_for_resource'}
RETRYABLE = {'failed', 'canceled'}


class Trigger:
    def __init__(self, project, sha, token, mr=''):
        if not re.fullmatch(r'[0-9a-fA-F]{40}|[0-9a-fA-F]{64}', sha):
            raise ValueError('必须提供完整提交 SHA')
        self.sha = sha.lower()
        self.token = token
        self.mr = mr
        self.project = urllib.parse.unquote(project)
        self.api = os.environ.get('MFC_CODEHUB_API', 'https://codehub-y.huawei.com/api/v4').rstrip('/')
        self.base = self.api + '/projects/' + urllib.parse.quote(self.project, safe='')
        self.host = os.environ.get('MFC_CODEHUB_CLI_HOST', 'yellow')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        # 宿主 trigger 默认超时 30 秒，整个查询/触发流程共用预算。
        self.deadline = time.monotonic() + 25

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('流水线触发超过 25 秒预算')
        return remaining

    def get(self, suffix, **query):
        url = self.base + suffix + '?' + urllib.parse.urlencode(query)
        request = urllib.request.Request(url, headers={'Private-Token': self.token})
        with self.opener.open(request, timeout=self.remaining()) as response:
            return json.load(response)

    def latest(self):
        rows = self.get('/pipelines', sha=self.sha, per_page=100, order_by='id', sort='desc')
        if not isinstance(rows, list) or not rows:
            raise ValueError('未找到该 SHA 的流水线；push 自动创建可能尚未完成，请稍后重试')
        if len(rows) >= 100:
            raise ValueError('该 SHA 流水线过多，无法排除分支歧义')
        if any(not isinstance(p, dict) or p.get('sha', '').lower() != self.sha for p in rows):
            raise ValueError('流水线查询返回了不匹配的 SHA')
        if len({p.get('ref') for p in rows}) != 1 or not rows[0].get('ref'):
            raise ValueError('同一 SHA 的流水线分支不唯一或缺失，拒绝猜测')
        if any(not str(p.get('id', '')).isdigit() for p in rows):
            raise ValueError('流水线 id 缺失或无效')
        return max(rows, key=lambda p: int(p['id']))

    def mr_iid(self, pipeline):
        rows = self.get('/merge_requests', source_branch=pipeline['ref'], state='opened', per_page=100)
        if not isinstance(rows, list) or len(rows) >= 100:
            raise ValueError('MR 查询结果无效或不完整')
        rows = [m for m in rows if isinstance(m, dict)
                and m.get('source_branch') == pipeline['ref']
                and m.get('state') == 'opened']
        if self.mr:
            rows = [m for m in rows if str(m.get('iid')) == self.mr]
        if len(rows) != 1:
            raise ValueError('无法唯一确定 MR iid，拒绝重跑')
        mr = rows[0]
        if mr.get('sha') and mr['sha'].lower() != self.sha:
            raise ValueError('MR 头提交已变化，拒绝重跑旧提交')
        if (mr.get('source_project_id') is not None and mr.get('target_project_id') is not None
                and mr['source_project_id'] != mr['target_project_id']):
            raise ValueError('跨项目 MR 需要显式适配，拒绝按分支名猜测')
        if not str(mr.get('iid', '')).isdigit():
            raise ValueError('MR iid 无效')
        return str(mr['iid'])

    def result(self, pipeline):
        # 触发端只确认已有/已受理的运行，质量终态统一由 status 端取证。
        return {'status': 'running', 'id': pipeline['id'], 'sha': self.sha}

    def run(self):
        pipeline = self.latest()
        status = pipeline.get('status')
        if status in ACTIVE or status == 'success':
            return self.result(pipeline)
        if status not in RETRYABLE:
            raise ValueError('流水线状态不支持自动重跑: ' + str(status))
        iid = self.mr_iid(pipeline)
        try:
            process = subprocess.run(
                ['codehub-cli', 'pipeline', 'rerun', str(pipeline['id']),
                 '--host', self.host, '--project', self.project, '--mr', iid,
                 '--format', 'json', '-k'],
                env={**os.environ, 'CODEHUB_TOKEN': self.token},
                capture_output=True, text=True, timeout=self.remaining())
            if process.returncode:
                # 不输出 CLI 原始错误，避免其回显凭据。
                raise RuntimeError('codehub-cli rerun 退出码 ' + str(process.returncode))
            result = json.loads(process.stdout)
            if not isinstance(result, dict) or result.get('status') not in ACTIVE | {'success'}:
                raise ValueError('rerun 未返回有效受理状态')
            if not str(result.get('id', '')).isdigit():
                raise ValueError('rerun 未返回有效流水线 id')
            if result.get('sha', '').lower() != self.sha:
                raise ValueError('rerun 返回 SHA 缺失或不匹配')
            return self.result(result)
        except Exception as error:
            # 422/超时/响应损坏不能证明正在运行；必须重新读取平台事实。
            try:
                current = self.latest()
                if current['ref'] == pipeline['ref'] and current.get('status') in ACTIVE:
                    return self.result(current)
            except Exception:
                pass
            raise RuntimeError('重跑未确认受理: ' + str(error)) from None


def main():
    token = sys.argv[3] if len(sys.argv) > 3 else ''
    try:
        if len(sys.argv) not in (4, 5):
            raise ValueError('用法: pipeline-trigger.sh repo_path sha token [mr_iid]')
        print(json.dumps(Trigger(*sys.argv[1:]).run(), ensure_ascii=False))
    except Exception as error:
        message = str(error)
        if token:
            message = message.replace(token, '***')
        print('[pipeline-trigger] ' + message[:500], file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
