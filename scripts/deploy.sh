#!/usr/bin/env bash
# mfc-deploy: 一键部署 mae-flow-cloud 到远端服务器
# 用法: .pi/skills/mfc-deploy/scripts/deploy.sh [--env test|prod|all] [--skip-local-check]
#
# 两套环境完全独立：
#   生产: /data/mae-flow-cloud/{repo,data,cache,logs} + /etc/mae-flow-cloud/
#   测试: /data/mae-flow-cloud-test/{repo,data,cache,logs} + /etc/mae-flow-cloud-test/
#   测试环境不管咋更新代码重启服务，不影响生产环境
#
# 退出码: 0=成功, 1=本地验证失败, 2=远端操作失败

set -euo pipefail

REMOTE_HOST="7.242.244.33"
REMOTE_USER="root"
REMOTE_PASS="Changeme_456"
LOCAL_REPO="/home/y00965296/code/mae-flow-cloud"
NODE24="/usr/local/node-v24.19.0-linux-x64"

SSH_CMD="sshpass -p '${REMOTE_PASS}' ssh -o ConnectTimeout=30 -o StrictHostKeyChecking=no ${REMOTE_USER}@${REMOTE_HOST}"

# ─── 参数解析 ───
ENV="test"
SKIP_LOCAL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)    ENV="$2"; shift 2 ;;
        --skip-local-check) SKIP_LOCAL=true; shift ;;
        *) echo "用法: $0 [--env test|prod|all] [--skip-local-check]"; exit 1 ;;
    esac
done

case "$ENV" in
    test|prod|all) ;;
    *) echo "❌ --env 只能是 test|prod|all，收到: $ENV"; exit 1 ;;
esac

# ─── 环境参数表 ───
# 根据 --env 决定操作哪套目录和服务
declare -A ENV_ROOT ENV_DATA ENV_CONFIG ENV_LOGS
declare -A PROD_SERVICES TEST_SERVICES
PROD_SERVICES[serve]="mae-flow-serve"
PROD_SERVICES[adapter]="mae-flow-adapter"
PROD_SERVICES[bridge]="mae-flow-luban-bridge"
TEST_SERVICES[serve]="mae-flow-serve-test"
TEST_SERVICES[adapter]="mae-flow-adapter-test"
TEST_SERVICES[bridge]="mae-flow-luban-bridge-test"

PROD_ROOT="/data/mae-flow-cloud"
TEST_ROOT="/data/mae-flow-cloud-test"
PROD_CONFIG="/etc/mae-flow-cloud"
TEST_CONFIG="/etc/mae-flow-cloud-test"

# 需要停/起的服务列表
STOP_SERVICES=()
START_SERVICES=()
# 需要同步代码的 repo 列表
SYNC_ROOTS=()

case "$ENV" in
    prod)
        STOP_SERVICES=(${PROD_SERVICES[bridge]} ${PROD_SERVICES[adapter]} ${PROD_SERVICES[serve]})
        START_SERVICES=(${PROD_SERVICES[serve]} ${PROD_SERVICES[adapter]} ${PROD_SERVICES[bridge]})
        SYNC_ROOTS=("$PROD_ROOT")
        ;;
    test)
        STOP_SERVICES=(${TEST_SERVICES[bridge]} ${TEST_SERVICES[adapter]} ${TEST_SERVICES[serve]})
        START_SERVICES=(${TEST_SERVICES[serve]} ${TEST_SERVICES[adapter]} ${TEST_SERVICES[bridge]})
        SYNC_ROOTS=("$TEST_ROOT")
        ;;
    all)
        STOP_SERVICES=(
            ${PROD_SERVICES[bridge]} ${PROD_SERVICES[adapter]} ${PROD_SERVICES[serve]}
            ${TEST_SERVICES[bridge]} ${TEST_SERVICES[adapter]} ${TEST_SERVICES[serve]}
        )
        START_SERVICES=(
            ${PROD_SERVICES[serve]} ${PROD_SERVICES[adapter]} ${PROD_SERVICES[bridge]}
            ${TEST_SERVICES[serve]} ${TEST_SERVICES[adapter]} ${TEST_SERVICES[bridge]}
        )
        SYNC_ROOTS=("$PROD_ROOT" "$TEST_ROOT")
        ;;
