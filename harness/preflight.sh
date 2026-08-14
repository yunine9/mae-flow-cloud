#!/usr/bin/env bash
# 上线自查(部署手册「上线自查清单」的可执行版)。
#
# 原则:退出码真实核验,不许管道吞码;做不了的项显式 SKIP 并说明
# 在哪补——静默跳过等于假装测过,比没测更糟。
#
# 用法(在 mae-flow-cloud 仓根执行):
#   harness/preflight.sh                      # 只跑本机可判的项
#   harness/preflight.sh --java-repo <dir>    # 加:容器内 mvn 编译验证
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

JAVA_REPO=""; MODELS=""; PROVIDER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --java-repo) JAVA_REPO=$2; shift 2 ;;
    --models)    MODELS=$2;    shift 2 ;;
    --provider)  PROVIDER=$2;  shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

echo "== 上线自查 =="

# 1. 容器内编译验证(目标镜像里跑才算数;外部这里是模拟演练)
if [ -n "$JAVA_REPO" ] && command -v docker >/dev/null; then
  if docker run --rm -v "$(cd "$JAVA_REPO" && pwd)":/src -w /src \
       maven:3.8-eclipse-temurin-8 \
       bash -c 'mvn -B -q clean compile && mvn -B -q clean test' \
       > /tmp/preflight-mvn.log 2>&1; then
    ok "1. 容器内 mvn compile+test 退出码 0"
  else
    bad "1. 容器内 mvn 失败(日志 /tmp/preflight-mvn.log)"
  fi
else
  skip "1. 容器内编译验证:给 --java-repo 且装 docker 后执行;内网在目标镜像里做最终裁决"
fi

# 2. 全量测试
if npm test > /tmp/preflight-test.log 2>&1; then
  ok "2. npm test 全绿($(grep -c '^✔' /tmp/preflight-test.log) 项)"
else
  bad "2. npm test 有红(日志 /tmp/preflight-test.log)"
fi

# 3. probe 整链演练(内核裁判在场)
if npm run probe > /tmp/preflight-probe.log 2>&1; then
  ok "3. probe 九项事实全绿(内核裁判)"
else
  bad "3. probe 失败(日志 /tmp/preflight-probe.log)"
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

echo
echo "人工项(脚本不假装能自动化):"
echo "  5. 发一单真需求走到 await_merge,MR 出现在真平台上;"
echo "  6. 杀进程重启,确认等待中的任务还在、决定后能续跑"
echo "     (语义已有测试兜底:tests/recovery.test.ts,线上仍需演练一次)。"
echo
echo "结果: ✅ $PASS  ❌ $FAIL  ⏭️ $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
