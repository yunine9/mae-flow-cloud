# 双轮挑剔测试根因定位总表(2026-08-30)

两轮独立端到端测试的问题合并去重、逐条根因定位:

- **codex 轮**:真 GLM + Linux 隔离容器,现场 `.tasks/e2e-picky-20260830/`,
  原始交接见 `docs/HANDOFF-e2e-picky-glm-linux-20260830.md`(下称 HANDOFF)。
- **CC 轮**:真 GLM + macOS Colima 容器,现场 `.tasks/e2e-picky-cc-20260830/`,
  原始记录见 `.local/e2e-picky-20260830-cc.md`。

编号沿用 HANDOFF 的 MFC-001~020 / GEN-xxx;CC 轮新增项从 MFC-021 起。
每条标注根因置信度:**已实证**(本轮在主库源码/现场逐行核过)、
**采信**(HANDOFF 已给 file:line,本轮未逐行复核,修复时先对一遍)。
两轮重复发现的条目只保留一个编号,正文注明双复现——双复现即与
虚拟化/OS 无关的确定性缺陷。

**内核红线提醒**:标注「内核侧」的根因,修复必须落在 `../mae-flow`
(Python)再经 `harness/sync-kernel.sh` 刷快照,本仓 kernel/ 目录不直接改。

---

## 第一批:数据安全与流程死锁

### MFC-001 · P0 · 本地 clone 硬链接共享 Git 对象

- **现象**(codex 轮):容器内 git 报 loose object corrupt / mmap EACCES;
  任务对象 `nlink=2452`,与源仓、兄弟任务共享 inode。
- **根因(已实证)**:两条正式 clone 路径都没加 `--no-local`:
  - `src/taskService.ts:13614` 附近(`"clone", "--quiet"`,无隔离 flag);
  - `src/issueFlow/issueGit.ts:206`(同样裸 clone)。
  本地路径 clone 默认 hardlink 复用 `.git/objects`;任务 cwd 又整目录
  RW bind 进容器,任务侧 chmod/chown/truncate 直接打在源仓同一 inode 上。
  仓内已有正确先例:`src/repositorySkills.ts:277` 用了
  `--no-checkout --no-local --depth=1`。
- **加重证据(CC 轮实锤)**:真实源仓 `/Users/liaoxiang/dev/mae-flow-fieldtest-java`
  现在躺着两条任务分支(`master_dev.liao_REQPICKY2026`、
  `master_picky_dev_REQ2026081101`)——两轮测试都真的写脏了用户源仓
  (推送面归 MFC-004,对象共享面归本条;两面合起来:任务对源仓既能
  改对象也能推分支)。
- **修法**:两处 clone 统一 `--no-local`;ownership 准备拒绝 `nlink>1`
  的 Git 对象;回归测试断言源/任务对象 `dev:ino` 不同(缺口清单见
  HANDOFF §3)。

### MFC-002 · P1 · pre-MR 批注返工缺回执契约(双复现)

- **现象**:push 卡上打回并挂批注 → Agent 改完代码 → 系统停机
  "Agent 没有留下逐条检视回执"。CC 轮 task-4 与 codex 轮 task-1 独立
  撞上同一条,macOS/Linux 双复现,与环境无关。
- **根因(已实证)**:`workspaceReviewReceiptInstructions()`
  (`src/feedbackPolicy.ts:126`)只被 post-MR review 路径拼进使命
  (`src/taskService.ts:3715`、`12175`);pre-MR 返工使命的构造块
  (`src/taskService.ts:6830-6870`)**一处都没拼**——grep 实证该区间
  无任何 receipt 字样。Agent 不是"忘了写回执",是宿主根本没告诉它要写。
  下游 UI/服务端护栏(必须有 response 才能裁决)本身正确,见 HANDOFF §4 根因 B。
- **修法**:pre-MR 与 post-MR 复用同一个 receipt prompt builder;
  UI 增加"重新请求逐条回应"入口。

### MFC-003 · P1 · 缺回执后 retry 清空 review loop(双复现)

- **现象**:停机后点"重跑续推",loop 被清成 null,批注停在 sent,
  review 恢复意图全丢。CC 轮 task-4 完整复现(halted → retry → loop=null)。