esac

# 需要校验 auth.json / 坏档扫描 / __pycache__ 清理的 data 目录
declare -A CHECK_DATA_DIRS
case "$ENV" in
    prod) CHECK_DATA_DIRS[prod]="$PROD_ROOT/data" ;;
    test) CHECK_DATA_DIRS[test]="$TEST_ROOT/data" ;;
    all)  CHECK_DATA_DIRS[prod]="$PROD_ROOT/data"; CHECK_DATA_DIRS[test]="$TEST_ROOT/data" ;;
esac

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; exit 2; }

echo -e " ${CYAN}部署环境: $ENV${NC}"
echo ""

# ─── Step 1: 本地验证 ───
echo "═══════════════════════════════════════"
echo " Step 1: 本地拉代码 & 验证"
echo "═══════════════════════════════════════"

cd "$LOCAL_REPO"

if [ "$SKIP_LOCAL" = false ]; then
    git pull --ff-only || fail "git pull 失败"
    npm run typecheck || fail "typecheck 失败，不部署"
    ok "typecheck 通过"
else
    warn "跳过本地验证 (--skip-local-check)"
fi

LOCAL_COMMIT=$(git rev-parse --short HEAD)
ok "本地版本: $LOCAL_COMMIT"

# ─── Step 2: 远端停服务 & 备份 ───
echo ""
echo "═══════════════════════════════════════"
echo " Step 2: 远端停服务 & 备份 [$ENV]"
echo "═══════════════════════════════════════"

eval "$SSH_CMD" bash << REMOTE_STEP2
set -e

# SIGTERM 停指定环境的服务
echo "  停止服务: ${STOP_SERVICES[*]}"
systemctl stop ${STOP_SERVICES[*]} 2>/dev/null || true
echo "  服务已停止"

# 检查 detached git push
GIT_PUSH_COUNT=\$(ps -eo pid,ppid,etime,command | grep -c "[g]it push" || true)
if [ "\$GIT_PUSH_COUNT" -gt 0 ]; then
    echo "  ⚠ 检测到 \$GIT_PUSH_COUNT 个 git push 进程仍在跑，等待完成（≤5分钟预算）…"
    ps -eo pid,ppid,etime,command | grep "[g]it push"
    for i in \$(seq 1 30); do
        sleep 10
        GIT_PUSH_COUNT=\$(ps -eo pid,ppid,etime,command | grep -c "[g]it push" || true)
        if [ "\$GIT_PUSH_COUNT" -eq 0 ]; then
            echo "  git push 已全部完成"
            break
        fi
        if [ "\$i" -eq 30 ]; then
            echo "  ⚠ 等待超时（5分钟），仍有 \$GIT_PUSH_COUNT 个 git push"
        fi
    done
else
    echo "  无残留 git push 进程"
fi

# 备份各环境的 auth.json
for DATA_DIR in ${CHECK_DATA_DIRS[*]}; do
    AUTH_FILE="\$DATA_DIR/auth.json"
    if [ -f "\$AUTH_FILE" ]; then
        BACKUP_DIR="\$DATA_DIR/.deploy-backup"
        mkdir -p "\$BACKUP_DIR"
        TIMESTAMP=\$(date +%Y%m%d-%H%M%S)
        cp -a "\$AUTH_FILE" "\$BACKUP_DIR/auth.json.\${TIMESTAMP}"
        echo "  \$(basename \$DATA_DIR)/auth.json 已备份"
        ls -t "\$BACKUP_DIR"/auth.json.* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
    fi
done
REMOTE_STEP2

ok "服务已停止，auth.json 已备份"

# ─── Step 3: rsync 代码 ───
echo ""
echo "═══════════════════════════════════════"
echo " Step 3: rsync 代码 [$ENV]"
echo "═══════════════════════════════════════"

