#!/usr/bin/env bash
# SHA 精确查询、复用已有运行；仅对失败/取消的流水线尝试 rerun。
# 参数: repo_path(URL 编码或普通项目路径) sha token [mr_iid]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/pipeline_trigger.py" "$@"