- **根因(采信,CC 轮现场佐证)**:generic retry 直接
  `delivery.loop=undefined`(`src/taskService.ts:5590-5655` 一带,
  本轮验证 5644 确在清 stalled 的同一路径),而上一轮 mission 已在
  session settle 时清掉。
- **修法**:missing-receipt 场景的 retry 保留 loop/review_source/
  annotation IDs,派"复核当前 HEAD 并补齐逐条回执"的窄使命。

### MFC-004 · P1 · 假平台钉死单仓,逐单 repo 推送与 MR 查不同仓(双复现)

- **现象**:CC 轮 task-4 走完全部检视后 MR 创建 HTTP 400
  (`git rev-parse master_dev.liao_REQPICKY2026` 在裸仓里找不到);
  分支实际被推进了**开发账号配置的那个仓**(即真实源仓,见 MFC-001 加重证据)。
- **根因(已实证)**:`--fake-platform` 只从 `--repo` 灌一个 bare
  (`src/serve.ts:421-433`);而下单允许逐单 repo,`launch-options` 的
  `repo.required` 只看 `!!host`(`src/taskService.ts:4144`)——**该禁没禁**:
  钉死单仓部署里界面照样必填仓库地址,填什么推什么,假平台却永远查
  自己的 bare。Fake `createMergeRequest()` 忽略 `body.repo`
  (`src/gitPlatform.ts:209-234`,采信)。
- **修法**:短期——fake-platform 部署禁掉逐单 repo 输入(下单时拒绝,
  不是 35 分钟后 MR 400);长期——假平台按 repo 注册表路由(HANDOFF §5)。

### MFC-005 · P1 · 假 MR 无页面无合入 API(双复现)

- **现象**:CC 轮 task-5 全链绿到 `await_merge`,卡片给的
  `http://127.0.0.1:<port>/mr/1` 点开 404(`TaskCard.tsx:191` 渲染 `<a>`)。
- **根因(已实证)**:`src/gitPlatform.ts` 路由只有 `GET /mr` 列表,
  无 `GET /mr/:id` 页面、无 merge API;唯一合入手段是进程内测试 helper
  `settleMr()`。
- **修法**:最小 HTML 页 + `POST /mr/:id/merge` 真实更新目标 ref。

### MFC-006 · P1 · `python` / `python3` 契约冲突(双复现)

- **现象**:CC 轮每次会话重建都先撞一次
  `sh: 1: python: not found`(task-4 events 09:08:06 实录),浪费一轮工具调用。
- **根因(已实证,较 HANDOFF 更正)**:裸 `python` 来自**内核输出**:
  - `kernel/scripts/mae_flow_core/cli_commands/done_status.py:332-333`
    ——宿主注入的状态行"执行 python \"...\" current"就是它打的;
  - `kernel/.../adapters/hook_active_events.py:218`;
  - `kernel/.../application/hooks/task_cards.py:37`。
  HANDOFF 引的 `src/taskService.ts:2499` 行号已漂移,本轮 grep 宿主源码
  没有裸 python 生成点——**修复主战场在内核侧**(../mae-flow),宿主可
  另加"探测实际解释器并替换"的兜底。
- **修法**:内核统一 `python3`;镜像 selfcheck 校验解释器契约。

### MFC-012 / MFC-013 / MFC-014 / MFC-019(部署与隔离,第一批)

- **MFC-012 systemd 样例与 isolate-user 冲突**:采信
  (`docs/deploy-intranet.md:995` 附近 vs `src/containerRuntime.ts:357`)。
- **MFC-013 缓存 ownership marker 陈旧**:采信
  (`src/containerOwnership.ts:150` / `src/buildCache.ts:315`);
  修法:marker 绑 inode/device,重建原子换。
- **MFC-014 Issue Flow 凭据边界**:静态审计结论,修前按 HANDOFF 建议
  先做一次动态 secret boundary 验证再动层。
- **MFC-019 Agent 对 .git 的高风险自救无闸门**:现象确定。
  **根因定位(已实证方向)**:内核 Bash 守卫已有危险命令清单
  (`kernel/.../guard/bash.py:216` 拦 `git clean -x`),但清单里**没有**
  "重写/复制 .git/objects、删 core、对 .git 递归 chmod/chown"这一族——
  这是守卫规则缺口,不是守卫机制缺失。修在内核 guard 清单 + 宿主把
  Git integrity 异常归为"工作区基础设施故障"停下喊人。

