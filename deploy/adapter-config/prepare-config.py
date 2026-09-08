#!/usr/bin/env python3
"""Merge the versioned repair into a separate candidate config; never overwrite live config."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--repo-dir', required=True, type=Path)
args = parser.parse_args()
config = json.loads(args.input.read_text())
repo = args.repo_dir.resolve()
patch = json.loads((Path(__file__).parent / 'mr-pipeline.patch.json').read_text())
for spec in patch.values():
    spec['command'] = [part.replace('@REPO_DIR@', str(repo)) for part in spec['command']]
    if spec['command'][0] == 'bash' and not Path(spec['command'][1]).is_file():
        parser.error('缺少脚本: ' + spec['command'][1])
command = config.get('mr_create', {}).get('command')
if not isinstance(command, list) or command[:3] != ['codehub-cli', 'mr', 'create']:
    parser.error('现有 mr_create 不是 codehub-cli mr create，请人工合并')
for flag, value in [('--host', 'yellow'), ('--project', '{repo}')]:
    if flag in command:
        index = command.index(flag)
        if index + 1 >= len(command):
            parser.error(flag + ' 缺少参数')
        command[index + 1] = value
    elif any(part.startswith(flag + '=') for part in command):
        parser.error('请先将 ' + flag + '=value 改为分开的参数')
    else:
        command.extend([flag, value])
# 保留端点的现场超时，以及已有 MCP/日志候选链。
for key, script_name in [('pipeline_status', 'pipeline-status.sh'),
                         ('pipeline_artifacts', 'pipeline-artifacts.sh')]:
    existing = config.get(key, {})
    if not isinstance(existing, dict):
        continue
    if 'timeout_s' in existing:
        patch[key]['timeout_s'] = existing['timeout_s']
    candidates = existing.get('candidates')
    if isinstance(candidates, list) and candidates:
        matches = [i for i, candidate in enumerate(candidates) if any(
            script_name in str(part) for part in candidate.get('command', []))]
        position = matches[0] if matches else min(1, len(candidates))
        retained = [candidate for i, candidate in enumerate(candidates) if i not in matches]
        retained.insert(position, patch[key])
        patch[key] = {**existing, 'candidates': retained}
config.update(patch)
# 独占创建且权限 0600：现场输入可能含令牌，候选不能公开或覆盖已有文件。
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump(config, output, ensure_ascii=False, indent=2)
    output.write('\n')
print('已生成候选配置: ' + str(args.output))
