# 问题流调试形态(--debug-issue):单旗标本机全链仿真

2026-09-14 拍板(grill-with-docs 会话)。目标:在没有 DTS/CodeHub/网管环境的本机(WSL 开发机),从 DTS 列表发起一路跑到 MR 全绿收口;硬约束是**旗标缺席的部署零行为改动**。

**决策**:

- 单旗标 `--debug-issue` 隐含 DTS mock,并把数据源指到 `<dataDir>/debug-issue/dts-tickets.json`(assets/mock 团队共享文件一字不动);显式 `--dts-mcp-url` 与之互斥(fail-loud,与 `--dts-mock` 同款)。
- 交付平台 mock **复用 FakeGitPlatform**(`--fake-platform` 需求侧同一件)进程内起服:POST /mr、GET /mr/gates、GET /mr/discussions、pipeline trigger/status、GET /pipeline/artifacts 全部现成,默认恒绿,MR 永不合入——不新写 stub。主裸仓取首个镜像,其"repo 必须在主裸仓同目录下"的多仓路由边界由全部镜像同住 `debug-issue/remotes/` 天然满足。
- 远端代码仓 = 源仓的 bare 镜像(`<dataDir>/debug-issue/remotes/<名>.git`,`git clone --bare` 纯只读,源仓零接触);业务模块绑镜像路径,克隆源于镜像、推送落回镜像——推送目标必须是 bare,git 才收对分支的推送。
- 幂等播种全套资产:示例业务模块(绑镜像)、假网管环境(127.0.0.1/虚拟化/演示密码)、三张可发起状态的调试单(单仓×2/双仓×1,正文服务名与罐头日志目录对齐)、罐头日志、假 fetch-logs/fetch-logs-k8s 引擎(退出码 0 + 输出「解压完成」,与真引擎同一成功判据)。已存在一律跳过——用户改过的调试单/日志/镜像推送历史/模块绑定都不被覆盖;假引擎脚本每次启动重写(罐头路径要随 dataDir 对齐)。
- 账号面:全新数据目录同演示待遇自动建 admin/dev(mae-flow-demo);dev 缺 Git 署名时补演示令牌+邮箱——本机无全局 gitconfig,宿主模式克隆不写 user.email 时修复阶段的 commit 会死在 "Author identity unknown"(探测实锤)。
- 假引擎经 `IssueFlowService.debugIssue` 选项在会话技能物化后覆盖 `skills/issue-ops/bin/` 两个 wrapper(架构二进制原样保留,不再被调);旗标缺席时该选项不出现,openDriver 无此调用。

**零影响边界(验收口径)**:旗标只在 executionRuntime 接线层消费;新逻辑全住 `src/issueFlow/debugIssue.ts`,既有文件只加旗标读取/透传与 `MockDtsGateway` 的可选数据源参数(缺省原值,既有调用方零感知)。测试钉:播种幂等、平台端点形状与恒绿、假 bin 的复制与判据、技能补丁只换 wrapper 不碰二进制。

**实现落点**:`src/issueFlow/debugIssue.ts`(播种器/假引擎/单据种子);接线:executionRuntime.ts(账号、DTS、平台、服务选项)、issueFlow/service.ts(选项 + openDriver 补丁)、issueFlow/gateways.ts(数据源参数)。

曾考虑:(a) 复用 platformAdapter + 假命令脚本——否,多养一个进程、假脚本散落仓外,FakeGitPlatform 现成且语义更全;(b) 手写进程内 stub——否,SHA 绑定、幂等 MR、合入门禁这些语义不必重抄一遍;(c) 模块直接绑源仓工作目录——否,推送被 git 拒收(非 bare 检出分支),开 `receive.denyCurrentBranch=updateInstead` 会真改用户工作区;(d) 调试单直接改 `assets/mock/dts-tickets.json`——否,污染团队共享的过渡期 mock 数据,调试资产应随 dataDir 走、不进仓库。