---

## 第二批:人审页面的事实一致性

### MFC-007 · P1 · 增量 Diff 已实现但入口/标题不一致

采信(HANDOFF §7 已给全套定位:`src/taskService.ts:10301-10334`、
`web/src/GitDiff.tsx:539-544` 硬编码标题)。CC 轮佐证:返工后的推送卡
确实自动给了"按上次检视调整:1 个文件,+17/-5"——原生路径是好的,
问题只在 Agent 自设卡与标题表达。

### MFC-008 · P1 · 窄屏专注审阅不可用

采信(`web/src/style.css:7020,7183-7185,8711`,focused 选择器压过窄屏
规则 + canvas min-width 760px)。

### MFC-009 · P2 · await_merge 残留旧选择条

采信(App.tsx 浅合并不删 volatile 字段 + GitDiff selectionKey 交集,
HANDOFF §9 五点定位)。修复时注意与 MFC-028 的 waiting 生命周期统一处理。

### MFC-010 · P1 · "执行方案与定格不一致"告警误报

采信(`src/taskService.ts:2673` 只要缺 `compiled_final_plan` 即告警,
而内核能从 platform_default+overrides 正常编译)。修法:下单时原子持久化
compiled plan + hash,UI 只展示内核真正消费的那份。

### MFC-011 · P1 · 模型设置健康检查与真实调用协议可能不同

已实证补充:UI 默认 `openai-completions` 是 2026-08-26 用户拍板的默认值
(`web/src/SettingsView.tsx:352` 注释),已存配置会回显原格式——
错位只发生在"部署侧用 flag 配了 anthropic-messages、管理页从未保存过"
的组合。修法不变:健康检查与 runtime 走同一 adapter/同一配置结构。

### MFC-016 · P1 · 耗时统一偏移约 8 小时

- **根因(已实证,较 HANDOFF 细化)**:归一器两侧都已存在——
  `web/src/time.ts:9`(裸串按 UTC 补 Z)、`src/timeline.ts:38-46`
  (区分 bare=utc / bare=local)。真正的洞:内核
  `time.strftime("%Y-%m-%d %H:%M:%S")`(`kernel/.../advancement.py:127` 等)
  写的是**执行进程所在时区**的裸串,而内核命令如今全在 UTC 容器里跑,
  宿主 `bareMeans:"local"` 却按宿主时区(+8)解——契约在"内核命令进容器"
  那一刻就断了。HANDOFF 引的 `web/src/timeline.ts` 不存在,实为
  `src/timeline.ts`。
- **修法**:内核写带偏移量的 ISO-8601(内核侧);过渡期宿主把内核裸串
  按 UTC 解(容器 TZ 固定 UTC 时正确)。

### MFC-015 · P2 · 容器资源 inspect 不核对

采信;修法:启动后 inspect 对拍 Memory/NanoCpus/User,不一致 fail loud。

---

## 第三批:交互与文案

### MFC-017 · P2 · 桌面通知无效果

CC 轮佐证:内核自己都打出"桌面通知这次没弹出来"(task-4 events
09:11:27)。根因方向确认:通知意图产生在容器内,宿主桌面能力不透传;
`src/serve.ts:200-203` 的 `MAE_FLOW_DESKTOP_NOTIFY / MAE_FLOW_NO_NOTIFY`
只设了宿主进程环境。修法:通知走宿主结构化事件(小鲁班通道已经是),
容器内 BEL/桌面路径直接关死,别让内核反复试。

### MFC-018 · P2 · 零散体验问题(部分已实证)

1. **`Error: ` 前缀甩给用户(双复现)**:已实证——`src/server.ts` 14 处
   `String(error)` 直出(377/533/550/579/590/604/613/841/950/1670/1893/2475 等),
   同文件 283 行已有正确写法(`error instanceof Error ? error.message`)。
   统一收敛成一个 helper 即可。
2. 帮助搜索空态、标点门禁(内核侧 `flow.json:186` 等)、Story 过早声称
   完成、Grill 数量不服从:采信 HANDOFF 定位。
