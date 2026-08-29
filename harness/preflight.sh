#!/usr/bin/env bash
# 上线自查(部署手册「上线自查清单」的可执行版)。
#
# 原则:退出码真实核验,不许管道吞码;做不了的项显式 SKIP 并说明
# 在哪补——静默跳过等于假装测过,比没测更糟。
#
# 用法(在 mae-flow-cloud 仓根执行):
#   harness/preflight.sh                      # 只跑本机可判的项
#   harness/preflight.sh --models <json> --provider <名>
#                                             # 加:网关连通(1 token 探针)
#
# 清单项 5(真需求走到 await_merge)与 6(杀进程重启恢复)是人工/
# 演练动作,脚本最后原样提醒,不假装能自动化。

set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; SKIP=0
ok()   { echo "✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "❌ $1"; FAIL=$((FAIL+1)); }
skip() { echo "⏭️  $1"; SKIP=$((SKIP+1)); }

MODELS=""; PROVIDER=""; ISOLATE_IMAGE=""; ADAPTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --models)        MODELS=$2;        shift 2 ;;
    --provider)      PROVIDER=$2;      shift 2 ;;
    --isolate-image) ISOLATE_IMAGE=$2; shift 2 ;;
    --adapter)       ADAPTER=$2;       shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

echo "== 上线自查 =="

# 0. 收编内核来源。运行时和测试默认使用仓内快照；VENDORED 里的 SHA
# 是来源元数据，不冒充逐文件一致性证明。有兄弟内核时核对来源提交与
# 工作树状态，后面的 probe 再直接验证仓内快照的实际能力。
VENDORED_FILE="kernel/VENDORED"
VENDORED_SHA=""
VENDORED_REF=""
if [ -f "$VENDORED_FILE" ]; then
  VENDORED_SHA=$(sed -n 's/^来源: mae-flow@//p' "$VENDORED_FILE" | head -n 1)
  VENDORED_REF=$(sed -n 's/^分支: //p' "$VENDORED_FILE" | head -n 1)
fi
if ! printf '%s' "$VENDORED_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  bad "0. 仓内内核快照缺少有效来源 SHA(harness/sync-kernel.sh 刷新)"
elif [ -z "$VENDORED_REF" ]; then
  bad "0. 仓内内核快照缺少来源分支(harness/sync-kernel.sh 刷新)"
