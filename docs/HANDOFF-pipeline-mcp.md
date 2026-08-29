# 交接:流水线证据链 MCP 化(给接手的 Agent)

2026-08-28 交接。本文档是工作交接件,**不提交进仓**;背景细节看
README「已知边界」2026-08-28 各条、docs/mr-loop-adaptation.md、
pipeline_log.py 头注释。

## 一句话现状

流水线证据采集已整体重写为 toolkit「PipelineLog 编排器」的忠实移植
(用户拍板"照抄"),代码全部完成、628 测试全绿、已推送
(`7d43445`,远端已核验)。**但 streamable-HTTP MCP 的所有新路一次
真网关都没碰过**——现在是"骨架完美、通没通未验",等内网带结果回来
收敛。

## 你要接的活:拿内网结果收敛

内网被交办了两件事(不写代码),结果回来后你处理:

1. **五个网关的 `--list-tools` 输出**(codehub/build/codeccp/
   codecov/dts,`mcp_http_client.py --gateway <名> --list-tools`)。
   对拍 `pipeline_log.py` 里标了"猜"的入参——全部集中记录在运行
   产物 `pipeline_log_summary.json` 的 `guessed_args` 里,代码里
   也有 `data.guessed.append(...)` 可 grep。对不上的**在外网改**,
   内网永远不改代码。已知猜的:`get_pipeline_quality`、
   `get_build_log_url`、`get_record_log`、`CodeCovDiffCoverageTool`、
   `get_project_info`。
2. **真红灯 MR 的一次 artifacts 现场**(stdout JSON + stderr)。
   看 `pipeline_log_summary.json`:8 个策略哪路 ok 哪路 failed、
   原因是什么,逐条修不通的路。行云 AI Review、codeccp 主路、
   coverage 都是首验。

## 不可破的约束(改这块代码时)

- **最高原则:不能卡死**(用户多次拍板)。每个策略 fail-open,
  失败只进 summary 清单;所有网络调用带超时,分页带页数预算,
  绝无无限等待。改任何一路时保持这个结构。
- **令牌纪律**:token/w3token 只进请求头,不落盘不进日志;所有错误
  文本过 `redact()`。报告里 token 一律 `<token>`。
- **诚实清单**:验过什么没验过什么如实写(README 已知边界),失效
  记录显式勘误。烟测只证 fail-open,不能说成"取数已验证"。
- **内核唯一权威**:不在 TS/脚本侧复刻任何流程判定;宿主对 run 的
  机械核验(selectTerminalRun:sha 绑定 + is_valid)是防陈灯闸,
  别绕过。
- 命名:AI Review 系统叫**行云**(域名 xingyun.rnd 没错,别改回
  "星云")。

## 文件地图(deploy/adapter-tools/ 五件套)

- `pipeline_log.py`:编排器本体,8 个 Strategy 原名原序,三条降级
  链(构建日志 SSE→build zip→分页;CodeCheck codeccp MCP→
  reviewtips→defect/list)。改逻辑基本只动这个文件。
- `pipeline-artifacts.sh`:薄壳(采集→512KB 装箱),契约
  `[{name,text}]` 不变,第 4 参 `{mr}` 可选。
- `pipeline-status-mcp.py`:status 主路(第一候选);
  `pipeline-status.sh`:v4 降级(第二候选,内网现用、已验证)。
- `mcp_http_client.py`:streamable-HTTP 客户端 + 六网关注册表
  (`MFC_MCP_<名>_URL` 覆盖);`mcp_sse_client.py`:旧式 SSE 客户端
  (内网真跑过的唯一 MCP 路,别动)。

宿主侧对应物:`src/pipelineContract.ts`(selectTerminalRun/
parsePipelineDefects/onlyUnfixableToolFailures)、
`src/platformAdapter.ts`(candidates 降级链 + contract 直通)、
`src/taskService.ts`(轮询 + 修复派单 + unfixable 前置分诊)。

## 已拍板待实现:证据缺口兜底(2026-08-28 用户提出,同日细化)

拿不到具体报错时不瞎猜,求助人工(小鲁班通知)。用户细化后的
关键:判定单位**不是整包**,是"**红的那一维度有没有它对应的证据**"
——常见场景是知道哪路红了(status 能看到),但取那一路具体报错的
工具又失败了;整包不空但缺的恰好是红灯那路,同样等于瞎猜。

- **逐维度证据对齐(机器判定)**:用现成的工具→维度映射表
  (build2.0→COMPILE、codecheck 类→CODECHECK、CPP_UT→UT)。
  COMPILE 红要 build_log_*.txt 或 build_errors_*.json;CODECHECK
  红要 codecheck_detail.json 或带文件/行号的缺陷明细;UT 红要对应
  job 日志或 UT 失败明细。哪些维度红看 status/mergeable_state/
  pipeline_info;每维度证据齐不齐对 artifacts 文件名 + summary。
- **分级处置**:①红的维度全有证据 → 正常派修;②部分有部分没有 →
  照常派修(修看得见的),使命如实写明"X 维度红但报错缺失,已求助
  人工",同时发小鲁班要缺的那份(修复与求助并行,不互相等);
  ③红的维度全无证据 → 不派修(不烧轮次),waiting_on 挂等人 +
  小鲁班(复用 unfixable-tools 前置分诊同款路径)。
- **求助文案随缺口变**(卡片自述使命纪律):精确到维度——
  "build2.0 红了,构建日志三条降级路都失败(原因附 summary),
  请把构建页面的具体报错**贴到工作台批注**";回灌通道用现有批注
  机制不新造;贴了之后下一轮修复带上,自动恢复。
- **两头出路,绝不无限等**:升级前先走现有 retryPipelineEvidence
  带预算重试(防网络抖动误判);挂等人期间照常轮询,后续轮次拿到
  证据自动恢复派修,不需人工解锁。通知旁路 fail-open,小鲁班发不
  出不影响任务状态(人从工作台也能看到卡点)。

## 未决事项(别自作主张开工)

- toolkit 的 review_arrived / conflict_arrived 两条策略路由**未照抄**
  (涉及内核流程语义),等用户拍板。
- UNFIXABLE_TOOLS 名单原文还没拿到(现只配 SuperChecker);
  SuperChecker 真实失败样例待内网逮一条。
- 旧账验证项(非本链):内网部署更新、双编译 ccache 对拍、真 RED
  多轮修复验证修复窗口新语义、prepush 真容器演练。

## 工程习惯

零构建但改完必跑 `npm run typecheck`(tsx 不查类型);`npm test`
全量;commit 信息 `type(scope): 中文一句话——机制/教训`;
force-push 永久禁用;共享工作副本,动手前 `git status` 看清楚哪些
是别人的未提交文件,只提交自己的。