3. **心愿墙 kind 静默归一(CC 轮)**:`src/wishWall.ts:183`
   `input.kind === "issue" ? "issue" : "wish"`——非法值不报错。P3。

### MFC-020 · P2 · 交付失败同错刷屏(双复现,已量化)

- **现象(CC 轮)**:serve 日志里同文 MR-400 **86 条**;人工"重跑续推"
  后又完整烧一轮预算再停。
- **根因(已实证)**:`scheduleDeliveryRecovery`(`src/taskService.ts:9367`)
  按 `poll_interval`(默认 10s,我配 3s)固定节拍重试,对确定性 4xx
  (branch not found)不做 error-fingerprint 识别、不退避;每次失败
  全文打日志。预算走 `verificationDeadline`,烧完才 `markVerificationStalled`
  (`src/taskService.ts:9327`)。
- **修法**:确定性 4xx 直接停摆喊人(不烧满预算);同 fingerprint 日志聚合。

---

## CC 轮新增(HANDOFF 未覆盖)

### MFC-021 · P1 · 普通插话被冒充成"跨仓协作",污染进交付件

- **现象**:单仓任务里 SteerBox 说一句话,模型收到
  `[跨仓协作 · dev.liao] …`;spec.md 决策 5 已写成"(用户跨仓消息补充)"。
- **根因(已实证)**:`src/taskService.ts:7256`
  `actor ? \`[跨仓协作 · ${actor}] ${message}\` : message`,而
  `src/server.ts:2260` 的 interrupt 路由**永远**传 `viewer.username`。
  引入自 `842f8d2 feat(chain)`(8-28):跨仓特性借道插话通道时把前缀
  写成了无条件。真正的跨仓入口是 `/cross-repository-update`,另有其路。
- **修法**:前缀只在 chain/多仓场景加,或改为中性的"[用户 · xxx]"。
  一行改动 + 一条回归(单仓插话正文不得含"跨仓")。

### MFC-022 · P1 · 检视人在"等你决定"期间无路提交意见

- **现象**:受邀 committer 提交批注 → 404"这一单正等你的决定,请在
  决定卡里回答";而决定卡对他 403,责任人也代交不了(只能交自己的草稿)。
  UI 文案"提交决定时会把这些批注一并送达"对检视人是假的。
- **根因(已实证)**:`sendAnnotations` 兜底走插话通道
  (`src/taskService.ts:3612` `await this.interrupt(id, text)`),而
  `interrupt()` 在 `waiting_for_human` 时抛 NotFoundError
  (`src/taskService.ts:7249-7251`),server 映射成 404
  (`src/server.ts:2466`)。设计时只想过"责任人自己在决定卡里带批注",
  没想过"批注作者≠决定人"。
- **修法**:waiting 期间允许把 sent 批注挂到当前 waiting 上
  (决定提交时由服务端合并送达,谁的批注记谁);状态冲突改 409;
  UI 对非决定人给真话("已保存,将随责任人的决定一并送达")。

### MFC-023 · P1 · 检视返工被播报成"Agent 正在修复流水线问题"

- **根因(已实证)**:`src/taskFocus.ts:188` 只判
  `loop.state === "repairing"`,不看 `loop.kind`;检视返工的 loop 是
  `{kind:"review", state:"repairing"}`,没有任何流水线在跑。
  `loop.kind` 字段现成(`taskService.ts:11954` 自己在用它区分)。
- **修法**:`kind==="review"` 时播报"正在按检视意见修改",两行改动。

### MFC-024 · P1 · 下单必填项不校验(repo/ticket)

- **根因(已实证)**:`launch-options` 声明
  `repo/ticket: {enabled: !!host, required: !!host}`
  (`src/taskService.ts:4144-4145`),但 `POST /tasks` 对两者都不校验:
  ticket 只填空格照样 201(摘要里干脆没有 ticket 字段),repo 不传照样
  201(task-5 实证,任务卡 repo_url=null)。required 只约束了浏览器表单,
  API 语义上是摆设;与 MFC-004"该禁没禁"同一入口。
- **修法**:服务端按 launch-options 声明校验;fake/钉死单仓部署禁 repo 输入。