elif [ -d "../mae-flow/.git" ]; then
  LIVE_SHA=$(git -C ../mae-flow rev-parse HEAD 2>/dev/null || true)
  LIVE_REF=$(git -C ../mae-flow symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')
  LIVE_DIRTY=$(git -C ../mae-flow status --porcelain 2>/dev/null || true)
  if [ -n "$LIVE_DIRTY" ]; then
    bad "0. 兄弟内核有未提交改动，收编快照无法代表当前测试内容"
  elif [ "$VENDORED_SHA" != "$LIVE_SHA" ]; then
    bad "0. 仓内内核快照落后(运行 harness/sync-kernel.sh 后再发布)"
  elif [ "$VENDORED_REF" != "$LIVE_REF" ]; then
    bad "0. 仓内内核来源分支不一致:快照 $VENDORED_REF，兄弟仓 $LIVE_REF"
  else
    ok "0. 仓内内核快照与 mae-flow ${VENDORED_REF}@${VENDORED_SHA%????????????????????????????} 对齐;实际能力由 probe 验证"
  fi
else
  ok "0. 仓内内核快照来源可追溯(${VENDORED_REF}@${VENDORED_SHA%????????????????????????????})"
fi

# 1. 隔离镜像体检：容器只提供安全边界，python3/git 是转发壳与提交链
# 的硬依赖；编译、UT 运行和 CodeCheck 不在这里执行。
if [ -n "$ISOLATE_IMAGE" ] && command -v docker >/dev/null; then
  if docker run --rm "$ISOLATE_IMAGE" sh -lc \
       'command -v python3 && command -v git' > /tmp/preflight-image.log 2>&1; then
    ok "1. 隔离镜像含 python3+git($ISOLATE_IMAGE)"
  else
    bad "1. 隔离镜像缺 python3/git(转发壳跑不了;日志 /tmp/preflight-image.log)"
  fi
elif [ -n "$ISOLATE_IMAGE" ]; then
  bad "1. 给了 --isolate-image 但本机没有 docker"
else
  skip "1. 隔离镜像体检:给 --isolate-image 后执行"
fi

# 2. 全量测试
if npm test > /tmp/preflight-test.log 2>&1; then
  ok "2. npm test 全绿($(grep -c '^✔' /tmp/preflight-test.log) 项)"
else
  bad "2. npm test 有红(日志 /tmp/preflight-test.log)"
fi

# 2.5 类型检查(零构建的代价:tsx 不看类型,字段名写错会静默变
# undefined——实测吃过一次,靠端到端断言才逮住。门立在这里)
if npm run typecheck > /tmp/preflight-types.log 2>&1; then
  ok "2.5 npm run typecheck 无错"
else
  bad "2.5 类型检查有错(日志 /tmp/preflight-types.log)"
fi

# 2.6 前端能构建(web/ 是唯一有构建的目录;构建挂了界面就是白屏)
if [ -d web/node_modules ]; then
  if (cd web && npm run build > /tmp/preflight-web.log 2>&1); then
    ok "2.6 web 构建通过"
  else
    bad "2.6 web 构建失败(日志 /tmp/preflight-web.log)"
  fi
else
  skip "2.6 web 构建:先在 web/ 执行 npm install"
fi

# 3. probe 整链演练。这里故意覆盖发现顺序，强制使用发布包里的
# kernel/，不能再让兄弟活内核替旧快照把上线自检“考绿”。
if MAE_FLOW_HOME="$PWD/kernel" npm run probe > /tmp/preflight-probe.log 2>&1; then
  ok "3. probe 九项事实全绿(仓内收编内核裁判)"
else
  bad "3. 仓内收编内核 probe 失败(日志 /tmp/preflight-probe.log)"
fi

# 4. 网关连通(1 token 探针:验证地址与鉴权,不烧正经额度)
if [ -n "$MODELS" ] && [ -n "$PROVIDER" ]; then
  STATUS=$(python3 - "$MODELS" "$PROVIDER" <<'PY'
import json, sys, urllib.request
cfg = json.load(open(sys.argv[1]))["providers"][sys.argv[2]]
req = urllib.request.Request(
    cfg["baseUrl"].rstrip("/") + "/v1/messages",
    data=json.dumps({"model": cfg["models"][0]["id"], "max_tokens": 1,
                     "messages": [{"role": "user", "content": "ping"}]}
                    ).encode(),
    headers={"content-type": "application/json",
             "x-api-key": cfg.get("apiKey", ""),
             "anthropic-version": "2023-06-01"})
try:
    print(urllib.request.urlopen(req, timeout=30).status)
except Exception as err:
    print(getattr(err, "code", str(err)))
PY
)
  if [ "$STATUS" = "200" ]; then
    ok "4. 网关连通(HTTP 200)"
  else
    bad "4. 网关探针异常: $STATUS(429=限额,401/403=鉴权,其他看网关)"
  fi
else
  skip "4. 网关连通:给 --models 与 --provider 后执行"
fi

# 4.5 适配层可达(进场项:--adapter http://127.0.0.1:8790)。只打
# 根路径冒烟——契约字段的真对拍走 adapter --selftest,这里不重复。
# --noproxy '*':适配层是内网/回环服务,绝不该走公司代理——代理截
# 内网请求正是报告里 push 撞 504 的同款失败模式(本机实测:代理连
# 127.0.0.1 都截,不加这个假阴性)。
if [ -n "$ADAPTER" ]; then
  BODY=$(curl -sf --noproxy '*' --max-time 10 "$ADAPTER/" \
    2>/tmp/preflight-adapter.log)
  if [ -n "$BODY" ] && printf '%s' "$BODY" | grep -q '"ok"'; then
    ok "4.5 适配层可达($ADAPTER)"
    echo "     契约对拍另跑: npm run adapter -- --config adapter.json --selftest ..."
  else
    bad "4.5 适配层不可达或响应异常($ADAPTER;日志 /tmp/preflight-adapter.log)"
  fi
else
  skip "4.5 适配层可达:给 --adapter <url> 后执行(内网进场项)"
fi

echo
echo "人工项(脚本不假装能自动化):"
echo "  5. 发一单真需求走到 await_merge,MR 出现在真平台上;"
echo "  6. 杀进程重启恢复——已有可执行演练:harness/restart-drill.sh"
echo "     (真 kill -9 真 HTTP;语义测试另见 tests/recovery.test.ts)。"
echo
echo "结果: ✅ $PASS  ❌ $FAIL  ⏭️ $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
