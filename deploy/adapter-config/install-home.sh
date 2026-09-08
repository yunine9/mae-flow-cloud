#!/usr/bin/env bash
# 安装当前内网 root 服务的 HOME 配置；不重启服务。
set -euo pipefail
ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  test) SERVICE=mae-flow-adapter-test ;;
  prod) SERVICE=mae-flow-adapter ;;
  *) echo '用法: sudo bash install-home.sh test|prod' >&2; exit 1 ;;
esac
SERVICE_USER="$(systemctl show "$SERVICE" --property=User --value)"
LOAD_STATE="$(systemctl show "$SERVICE" --property=LoadState --value)"
if [[ "$LOAD_STATE" != loaded || ( -n "$SERVICE_USER" && "$SERVICE_USER" != root ) ]]; then
  echo '只支持已存在且以 root 运行的 adapter 服务；其他用户需配置其实际 HOME。' >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="/etc/systemd/system/${SERVICE}.service.d"
install -d -m 755 "$DEST"
if [[ -f "$DEST/home.conf" ]]; then
  cp -p "$DEST/home.conf" "$DEST/home.conf.bak.$(date +%Y%m%d%H%M%S)"
fi
install -m 644 "$SCRIPT_DIR/home.conf" "$DEST/home.conf"
systemctl daemon-reload
printf '已安装 %s/home.conf；重启服务后生效。\n' "$DEST"
