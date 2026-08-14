# CLAUDE.md

Mae-Flow 云端服务:pi(pi-mono)进程内集成 + Mae-Flow 内核宿主适配。
读完 README 的「三条铁的边界」再动代码——那是本仓的宪法。

## 不可越的红线

- **内核唯一权威**:流程规则、门禁契约、证据判定只在 ../mae-flow
  (Python)。本仓一行判定逻辑都不复刻;TS 写现场,内核裁决。
  连"阶段→步骤"的映射都不许在 TS 侧再抄一份。
- **agent 不能因 harness 卡死**(用户拍板,大量实验验证):一切旁路
  (门禁超时、通知、投影、压缩、容器清理)一律 fail-open;凡引入
  等待必须带预算或超时,绝无无限等待。
- **阶段真相只在工作区 .mae-flow.json**:PostgreSQL 是投影不是第二
  个状态机;两者不一致以现场文件为准。
- **交付事实来自远端真实状态**(ls-remote/平台 API),不信任务自述;
  流水线结果绑 SHA,旧绿灯不背书新代码。
- **要隔离就真隔离**:容器起不来任务如实 failed,绝不静默降级回宿主。
- **诚实清单纪律**:README「已知边界」如实记录什么验证过、什么没有;
  失效的记录要显式勘误(如"本机直接编译已过"被 run7 揭穿后的写法)。

## 工程惯例

- 注释说人话、讲为什么(尤其"踩过的坑"),不写"这行干了什么";
  实测结论标注来源(如 "run3 实测"、"实测 502")。
- commit 信息:`type(scope): 中文一句话——机制/教训`,正文讲语义与
  实锤,不逐文件罗列。
- 测试即契约:真假件共同语义写在测试里;裁判尽量用真件(临时 PG
  集群、真 docker、真 kill -9),没有条件时**显式 skip 并明说**,
  静默跳过等于假装测过。
- 零构建:tsx 直跑,无 build 步;web/ 是唯一有构建的目录(Vite)。
- 前端不推断状态,一切文案来自任务 API 镜像;零外部依赖(内网可用)。

## 常用命令

```bash
npm test                 # 全量(需 docker/PG 的用例没有环境会显式 skip)
npm run probe            # 整链演练,内核裁判九项事实
npm run serve            # 演示模式(剧本假模型,每次清场)
npm run pilot -- --label <名>            # 真模型试跑(.local/models.json)
npm run pilot -- --resume <label>        # 断点续跑(quota 和进度都是钱)
harness/preflight.sh     # 上线自查 1~4 项;--java-repo/--isolate-image/--models 加项
harness/restart-drill.sh # 真 kill -9 重启演练
python3 harness/run-report.py .pilot/<label>   # 试跑现场一键对拍
```

## 本机环境的坑(细节见用户级记忆)

- 宿主无 JDK/mvn,Java 编译一律走容器(镜像 mfc-java-pilot:
  maven3.8+JDK8+git+python3,本地构建,Dockerfile 形状见部署手册)。
- docker 走 Colima:VM 只挂 $HOME(/var/folders 挂进去是空目录);
  **有容器任务在跑时绝不 colima start/stop 任何 profile**(会切
  docker context,活容器 exec 全灭,实测打死过一次续跑)。
- 试跑现场在 .pilot/(不删现场是纪律,目录按 label 隔离);
  bigmodel 有 5 小时限额,429 的 detail 里带重置时间。