for ROOT in "${SYNC_ROOTS[@]}"; do
    echo "  → ${ROOT}/repo/"
    rsync -az \
      -e "sshpass -p '${REMOTE_PASS}' ssh -o StrictHostKeyChecking=no" \
      --delete \
      --exclude='node_modules' \
      --exclude='.git' \
      --exclude='.pilot' \
      --exclude='.local' \
      "${LOCAL_REPO}/" \
      "${REMOTE_USER}@${REMOTE_HOST}:${ROOT}/repo/"
done

ok "代码已同步"

# ─── Step 4: 校验 auth.json ───
echo ""
echo "═══════════════════════════════════════"
echo " Step 4: 校验 auth.json"
echo "═══════════════════════════════════════"

eval "$SSH_CMD" bash << REMOTE_STEP4
for DATA_DIR in ${CHECK_DATA_DIRS[*]}; do
    AUTH_FILE="\$DATA_DIR/auth.json"
    BACKUP_DIR="\$DATA_DIR/.deploy-backup"
    if [ -f "\$AUTH_FILE" ]; then
        USER_COUNT=\$(python3 -c "import json; print(len(json.load(open('\$AUTH_FILE')).get('users',[])))" 2>/dev/null || echo "0")
        if [ "\$USER_COUNT" -le 1 ]; then
            echo "  ⚠ \$(basename \$DATA_DIR) auth.json 只有 \${USER_COUNT} 个用户，从备份恢复"
            LATEST=\$(ls -t "\$BACKUP_DIR"/auth.json.* 2>/dev/null | head -1)
            if [ -n "\$LATEST" ]; then
                cp -a "\$LATEST" "\$AUTH_FILE"
                echo "  已恢复: \$(basename \$LATEST)"
            fi
        else
            echo "  \$(basename \$DATA_DIR): 完整 (\${USER_COUNT} 个用户)"
        fi
    fi
done
REMOTE_STEP4

ok "auth.json 校验完成"

# ─── Step 5: 远端清理 & 安装 ───
echo ""
echo "═══════════════════════════════════════"
echo " Step 5: 远端清理 & 安装 [$ENV]"
echo "═══════════════════════════════════════"

eval "$SSH_CMD" bash << REMOTE_STEP5
set -e

for ROOT in ${SYNC_ROOTS[@]}; do
    echo "  --- \$(basename \$ROOT) ---"
    echo "  清 __pycache__"
    find \$ROOT/repo/kernel -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true

    echo "  npm ci"
    cd \$ROOT/repo
    npm ci 2>&1 | tail -2

    echo "  web npm ci"
    export PATH=/usr/local/node-v24.19.0-linux-x64/bin:\$PATH
    cd web
    npm ci 2>&1 | tail -2

    echo "  web build (node24)"
    npx vite build 2>&1 | tail -3

    echo "  确保日志目录存在"
    mkdir -p \$ROOT/logs
    touch \$ROOT/logs/serve.log \$ROOT/logs/adapter.log \$ROOT/logs/luban-bridge.log
done
REMOTE_STEP5

ok "清理 & 安装完成"

# ─── Step 6: 重启服务 ───
echo ""
echo "═══════════════════════════════════════"
echo " Step 6: 重启服务 [$ENV]"
echo "═══════════════════════════════════════"

eval "$SSH_CMD" bash << REMOTE_STEP6
set -e

systemctl daemon-reload

# 按顺序启动：serve 先起（等它 ready），再 adapter，再 bridge
# all 模式：先 prod，再 test
for SVC in ${START_SERVICES[*]}; do
    systemctl start \$SVC
    if echo \$SVC | grep -q "serve"; then
        sleep 4
    else
        sleep 2
    fi
done

echo "=== 服务状态 ==="
systemctl is-active ${START_SERVICES[*]}
REMOTE_STEP6

ok "服务已重启"

# ─── Step 7: 部署后验证 ───
echo ""
echo "═══════════════════════════════════════"
echo " Step 7: 部署验证 [$ENV]"
echo "═══════════════════════════════════════"

eval "$SSH_CMD" bash << REMOTE_STEP7