### MFC-025 · P1 · 建单失败挂内部报错,next_action 指条死路

- **现象**:错分支/相对路径/非仓路径三种失败,focus.headline 分别是
  "容器挂载格式必须是 宿主绝对路径:容器绝对路径[:ro]: ../…"、
  "ENOTDIR: not a directory, lstat …/passwd/.git" 这类内部话;
  next_action 一律"查看失败现场,处理后重跑"——这三种失败重跑一百次
  也一样,正确出路是重新下单。
- **根因(已实证)**:失败 detail 原样来自异常字符串;
  `src/taskFocus.ts:104` 的 blocked 分支对所有 failed 通配同一句
  next_action,不区分"配置错(要重新下单)"与"环境抖动(可重跑)"。
- **修法**:clone/init 期的确定性配置错标记为不可重跑,next_action 改
  "修正下单信息后重新发起";挂载格式类报错在抛出前翻译成人话。

### MFC-026 · P2 · 单号连字符要烧一轮模型才发现,还连问两张卡

- **根因(已实证)**:内核正则 `(?:REQ|DTS)\w+`
  (`../mae-flow/scripts/mae_flow_core/cli_commands/standalone_commands.py:411`、
  `state_config.py:206`)不收连字符;下单页只有 placeholder,零校验。
  第二张卡是模型自己给的推荐项 `REQ-PICKY2026` 仍非法(REQ 后还是 `-`),
  又问一遍——模型失误,但根子是校验位置太靠后。
- **修法**:下单时把单号交内核校验一次(不在 TS 复刻正则,调内核命令
  或建单后立即预检),或至少 placeholder 写明"字母数字下划线"。

### MFC-027 · P2 · 同一份 Spec 被连问两遍确认

- **根因(已实证,task-4 events 09:08-09:11 全链)**:
  1) Agent 改完 spec 后**自设** AskUserQuestion"Spec 检视确认"(09:08:32),
  这张卡内核不认;
  2) 我确认后 Agent 跑 `done`,内核 exit 2:"检视内容已经变化,旧决定已
  自动失效,新审批卡已自动生成;**直接重新展示并取得一次决定,无需让
  Agent 反复解释**"——内核内容绑定把 spec 修改前的旧决定作废,重新
  生成了自己的内容绑定卡(09:10:07)。
  内核行为正确(防拿旧确认背书新内容);浪费在 Agent 的自设卡——它把
  用户的一次回答烧在内核不认的卡上。内核提示语已经预判了这个模式。
- **修法**:内核侧(或 open 步指令)明确"修改后不自设确认卡,直接 done
  取内容绑定卡";宿主可加兜底:`done` exit 2 自动生成卡时,若上一张
  Agent 自设卡的答案在 60 秒内且内容指纹一致,提示语里向用户说明为何再问。

### MFC-028 · P2 · 配置确认卡说"上述",卡里没有"上述"

- **根因(已实证)**:配置清单在 ask 前一条 assistant_message 里;
  waiting 记录只存 AskUserQuestion 的 input(context+questions),
  `TaskCard` 只渲染 `waiting.context`(`web/src/TaskCard.tsx:723`)。
  卡上的"以上/上述"指向一个卡里不存在的东西——盲签风险。
- **修法**:宿主建 waiting 时把紧邻的上一条 assistant_message 摘要附进
  card(或 Agent 契约要求完整清单必须放 context)。与 MFC-009 的
  waiting 生命周期修复同批做。

### MFC-029 · P2 · 助手占场时任务卡指的"恢复"必定 409

- **根因(已实证)**:resume 在助手占场时如实拒绝
  (`src/taskService.ts:7933`),但 taskFocus 的 paused 分支不看
  `assistantActive`,仍给"需要继续时从当前现场恢复"。
- **修法**:paused + 助手占场时 focus 改"开发助手接管中,从开发协作
  面板交还主任务"。

### MFC-030 · P2 · 交付文件树把构建垃圾列给人勾

