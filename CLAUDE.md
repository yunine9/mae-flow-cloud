# CLAUDE.md

Mae-Flow 云端服务:pi(pi-mono)进程内集成 + Mae-Flow 内核宿主适配。
读完 README 的「三条铁的边界」再动代码——那是本仓的宪法。

## 不可越的红线

- **向 Cloud 单仓维护迁移**（用户 2026-09-09 最新决定）：目标是逐步将
  内核业务逻辑迁入 Cloud，最终不再依赖独立内核仓。见
  `docs/adr/0019-cloud-owned-workflow-migration.md`。这项决定取代
  “规则永远只能在 Python 内核实现”的长期约束。按模块交接唯一实现与
  状态写入者，不双写、不复制已撤销门禁。当前仅确定迁移方案，尚未完成
  源码所有权与运行时切换；未迁模块仍沿用现有权威，不能直接绕过其登记。
  单仓接管时须同步退役整包覆盖脚本与兄弟仓新鲜度检查，避免覆盖本仓修复。
- **内核负责协调与事实，不是质量裁判**（用户 2026-09-09 拍板）：
  迁移切换前，../mae-flow (Python) 仍是现有流程规则的实现来源；
  完成模块交接后，以 Cloud 中该模块为唯一实现，不要求双仓重复修改。
  模板/关键词、指定 Agent、归档凭证、提交格式/写法/文件来源分类已撤销
  否决权；质量失败和缺失如实提示，不阻断 done，不重复索取人工授权。
  本地提交不另签许可，交付选哪些文件尊重人工选择；暂存与提交不改变
  正文时不作废审批。不得把这些历史守卫重新引入宿主或内核。
  权限、取消/接管、人的实际回答、真实推送/流水线事实仍执行原有边界。
  连"阶段→步骤"的映射都不许在 TS 侧再抄一份。
  例外是刻意的:问题流 v2(src/issueFlow/,docs/issue-flow.md)
  完全不进内核——单号门禁与阶段门禁在宿主工具里机械
  执行。问题处理走"固定流程"(宿主自己的阶段状态机+工具
  门禁+平台人工闸,#96 起是唯一路径,自由探索已整体移除);
  它的状态机是问题域自己的,与内核无关,别把它"修"回内核。
- **agent 不能因 harness 卡死**(用户拍板,大量实验验证):旁路
  (通知、投影、压缩、容器清理、面板、时间线)一律 fail-open;凡引入
  等待必须带预算或出路,绝无无限等待。
  **2026-08-20 勘误**:原文把"门禁超时"也列进旁路,现已不成立——
  保留的权限门禁与事实登记不是旁路,它们失败意味着"这次动作没人裁决、
  没人记账",放过去等于让未验证的动作过关。现在的口径是:
  基础设施故障(超时/起不来)先带预算重试(dispatch 三次),
  试不动了按 fail-closed 处理——拒绝该次工具调用或如实收口 failed,
  原因写进 detail 并通知人。"不许卡死"仍然成立,只是出路从"放行"
  改成了"如实停下让人接手";fail-closed 绝不允许无预算地干等。
- **阶段真相只在工作区 .mae-flow.json**:PostgreSQL 是投影不是第二
  个状态机;两者不一致以现场文件为准。
- **交付事实来自远端真实状态**(ls-remote/平台 API),不信任务自述;
  流水线结果绑 SHA,旧绿灯不背书新代码。
  **2026-09-08 用户确认**：平台外部人工合入默认可信，是任务完成的
  独立依据。合入后停止在途 writer，由可信宿主登记内核 close 并解锁
  下游；不得因源 SHA 与旧验证不同、旧流水线失败而拒绝完成。
  原验证结果保持原样，实际合入 SHA 单独记账，不能伪造 PASS。
- **明确人工授权必须贯穿执行链**（用户 2026-09-09 红线）：同一意图
  不因流程文件分类、提交拆分、命令写法或元数据换轮反复要求确认。
  授权范围是允许执行的上界，不是要求把全部脏文件一起提交；撤出误提交
  文件属于纠错，不能拿禁止新增该文件的规则拦截撤出。仅实际超出授权
  或审批内容有新的实质变化时重新确认，机械记账和状态同步由系统完成。
- **要隔离就真隔离**:容器起不来任务如实 failed,绝不静默降级回宿主。
- **诚实清单纪律**:README「已知边界」如实记录什么验证过、什么没有;
  失效的记录要显式勘误(如"本机直接编译已过"被 run7 揭穿后的写法)。
- **不考虑任何历史兼容性,只希望把下个版本做的更好**(用户 2026-08-28
  拍板):系统未上线、内部使用,没有在途数据也没有旧用户。改设计就改
  干净——不留迁移垫片、不背旧词表、不为"万一有旧现场"写兼容分支;
  发现历史包袱直接删,评审不拿"兼容性"当保留理由。

## 工程惯例

- 注释说人话、讲为什么(尤其"踩过的坑"),不写"这行干了什么";
  实测结论标注来源(如 "run3 实测"、"实测 502")。
- commit 信息:`type(scope): 中文一句话——机制/教训`,正文讲语义与
  实锤,不逐文件罗列。
- 测试即契约:真假件共同语义写在测试里;裁判尽量用真件(临时 PG
  集群、真 docker、真 kill -9),没有条件时**显式 skip 并明说**,
  静默跳过等于假装测过。
- 零构建:tsx 直跑,无 build 步;web/ 是唯一有构建的目录(Vite)。
  但零构建**不等于不查类型**:改完跑 `npm run typecheck`(tsx 不看
  类型,字段名写错会静默变 undefined——实测吃过亏)。
- 前端不推断状态,一切文案来自任务 API 镜像;零外部依赖(内网可用)。

## 常用命令

```bash
npm test                 # 全量(需 docker/PG 的用例没有环境会显式 skip)
npm run typecheck        # 零构建≠不查类型(tsx 不看类型,写错字段名会静默)
npm run gate             # 推送闸门:typecheck+web 构建+秒级契约测试(hooksPath=.githooks 则 push 前自动跑)
npm run fix-ratio -- 7   # 每周复测 fix 提交占比与重灾区文件;每周真模型演练清单见 docs/weekly-drill.md
npm run visual -- --out <目录>            # 五档宽度静态截图(先 cd web && npm run build);改 CSS 前后各截一次
npm run visual -- --compare <改前> <改后>   # 逐像素比对,任何差异都要能说出是哪条规则
npm run probe            # 整链演练,内核裁判九项事实
npm run serve            # 演示模式(剧本假模型;清场要显式 --fresh)
npm run pilot -- --label <名>            # 真模型试跑(.local/models.json)
npm run pilot -- --resume <label>        # 断点续跑(quota 和进度都是钱)
harness/preflight.sh     # 上线自查;--isolate-image/--models/--adapter 加项
harness/restart-drill.sh # 真 kill -9 重启演练
npx tsx harness/concurrency-drill.ts --image <镜像>   # 真模型+真容器并发实战
MFC_REAL_BUILD_IMAGE=<镜像> npm test   # 解开 6 条真 Docker 用例(0 skip)
python3 harness/run-report.py .pilot/<label>   # 试跑现场一键对拍
```

## 本机环境的坑(细节见用户级记忆)

- **2026-08-22 勘误**:原文"Cloud 宿主不提供编译、UT 运行或 CodeCheck"
  已被 cc2da9d 推翻。现在的口径是:普通编码会话仍不编译,但**宿主在每个
  新 HEAD push 前另起一个 Build-Fix Agent**,在一次性构建容器里跑仓库
  真实的编译与 UT,失败可自行修复并本地 commit。它是 push 前的闸门,
  不是质量裁判——CodeCheck 与最终核销仍只在绑定 SHA 的流水线。UT skill
  仍只负责测试编写。push 前复检不按首次/后续分叉：人工意见引发的修改
  强制回到意见作者闭环，纯流水线修复在已确认文件范围内自动续推。详见
  README「Cloud 固有执行契约」。
- 容器不只做隔离了:内核模式未配 `--isolate-image` 直接拒绝启动;
  主 Agent、子 Agent、修复会话与 Build-Fix 的**所有 Bash** 都进容器,
  文件 Read/Edit/Write 仍在宿主(受工作区 realpath 边界 + fail-closed
  Gate 约束)。
- docker 走 Colima:VM 只挂 $HOME(/var/folders 挂进去是空目录);
  **有容器任务在跑时绝不 colima start/stop 任何 profile**(会切
  docker context,活容器 exec 全灭,实测打死过一次续跑)。
- 试跑现场在 .pilot/(不删现场是纪律,目录按 label 隔离);
  bigmodel 有 5 小时限额,429 的 detail 里带重置时间。

## Agent skills

### Issue tracker

问题待办以 GitHub Issues 存在于 yunine9/mae-flow-cloud,用 gh CLI 读写。
See `docs/agents/issue-tracker.md`.

### Triage labels

默认五规范角色标签(needs-triage/needs-info/ready-for-agent/ready-for-human/wontfix)。
See `docs/agents/triage-labels.md`.

### Domain docs

single-context:根 CONTEXT.md + docs/adr/。See `docs/agents/domain.md`.