# HTTP 检查
echo "=== HTTP 检查 ==="
case "$ENV" in
    prod|all)
        curl -s -o /dev/null -w "  生产 serve(8787):   %{http_code}\n" http://localhost:8787/
        curl -s -o /dev/null -w "  生产 adapter(8790): %{http_code}\n" http://localhost:8790/health
        ;;
esac
case "$ENV" in
    test|all)
        curl -s -o /dev/null -w "  测试 serve(8788):   %{http_code}\n" http://localhost:8788/
        curl -s -o /dev/null -w "  测试 adapter(8792): %{http_code}\n" http://localhost:8792/health
        ;;
esac

# 启动日志
echo ""
echo "=== 启动日志 ==="
case "$ENV" in
    prod|all)
        journalctl -u mae-flow-serve --since "2 min ago" --no-pager \
          | grep -E "已清理遗留|恢复任务|实例锁|ownership|拒绝启动|已对外监听" | sed 's/^/  生产: /' || echo "  生产: (无异常关键词)"
        ;;
esac
case "$ENV" in
    test|all)
        journalctl -u mae-flow-serve-test --since "2 min ago" --no-pager \
          | grep -E "已清理遗留|恢复任务|实例锁|ownership|拒绝启动|已对外监听" | sed 's/^/  测试: /' || echo "  测试: (无异常关键词)"
        ;;
esac

# 坏档扫描
echo ""
echo "=== 坏档扫描 ==="
BAD=0
for DATA_DIR in ${CHECK_DATA_DIRS[*]}; do
    for f in \$DATA_DIR/task-*/task.json; do
        if ! python3 -m json.tool "\$f" >/dev/null 2>&1; then
            echo "  ⚠ 坏档: \$f"
            BAD=\$((BAD+1))
        fi
    done
    for f in \$DATA_DIR/task-*/waiting.json; do
        if [ -f "\$f" ] && ! python3 -m json.tool "\$f" >/dev/null 2>&1; then
            echo "  ⚠ 坏档: \$f"
            BAD=\$((BAD+1))
        fi
    done
done
if [ "\$BAD" -eq 0 ]; then echo "  全部 task.json / waiting.json 完整"; fi

# 旧 issue 容器
echo ""
echo "=== 旧 issue 容器 ==="
ORPHANS=\$(docker ps -a \
  --filter label=com.mae-flow-cloud.role=issue \
  --format '{{.Names}}\t{{.Status}}\t{{.Label "com.mae-flow-cloud.instance"}}' \
  | awk -F'\t' '\$3==""')
if [ -n "\$ORPHANS" ]; then
    echo "  ⚠ 发现无 instance 标签的旧 issue 容器:"
    echo "\$ORPHANS" | sed 's/^/    /'
    echo "  ⚠ 请逐个确认：Up=活会话；Exited=安全可删(docker rm <名字>)"
else
    echo "  无旧 issue 容器残留"
fi

# auth.json
echo ""
echo "=== auth.json ==="
for DATA_DIR in ${CHECK_DATA_DIRS[*]}; do
    AUTH_FILE="\$DATA_DIR/auth.json"
    if [ -f "\$AUTH_FILE" ]; then
        python3 -c "
import json
d=json.load(open('\$AUTH_FILE'))
users=[u['username'] for u in d.get('users',[])]
print(f'  \$(basename \$DATA_DIR): {len(users)} 个账号')
"
    fi
done
REMOTE_STEP7

echo ""
echo "═══════════════════════════════════════"
echo -e " ${GREEN}部署完成${NC} [${ENV}]: ${LOCAL_COMMIT}"
echo "═══════════════════════════════════════"
echo ""
echo -e " ${YELLOW}部署后请发公告${NC}(小鲁班/IM):"
echo "  1. 浏览器请强制刷新（Cmd/Ctrl+Shift+R）"
echo "  2. 登录会话已落盘，重启不踢人"
if [ "$ENV" = "prod" ] || [ "$ENV" = "all" ]; then
echo "  3. 生产环境已重启，如有等待审批任务请检查通知——页面待办清单为准"
fi