- **根因(已实证)**:`push_review.all_paths` 直接用
  `snapshot.workspace_paths`(`src/taskService.ts:10330`),含 untracked
  的 `build.log`/`test.log`(prepush 构建写进仓根)与 `.gitignore` 工作区
  改动;卡片正文却说"另有 4 个工作区文件不在本次提交中"。勾选校验只查
  "路径在现场"(`taskService.ts:6564`),勾了就真带走。
  **附带更正 CC 轮初判**:`.git/info/exclude` 机制其实完整存在且已覆盖
  全部平台文件(`taskService.ts:8861-8878`,含 `.mae-flow.json.exited`
  与 `openspec/config.yaml`,注释里就是 run9 的同款教训);Agent 改
  `.gitignore` 是多余动作且被交付选择挡在 MR 外——残余问题只是
  文件树展示语义 + 构建日志不该写仓根。
- **修法**:all_paths 过滤 exclude 命中项与构建日志;prepush 日志改写
  到 `.mae-flow-work/` 或任务数据目录。

### MFC-031 · P3 · 登录锁 15 分钟,不告诉用户锁多久

- **根因(已实证)**:服务端算了 `blockedForMs` 且写了 `retry-after`
  (`src/server.ts:441-448`),前端 `login()` 不读 header、文案不带时长
  (`web/src/api.ts:278-288`)。另:锁记在进程内存,重启即清——运维
  文档没提这条解锁路径。
- **修法**:429 响应体带 `retry_after_s`,登录页倒计时。

### MFC-032 · P3 · 开发者删不掉自己从未跑成的失败单

- **根因(已实证)**:`DELETE /tasks/:id` admin-only
  (`src/server.ts:1957-1959`),设计如此(防删审计现场)。但"自己建的、
  从未成功过的配置错单"也一并挡住,只能挂看板等管理员。产品决策类,
  非代码 bug。
- **修法建议**:作者可删"从未离开 failed 且无交付动作"的单,或给归档/隐藏。

---

## 批次汇总(修复顺序建议,与 HANDOFF §2 对齐后微调)

| 批次 | 条目 | 主题 |
|---|---|---|
| 1 | MFC-001, 002, 003, 006(内核), 012, 013, 014, 019(内核+宿主), **021, 022** | 数据安全、批注闭环死锁、Linux 可运行性、插话语义 |
| 2 | MFC-004, 005, **024** | 假平台逐单仓 + 浏览器可合入 + 下单校验(同一族:错误要在下单时拦住) |
| 3 | MFC-007, 008, 009, 010, 011, 016(内核+宿主), **023, 025, 027(内核), 028, 029, 030** | 人审页面与播报的事实一致性 |
| 4 | MFC-015, 017, 018, 020, **026(内核), 031, 032, 033** | 退避/文案/小刺 |
| 单独 | GEN-001~005 | 业务样例仓问题,照 HANDOFF §15,不误修进 MFC |

- 双复现条目(与环境无关,优先级不打折):MFC-002, 003, 004, 005, 006,
  018.1, 020。
- 涉及内核(../mae-flow)的:MFC-006, 016, 018.3, 019(guard 清单),
  026, 027——按红线走内核仓修复 + sync-kernel.sh,本仓只做宿主侧兜底。
- HANDOFF 引用行号有两处漂移,已更正:MFC-006 宿主行号(实为内核
  done_status.py:332),MFC-016 的 `web/src/timeline.ts`(实为
  `src/timeline.ts`)。其余"采信"条目动手修时先复核行号。

---

## 修复轮验收与下一轮 E2E 测试建议(2026-08-30,CC 修复后)

修复提交:主库 ed657a8 / 48ac50f / a631973 / 4682dac / d702d3e / e602fe7,
内核仓 4dd8000(已收编快照)。本地验收:typecheck 双配置绿、
相关子集测试绿、内核 selftest 全绿;全量测试与真容器整链见下。

### 给下一轮端到端验证的具体建议(按批)

**A. 批注返工闭环(MFC-002/003/022,最重要的复验)**
1. 走到 push 确认卡,行级批注 + 选「需要调整代码」→ Agent 改完后,
   **不删批注**应能走通:批注面板出现 Agent 逐条回应 → 作者点
   「确认已修复」→ 新 push 卡 → 确认推送。任何一步要求删批注=复发。
2. 故意让回执缺失(可在 Agent 改完、收口前手动删
   `reviews/local-receipts.json`)→ 停机文案点名批注 id → 点「重跑续推」
   → **loop 不清空**,派的是"复核当前 HEAD 补回执"窄使命,不重烧修复。
3. 检视人(受邀 committer)在任务「等你决定」期间提交批注:应 200、
   状态 sent(随决定送达);责任人直接放行被 409 拦;责任人选返工后
   Agent 收到的正文里有这条意见。

**B. 源仓隔离(MFC-001,Linux + macOS 都要)**
1. 新任务 clone 后:`find <任务仓>/.git/objects -type f -links +1 | wc -l`
   必须为 0。
2. 测完检查**源仓** `git for-each-ref`:不得多出任务分支
   (注意:上一轮已把 master_dev.liao_REQPICKY2026、
   master_picky_dev_REQ2026081101 推进了 fieldtest-java,先清掉再测)。
3. Linux root 部署对旧 hardlink 现场(可手工 `cp -al` 造一个)起任务:
   应拒绝并提示重建,而不是 chown 下去。

**C. 假平台整链(MFC-004/005/024)**
1. 钉死单仓 + fake-platform 部署:下单页**不再出现代码仓输入框**;
   API 硬塞 repo 应 400 点名"固定交付仓"。
2. 浏览器全链:确认推送 → 任务卡 MR 链接**能打开**→ 页面门禁全绿后
   出现「合入」→ 点击 → 任务自动走到 completed。门禁红时按钮不出现、
   POST 409。
3. 交付失败注入(拿不存在的目标分支触发 4xx):**秒级**转"需要人介入",
   不再烧两分钟预算;serve 日志同文错误 ≤2 条 + 计数行。

**D. 内核契约(MFC-006/019)**
1. 只有 python3 的镜像里整链跑通,任务事件流全程 grep 不到
   `python: not found`。
2. 容器内让 Agent 试 `rm .git/objects/xx/yyy`、`rm core`、
   `chmod -R 755 .git`:应被 guard 以 permit 类拦下且文案给出路;
   `git fsck --full` 照常放行。

**E. 人审页面(MFC-007/008/009/028)**
1. 打回一轮后的 push 卡:「这次修改」标题显示真实 `旧HEAD → 新HEAD`
   短 SHA;「完整交付」显示 基线 → HEAD。
2. 399px 宽进专注审阅:新增行可见、行级批注按钮可点(文件树折叠成
   顶部限高块)。
3. 确认推送进入 await_merge 后:旧决策卡、勾选条、"最终范围 x/y"
   必须全部消失(开着工作台等轮询刷新,不许残留)。
4. 配置确认卡上,完整配置清单直接在卡内(preface 区),不需要去
   现场流水回翻。
5. 时间线/耗时与本地时钟对表,无 8 小时偏移。

**F. 插话语义(MFC-021)**
单仓任务 SteerBox 插话 → 查看 `interrupts` 与最终 spec/story:
正文前缀应是「[责任人 xxx 插话]」,交付件里不得再出现"跨仓"字样。

**G. 回归警戒(改动面附近,重点盯)**
- retry 的窄使命分支:普通停摆(非检视)retry 仍应清 loop 重开预算
  ——别把 CI 修复停摆也误保留。
- 4xx 快停正则(`HTTP 4xx`,408/429 除外):真平台若把瞬时错误也编成
  400 文案,会被误判确定性——观察首个真平台部署的停摆原因分布。
- launch-options repo.enabled=false(钉死仓)后,下单页的仓库 Skill
  扫描/技术画像入口是否随之隐藏而非报错。
- 快照合并改成替换语义后,工作台开着时 delivery/waiting 的实时刷新
  是否仍平滑(无闪烁/丢 knowledge_usage)。

### 未修项的临时绕行(测试时别当 bug 重复上报)
- MFC-030:交付树里可能出现 build.log 等未提交文件,不勾即可;
- MFC-017:桌面通知在容器内无效,以页面/小鲁班为准;
- MFC-026:单号仍会在配置确认阶段由内核打回连字符,下单请直接用
  `REQ/DTS+字母数字`;
- MFC-027:Spec 按批注返工后可能仍有一次内核内容绑定的重新确认卡
  (Agent 自设卡问题待内核批);
- GEN-xxx 是业务样例仓问题,不在 MFC 修复范围。
