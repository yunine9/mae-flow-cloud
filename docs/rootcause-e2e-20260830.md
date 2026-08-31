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

---

## CC 修复后真实 GLM + Linux 第二轮 E2E 复验（2026-08-30 晚）

### 复验环境与结论口径

- Cloud：`--fake-platform --repo <固定仓> --provider glm --model glm-5.1`。
- 执行环境：真实 Linux Docker 隔离容器，镜像
  `mae-flow-task-builder@sha256:73913b6b...`，4 CPU、8 GiB、只读根文件系统。
- 源仓：为排除上一轮遗留 hardlink，使用 `git clone --no-hardlinks` 得到的
  独立复验仓 `.e2e-fixtures/source-20260830-rerun`。
- 任务：`task-1 / REQ2026083002`，真实 GLM 完成 Java 代码、UT、三轮人工
  批注返工、Build-Fix、推送、假平台流水线、MR 与合入。
- 注意：本轮最终 `completed` 是在记录产品阻塞后，用**受控测试夹具恢复**
  定格基线祖先关系才继续得到；不能把整链算作干净通过。恢复前产品自身
  没有可用的继续入口。

### 已通过的重点验收

1. **真实 Linux/GLM 可运行**：主 Agent 与 Build-Fix 都在 Linux 容器运行，
   Maven 编译与 UT 真实通过；全程未出现 `python: not found`，也未靠 Agent
   接触 Git 凭据或直接 push。
2. **批注不删除可闭环**：受邀检视人 `picky_reviewer` 在任务等决定期创建、
   发送批注均为 200；责任人选返工后 Agent 收到原文并写逐条回执，批注作者
   点“确认已修复”后继续推进。MFC-022 本路径通过。
3. **缺回执停机与窄使命续推通过**：持续删除新生成的
   `reviews/local-receipts.json` 后，任务在秒级停为 `verifying`，文案准确点名
   `an-mtfrywts-4`，loop 保留为 `halted`；点“重跑续推”后 loop 变为
   `repairing`，使命明确为“只复核当前 HEAD 并补回执，未发现漏改不要改代码”。
   续推前后 HEAD 均为 `31cff06`，没有重烧代码返工。
4. **快照刷新基本平滑**：运行、等决定、返工、停机、续推之间没有整页空白，
   旧决定卡也能随状态切走；但复检基准与范围字段有独立错误，见下文。
5. **源仓隔离通过**：完整测试后源仓
   `find .git/objects -type f -links +1` 为 0；源仓只有 `master` 与
   `origin/master`，没有任务分支，工作树干净。
6. **固定仓入口的显式 UI 通过**：代码仓输入框、仓库 Skill 与技术画像入口
   都按 `repoPinned` 隐藏；API 强塞另一代码仓由服务端拒绝。旧草稿的隐藏字段
   仍会污染请求，见 MFC-033。
7. **MR 基础链通过一半**：MR 链接可打开；流水线三项
   COMPILE/UT/CODECHECK 全绿后才显示“合入”。但冲突门禁是假绿，首次合入
   409 且无恢复路，见 MFC-037。

### MFC-033 · P1 · 固定仓部署隐藏了仓库输入，却继续提交旧草稿仓库

- **动态现象**：同一浏览器 origin 里保留上一轮下单草稿后，固定仓部署的
  下单页不显示仓库输入框；提交却仍暗带旧仓
  `/Users/.../mae-flow-fieldtest-java`。服务端正确拒绝并提示固定交付仓不接受
  逐单代码仓。换一个干净 origin 才能继续。
- **根因（已定位）**：`web/src/LaunchWorkspace.tsx` 的 `repos` 无条件从
  `LaunchDraft.repos` / `LaunchPreferences.recentRepos` 恢复；
  `options.repo.enabled` 只控制表单是否渲染（约 690 行），`submit()` 却始终
  把 `repo: repos[0]` 与 `repos: repos[...]` 传给 `createTask()`（约 500 行）。
  知识预览的 `previewInput.repos` 也沿用隐藏旧值。
- **修法**：拿到 `launch-options` 后，若 `repo.enabled=false`，立即清空本次
  `repos` 与仓库技术画像；提交、草稿保存和知识预览都必须按 enabled 裁字段，
  不能只隐藏控件。保留现有服务端拒绝作为最后防线。

### MFC-034 · P1 · 专注审阅里的代码行仍无法打开批注编辑器

- **动态现象**：进入“专注审阅”并选择 `TextUtil.java` 后，DOM 中明确存在
  `.annotatable [data-l="28"]`；点击/强制点击代码行均不出现编辑器和悬浮批注
  按钮，反而提示“这一处没有行号可锚定”。只能调用 annotations API 绕行。
- **根因状态**：源头已收窄到 `web/src/Annotatable.tsx` 的事件委托
  `open() -> pickRow()` 与 `GitDiff` 的 fixed 专注布局交互：行节点存在，但
  实际 click target 没被解析成该 `[data-l]` 行。`pickRow` 的纯逻辑测试覆盖了
  假节点，没有覆盖真实专注审阅 DOM/事件目标；尚未定位到唯一一行代码，修前
  应补浏览器级回归测试再改。
- **修法**：至少用真实 `GitDiff + Annotatable` 挂载测试复现；让代码单元格或
  行容器直接成为可操作按钮/明确绑定 `onClick`，不要把最重要的人审入口完全
  依赖祖先事件命中。399 px 与桌面宽度都验。

### MFC-035 · P1 · “自上次检视以来”复检模式仍会消失，完整交付伪装成按钮

- **动态现象**：第一轮人工检视后 HEAD 从 `8b39fcc` 多次变化到
  `024dcaf/7c70d86/31cff06`，复检卡仍只有“完整交付”，没有“这次修改”；
  API `push_review.has_focused_changes=false`、`base_sha=任务基线`。用户点击
  “完整交付”无任何反馈，因为它其实是唯一状态标签，却使用按钮外观。
- **根因（已定位）**：`buildPushReviewPresentation()`
  (`src/taskService.ts:10396-10435`)只拿 `delivery_selection.head` 或上次
  `git_push.sha` 做候选；`compareDeliveryRevisions()` 又强制 `from` 必须是
  `to` 祖先。Agent 重排历史后旧检视 HEAD 不再是祖先，比较返回 undefined，
  代码静默回退整单基线并把 `has_focused_changes` 置 false。与此同时
  `delivery_selection.head` 在复检轮保持旧值，不能表达“最近一次人实际看过的
  HEAD”。
- **修法**：单独持久化不可变的 `last_reviewed_head` 与 waiting/receipt 身份；
  历史被重排时不要静默降级，应先拦截基线祖先关系错误（MFC-036）。若确实
  只能展示完整交付，要说明原因。有两个 scope 才渲染切换按钮；只有一个时
  改为不可点击标签。

### MFC-036 · P0 · Agent 可把交付分支重排到定格基线的父提交，平台未拦截

- **动态现象**：任务定格基线为 `8e7f2ad`，Agent 为整理 4 文件清单执行历史
  重排后，HEAD `31cff06` 的父提交变成 `8dc0b41`；
  `git merge-base --is-ancestor 8e7f2ad HEAD` 返回 1。左侧仍显示用户勾选
  4 文件，右侧卡片却把 `_FIELDTEST/README.md` 算成第 5 个交付文件。
- **后续表现**：用户再次确认 4 文件后，宿主追加一个“剔除未勾选文件”的
  commit `4806f99`，净 diff 恢复成 4 文件，但 **8e7f2ad 仍不是 HEAD 祖先**；
  平台只修最终树，没有修提交拓扑，最终 MR 无法快进合入。
- **根因（已定位）**：交付门禁只用定格基线到 HEAD 的路径集合校验，不做
  `merge-base --is-ancestor <frozen-baseline> HEAD`。边界整理
  `reconcileConfirmedDeliveryBoundary()`（`src/taskService.ts:10637+`）以旧
  selection HEAD 为 anchor 做 mixed reset/重提交，但在 anchor 自己已经脱离
  定格基线时仍放行；最终树看似正确，历史合同已经破坏。
- **修法**：在 Build-Fix 前、生成 push 卡前、真正 push 前都统一校验定格
  baseline 必须是 HEAD 祖先；失败应派“把当前净改动重放到定格基线”的窄使命，
  或由宿主用新 worktree 机械重建，不能用补一个反向文件 commit 掩盖。Agent
  指令也应禁止 reset/rebase 到定格基线之前。

### MFC-037 · P0 · MR 冲突门禁假绿，合入 409 不展示且 MFC 无恢复入口

- **动态现象**：MR 页显示
  `resolve_discussion_passed/conflict_passed/ci_state_passed` 三项全绿并给“合入”
  按钮；点击实际返回 409：`目标分支已前进且非快进，请先在任务侧合并目标分支
  再推送`。任务仍是 `await_merge`，页面继续说“等待合入”。“开发协作”显示
  “当前没有可接管的代码现场”，向 `/interrupt` 发同一错误也返回 409
  “await_merge 没有在跑的会话可插话”，Agent 无法正常接住。
- **根因（已定位）**：假平台 `mergeGates()`
  (`src/gitPlatform.ts:255-286`)的 `conflict_passed` 只读测试布尔
  `!this.conflictGate`；真正 POST merge 才在
  `mergeMergeRequest()`（约 370 行）执行 Git `merge-base --is-ancestor`。
  同一平台的“能否合入”出现两套事实。MR 页又只是原生 form，409 没有可回到
  MFC 的结构化上报；watchMerge 只相信假绿 gates，自然不会派冲突修复。
- **修法**：假平台与真适配统一使用真实目标/source SHA 计算 conflict gate；
  merge POST 的 409 要在 MR 页原地显示，并可回传 MFC/下一轮 gates。MFC 在
  await_merge 必须保留“报告合入失败/派冲突修复”的入口，不能只允许取消。

### MFC-038 · P0 · await_merge 只看 merged，不核对实际合入 SHA

- **动态现象（受控恢复实证）**：为继续验证 completed，测试夹具把同样 4 文件
  净改动重放到正确基线，得到新 SHA `ef83355`，更新 MR 并重新触发三项流水线
  后合入。MFC 随即标记 `completed`，但任务交付台账、prepush 收据、attested
  仍全部绑定旧 SHA `4806f99`；实际目标分支已是 `ef83355`。
- **根因（已定位）**：`fetchGates()`（`src/taskService.ts:11864+`）只返回
  `mrState` 与 gates，不读取 MR 的 source/merge SHA；`watchMerge()` 看见
  `merged` 就调用 `settleMergeState()`。`completionAttestation()` 只核对任务
  本地旧交付事实是否完整，不核对“平台实际合入的提交是否等于该事实”。
- **风险**：真实平台上若分支被 force-push、MR 被更新或合入了另一 SHA，MFC
  仍可用旧绿灯与旧人工确认宣告完成，属于交付完整性漏洞。
- **修法**：门禁/MR 状态契约必须返回当前 source SHA、merge commit SHA；
  await_merge 每拍要求 source SHA 等于 `delivery.sha`。不一致立即撤销旧
  attestation，重新进入 Build-Fix + 人工检视；merged 时也必须对 merge SHA
  做祖先/内容绑定核验，不符绝不能 completed。

### MFC-039 · P2 · 新增“代码已验证，等待检视与合入”大卡重复且抢层级

- **动态现象**：await_merge 时右栏已有“等待检视与合入 / 前往 CodeHub 完成
  最后一步”，下面又出现 `MERGE REQUEST / 代码已验证，等待检视与合入` 大卡，
  再重复一段监听说明和 MR 链接。信息正确，但位置突兀、视觉层级高于真正操作。
- **来源（已定位）**：当天提交 `3e2bc25` 新增
  `web/src/TaskWorkspace.tsx` 的 `ws-merge-focus`（约 1134 行）。
- **用户确认的改法**：默认不显示这张大卡；只保留已有“等待合入”状态。
  点击“等待合入”后展开一行：`流水线与门禁已通过，请前往 MR 完成检视与
  合入。`，紧跟 MR 链接即可。

### MFC-040 · P1 · 复检统计显示 5 个文件却固定为 +0/-0

- **动态现象**：多轮真实代码变化后，右侧复检摘要连续显示“5 个交付文件，
  +0/-0”；左侧完整 diff 同时显示数十行新增，事实明显冲突。
- **根因（已定位）**：与 MFC-035/036 同源。祖先约束导致
  `compareDeliveryRevisions()` 返回 undefined；
  `buildPushReviewPresentation()` 对 file_count 退回 snapshot 路径数，却把
  additions/deletions 直接默认 0，形成“文件数有值、行数假零”的混合结果。
- **修法**：比较不可得时不要显示 0；显示“统计不可用：提交历史偏离任务基线”
  并阻塞，先修复祖先关系。测试必须覆盖比较 undefined，而非只覆盖正常祖先链。

### 本轮交互意见：最终推送范围的能力有价值，但操作被拆散

- 勾选的真实语义是交付白名单：选中会进最终 commit/push/MR；未选仅留本地，
  不会删除。当前却被拆成左侧文件树勾选、右侧“确认/返工”单选、底部
  “确认推送范围并继续”三处；返工时 CTA 仍叫“确认推送范围”，用户无法一眼
  判断勾选是否已经执行、与返工是什么关系。
- 建议合成一张“本次交付范围”卡：每项明确标“纳入交付 / 仅留本地”，显示
  排除原因和最终 4 文件摘要；按选择分支把 CTA 改成“按这 4 个文件推送”或
  “提交返工意见”，不要共用一条模糊按钮。

### 尚未完成/不能算通过的复验项

1. **4xx 秒级喊人**：本轮真实遇到 merge POST 409，但它发生在浏览器直连
   假平台的合入动作，MFC 完全未接收到，因此不是原计划的 adapter 4xx 快停
   正向通过，反而形成 MFC-037。仍需另造“平台 API 在 MFC 调用期间返回 400”
   的用例复验快停正则。
2. **门禁红时不显示合入按钮**：代码路径存在，且当前绿时按钮正确出现；本轮
   没有在同一真实任务上动态拨红再拨绿。相关单测只能作补充，不能替代真链。
3. **Linux hardlink 旧现场拒绝**：本轮用无 hardlink 的独立源仓验证了不新增
   hardlink；没有另外在 Linux root 容器手造 `cp -al` 旧现场验证拒绝文案。

### 给 CC 的下一轮修复顺序

1. **先修 P0 完整性链**：MFC-036（定格基线祖先门禁）→ MFC-037（冲突门禁
   单一事实 + 409 可恢复）→ MFC-038（merged SHA 与验证/人审 SHA 绑定）。
2. **再修人审可用性**：MFC-034（专注审阅批注）→ MFC-035/040（最近检视
   diff、范围按钮、统计失败显式化）。
3. **最后收交互**：MFC-033（固定仓旧草稿裁字段）、MFC-039（等待合入折叠
   展示）、交付白名单卡片合并。
4. 修完必须新增三类集成测试：Agent 重排到 baseline 父提交；MR source SHA
   在 await_merge 被替换；MR merge POST 409 后任务派窄冲突修复并重新人审。

### 本轮本地回归结果

- `npm test -- --runInBand`：953 项，945 通过，0 失败，8 项按环境跳过；
  其中现有 hardlink、批注回执窄使命、等决定期 committer 批注等测试均绿。
- `npm run typecheck`：主 tsconfig 与 contract tsconfig 均通过。
- `git diff --check`：通过。
- 结论：上述新问题不是现有单测红灯，而是测试覆盖缺口；尤其缺
  “定格基线祖先关系”“MR 当前 SHA 与 attestation 绑定”“真实专注审阅 DOM
  点击”三类动态断言。

## CC 第二轮修复记录(2026-08-30 深夜,commit 54d7af0 + 43dc301)

按「给 CC 的下一轮修复顺序」执行,全部落地;验证口径:typecheck 双配置
+ web tsc + 全量测试。逐项与建议的对照:

### P0 完整性链

- **MFC-036 已修(54d7af0)**:`tryDeliver` 在 Build-Fix 之前用
  `frozenTaskBaseline`(只认 step_heads.branch_create,**不许**用
  merge-base 自愈回退——它永远自证祖先,门禁会恒绿)做
  `merge-base --is-ancestor` 校验;历史脱离时若工作区已收口,宿主用
  `commit-tree`(旧 HEAD 的树 + 定格基线为父)机械重放,重放合同=
  树逐字节一致 + 祖先恢复,任一不成立回原 HEAD 停摆。推送前复核
  (repair=false)只停不改写。整理使命删掉"或重排提交"的错误教唆,
  写死"不得 reset/rebase 触及基线及更早提交"。附带:
  reconcileConfirmedDeliveryBoundary 的锚点候选补上定格基线兜底。
  集成测试:重排为 orphan → repaired(HEAD^==基线、树不变);二次
  脱离 → blocked 不动 HEAD;未收口 → blocked 不改写。
- **MFC-037 已修(54d7af0)**:假平台 `conflict_passed` 改用 bare 仓
  真实 `merge-base --is-ancestor <target> <mr.sha>`,测试布尔只保留
  强拨红方向;merge POST 409 返回人话 HTML(原因+返回 MR 页+说明
  任务侧会自动接手)。宿主 dispatchConflictRepair 本来就在,门禁说
  真话后恢复链自动生效(mrLoop 18 项全绿,其中冲突环用例现在靠真实
  分叉触红)。集成测试:目标分支前进→门禁即红/无合入按钮/409 人话页
  →任务侧合并重推→门禁回绿→正常合入。
- **MFC-038 已修(54d7af0)**:门禁契约新增 `sha`(MR 源提交);
  `settleMergeState` 收 observedSourceSha,merged 且与 delivery.sha
  不符→拒绝 completed,停摆点名两个 SHA;watchMerge 每拍在 opened
  态也核对,发现被替换立即停摆。四个 settle 调用点全部接线。
  集成测试:await_merge 期间 MR sha 被换并翻 merged → 不 completed,
  stalled 点名已验证 SHA。**边界**:旧平台契约无 sha 字段时退化为
  旧行为(无法核对);内网真平台适配须补该字段。

### 人审可用性

- **MFC-034 已修(43dc301),根因坐实**:不是事件委托逻辑错,是
  `.diff-column-resizer`(left:50%、全高、z-index:4)恰好压在每行
  几何中心——自动化点击打元素中心,target 永远是把手。修法:
  ①`pickRowFromStack` 沿 `elementsFromPoint` 整叠穿透找行(只认
  自身/祖先带 data-l;**不用** pickRow 的容器回退,叠层里躺着整块
  画布,回退会错落到第一行);②把手拖动收尾的 click 不外泄(原地
  单击仍放行给批注层)。纯逻辑测试按真实 DOM 形状(把手/行/画布叠层)
  复现并钉死。**未做浏览器级测试**:仓库零外部依赖,无 jsdom/vitest
  基建;下一轮 E2E 请真点专注审阅行(包括行中心与分栏线附近)。
- **MFC-035 已修(43dc301)**:delivery 新增 `last_reviewed_head`,
  push 确认卡被人解决(通过或返工)即钉住;复检基点优先级
  last_reviewed_head > selection.head > git_push.sha。单一范围渲染为
  不可点状态标签。测试:返工轮复检卡 base_sha==人上次看过的 HEAD、
  has_focused_changes=true。
- **MFC-040 已修(43dc301)**:比较不可得时 push_review 带
  `stats_unavailable_reason`,前端显示原因,不再摆 +0/−0;正常路径
  行为不变。MFC-036 门禁在更早处拦基线偏离,此字段是最后的诚实兜底。

### 交互收尾

- **MFC-033 已修(43dc301)**:launch-options 到手且 repo.enabled=false
  时立即清空草稿恢复的 repos 与技术画像;提交/知识预览按 enabled 裁
  字段;服务端拒绝保留为最后防线。
- **MFC-039 已修(43dc301,按用户拍板方案原样)**:删除 ws-merge-focus
  大卡;默认一行"等待合入",点开展开一句说明(waiting_on 有值用
  waiting_on)+ MR 链接;MR 被关闭保持直接可见的警示条。
- **交付白名单卡片合并(勾选/单选/CTA 三处拆散)未动**:整卡重排是
  专门交互优化轮的活,本轮不夹带。

### 给下一轮 E2E 的增量验证点

1. Agent 重排历史(或手工 reset --soft 到 orphan)后继续交付:应看到
   宿主日志"已机械重放净改动",MR 可快进合入,不再出现反向文件 commit。
2. 双 MR 竞争同一目标分支:后合入的一单应在门禁处直接红
   (conflict_passed 带"先在任务侧合并目标分支"),数拍内自动派冲突
   修复,而不是点合入才 409。
3. await_merge 时在平台侧直接改写源分支/换 SHA 合入:任务必须停摆
   点名两个 SHA,绝不 completed。
4. 专注审阅:普通点击行、点行几何中心、点分栏线附近、拖动分栏后单击,
   四种都应出批注编辑器或明确提示;399px 窄屏同验。
5. 固定仓部署 + 残留旧草稿的浏览器 origin:下单应直接成功,不再
   400"不接受逐单代码仓"。
6. 多轮返工后复检卡:应有"这次修改"(基点=上一张卡的 HEAD)且
   统计非零;若出现"统计不可用"文案,说明基线偏离——按 1 排查。

## 第三轮：不按旧清单造场景的正常用户 E2E（2026-08-30）

本轮刻意不沿用上一轮的故障注入脚本。以普通开发者 `normal_dev` 从登录、
发起一条真实小需求开始，只在界面自然要求确认时操作；不改 Git 历史、不换
MR SHA、不拨冲突门禁、不删除回执。运行环境为真实 GLM `glm-5.1`、Linux
Docker 编码/Build-Fix 容器、固定仓部署和假平台整链。

需求为 `REQ2026083003 · 文本截断不要截断 Emoji`：只改
`TextUtil.truncate`，按 Unicode code point 截断并补既有测试。任务从配置
确认、局部修改范围确认、编码、Build-Fix、最终检视、推送、三项平台门禁到
MR 合入完整走通；验证/人审/平台源 SHA 均为 `bbcf11245430…`，任务最终
`completed`。源仓检查为：仅 `master` 分支、`.git/objects` 硬链接数 `0`、
工作区干净；任务容器全部回收。假平台 bare 仓的 `master` 与任务分支最终均
指向 `bbcf112…`。

本轮不是“全绿即结束”：以下四项均由正常点击自然暴露，并已在同一轮当场
修复、重建前端、回到原任务复验。

### MFC-041 · P1 · “查看完整交付”仍是假按钮（已修）

- **实测**：最终推送卡左侧已经显示“完整交付”，右侧仍出现“查看完整交付”
  按钮。真实点击只获得焦点，范围、内容和滚动位置均无变化。
- **根因**：MFC-035 只把左侧单一 scope switch 改成了状态标签；
  `WaitingCard` 的摘要动作是另一条渲染路径，只要收到 `onLocateDelivery` 就
  无条件画按钮。`TaskWorkspace` 在目标 scope 与当前 scope 相同时仅刷新
  `livePulse`，所以用户看不到任何动作。
- **修复**：工作台把当前真实 `activeDeliveryScope` 传给决策卡；目标范围
  已在左侧时渲染“完整交付已显示/这次修改已显示”状态，不再伪装按钮；位于
  其他页签时仍保留导航按钮。动态复验：在“批注与检视”点击可回到交付材料，
  回到后按钮立即变状态。

### MFC-042 · P2 · Agent 说明把窄决策栏挤成一坨（已修）

- **实测**：`Agent 说明`、长篇阶段收尾回复、两条 commit 和范围按钮连续
  堆在窄右栏。三行截断仍占很大面积，Markdown 标题/列表又被压成行内文字。
- **根因**：`concisePushReviewNote()` 把 `lastReply` 的所有空白折成一行；
  前端再把它放进固定三行 paragraph，commit 列表始终同时展开。它虽“截短”
  了字符，却没有降低默认信息层级。
- **修复**：Agent 说明和提交记录合并为默认一行的
  `Agent 交付说明 · N 个提交` 折叠区；需要时展开，正文限高滚动。当前任务
  上实测默认只占一行，展开/收起均正常。

### MFC-043 · P2 · 专注审阅的结构点击会误报“没有行号可锚定”（已修）

- **实测**：目录/文件切换后代码虽能正常打开，页面仍可能冒出“这一处没有
  行号可锚定”的批注提示，像是刚才的文件点击失败了一半。
- **根因**：`Annotatable` 包着整个 Git 审阅器；当点击没有落到 `data-l` 时，
  只要目标不是 button/link 就统一报批注落点失败，目录树、标题、分栏结构的
  空隙也被当成材料正文。
- **修复**：只有落点确实位于 `.ws-doc` 或 `.diff-review-body` 正文时才给
  “无锚点”解释；审阅器结构点击静默交还自身。动态复验：专注审阅中展开
  目录并点击 `TextUtil.java`，文件正常切换且误提示不再出现。

### MFC-044 · P1 · 任务已完成但进度仍停在“等待权威流水线”（已修）

- **实测**：MR 合入后 banner 已是“已完成”、下一步是“可在交付历史中复盘”，
  但进度标题和当前节点仍是“等待权威流水线”，会让人以为尚未真正结束。
- **根因**：任务有内核 `progress` 时 `workspaceProgress()` 原样返回；它记录的
  是最后执行步骤，不会凭宿主交付终态再写一个阶段。`TaskProgress` 又不知道
  task status，因而忠实展示了完成前的最后一步。
- **修复**：把 API 的 `completed` 终态传给统一进度组件；仅在展示层追加并
  选中“完成”节点，不改内核现场。原完成任务刷新后实测为“当前阶段：完成”，
  六个执行阶段均为过去态，最后“完成”为当前态。

### 本轮验证结果

- 相关前端/落点测试：13/13 通过。
- 全量 `npm test`：969 项，961 通过，0 失败，8 项按环境显式跳过。
- `npm run typecheck`：主配置与 contract 配置通过。
- `web npm run build`：通过；构建产物在正在运行的服务上刷新后动态复验。
- `git diff --check`：通过。
- 正常用户整链：登录、固定仓下单、配置确认、规格确认、真实编码、
  Linux Build-Fix、完整交付检视、文件白名单、推送、三门禁、MR 合入、
  completed 全部通过。
- 旧挂账未冒充新问题：交付树仍会列出默认不推送的 `.gitignore`、
  `build.log`、`test.log` 与需求落盘文件；本轮未改交付白名单三处拆散的已知
  交互债。

## 第四轮：正常使用中直接修剩余交互（2026-08-30）

用户要求不再只记录问题：先提交已复验的四项修复（Cloud `7e14e82`），再把
正常操作仍会遇到的剩余问题直接修完并看效果。本轮继续使用第三轮真实 GLM
任务留下的 8 文件交付快照，在隔离的只读预览代理中把任务恢复成“等待最终
检视”；页面、真实 diff 与用户登录态均来自正在运行的产品，只替换任务终态，
不修改已合入任务账本，也不提交最终决定。

### MFC-045 · P1 · 文件去留、流程决定和生效按钮分裂（已修）

- **实测**：左侧文件树负责勾选，右侧单选负责“通过/返工”，底部按钮又只写
  “确认推送范围并继续”。用户必须在三处拼出同一件事，无法从按钮知道最终
  会推几个文件；返工时按钮仍像要推送。
- **根因**：`GitDiff` 独占选择状态，`WaitingCard` 只收到只读汇总；右栏因此
  只能解释，不能直接改范围。CTA 又只按“范围是否变化”命名，没有按决定分支
  命名。
- **修复**：右栏新增完整“本次交付范围”控制面，每个文件明确标成“纳入交付 /
  仅留本地”并说明后果，可直接逐项或批量修改；与左侧 diff 树双向同步。通过
  分支 CTA 为“按这 N 个文件推送”，返工分支为“提交返工意见”；零文件不能
  误走通过。真实 8 文件页面实点 `.gitignore` 后左右均从 4/8 变成 5/8；切换
  通过/返工后 CTA 分别正确且可用。

### MFC-046 · P2 · 工作台打开后后台列表重复一套决定内容（已修）

- **根因**：个人任务列表和工作台是两个并存的 React 渲染入口；打开工作台只
  叠加 dialog，后台 `TaskCard` 仍按个人可操作模式展开决定表单。
- **修复**：当前任务工作台打开时，对应列表卡降为只读“等待负责人拍板”信号，
  决定表单只保留工作台右栏这一份。隔离页面 DOM 复验没有第二张决定表单。

### MFC-047 · P2 · Agent 说明展开后仍是压平的 Markdown（已修）

- **根因**：MFC-042 只收起了默认展示；服务端仍用 `\s+` 把标题、段落和列表
  全压成一行，前端展开后只是把这条长字符串放大。
- **修复**：服务端清洗时保留换行和列表结构，长度上限提高到 720 字；前端用
  同一 Markdown 组件渲染。真实卡片展开后标题、三条清单和 commit 分层显示，
  默认态仍只占一行。

### MFC-048 · P2 · 本地日志噪声抢占交付树（已修）

- **原则**：不复活旧问题 MFC-030——未提交文件仍必须如实可见，不能靠隐藏
  制造“工作区干净”。
- **修复**：`工作区其他改动 · 默认仅留本地` 成为默认折叠分组，标题保留真实
  数量；展开后 `.gitignore`、`build.log`、需求落盘和 `test.log` 全部仍在，
  每项可纳入交付。真实页面复验默认只占一行，展开准确显示 4 项。

### MFC-049 · P1 · 提交格式门禁拒绝组合命令后 Agent 容易漏暂存（已修）

- **实测根因**：Agent 首次发出 `git add <精确文件> && git commit -m ...`，因
  commit message 不合规被 PreToolUse 拒绝；门禁实际阻止整次 Bash 调用，前面的
  `git add` 也没有执行，但回执只讲格式。Agent 随后只重跑正确的 `git commit`，
  又因没有暂存失败。
- **修复（内核唯一权威）**：在兄弟内核仓 `mae-flow@ad5b92a` 修改
  `bash-commit-format` 回执，明确“整条 Bash 未执行、前置 git add 也没执行”，
  要求先 `git status`，再重跑原精确暂存和正确提交，并给出带真实单号的命令
  示例；Cloud 通过 `harness/sync-kernel.sh` 收编该提交，没有在 TS 复刻门禁。

### MFC-050 · P1 · 等最终人审时当前进度仍写“等待权威流水线”（已修）

- **实测**：最终检视页的“下一步”已写“检视代码并决定推送或返工”，进度大
  标题却仍是内核上一个自动步骤“等待权威流水线”，同屏事实互相冲突。
- **修复**：仅在 `waiting_for_human` 的工作台展示层把 `focus.headline` 作为
  当前步骤标题；阶段序列、当前阶段索引和内核证据账完全不改。页面复验标题为
  “代码已经验证，等你确认交付范围”。同时把目录勾选的读屏文案从“提交 /
  不提交”统一为“纳入交付 / 改为仅留本地”。

### Linux 专项复验

- 干净 `node:22-bookworm-slim`（Linux aarch64）重新安装两层依赖，主/contract
  TypeScript 检查和 Web 生产构建通过，未复用 macOS `node_modules`。
- `node:22-bookworm`（Git 2.39、Python 3.11）运行本轮 38 项交付/工作台/内核
  组合测试全部通过。
- 非 root `node` 服务账号在 Linux 容器中用真实 GLM 配置成功启动生产前端和
  HTTP 服务，8 秒 smoke 结束时 SIGTERM 正常停止并确认 0 项资源残留；root
  启动则按安全边界明确拒绝，符合正式部署要求。
- 最终本机全量回归：974 项，966 通过，0 失败，8 项按环境显式跳过；
  `typecheck` 双配置、Web 生产构建和 `git diff --check` 均通过。

## 第五轮：单仓交付单元拆分真模型 E2E（2026-09-01）

现场按要求完整保留在 `.pilot/e2e-unit-split-glm-20260901/`，业务仓、任务
工作区、诊断包和假平台 bare 仓均未删除。本轮使用真实 GLM `glm-5.1`、真实
Linux 构建容器和假平台 MR/流水线；不是只读代码或只跑剧本测试。

核心需求为「通知偏好 + 发送前过滤」，单仓拆成契约骨架、偏好实现与过滤、
偏好入口与链路三个单元。第一单元真实提交 `3fae613`（23 文件，+365/-7），
Build-Fix、COMPILE、UT、CODECHECK 全绿，MR !1 合入；合入前第二单元严格
等待，MR 合入后自动启动，第三单元仍继续等待第二单元。另起单仓不拆分回归
`REQ2026090110`，真实提交 `e2e4541`、MR !3 全绿合入；另起两仓回归，分析
后生成 task-7/task-8，两个任务均无 `blocked_by` 并真实并行起跑。

### MFC-051 · P0 · 重复子单号被挡住后无处修改（已修，5ab233c）

- **实测失败现场**：三单元确认时准确报出“同仓、同责任人、同单号，分支名
  会互相覆盖”，但卡片只有确认按钮，没有任何单元 AR 输入框，用户被永久卡住。
  即使前端补输入框，服务端原实现仍先拿继承的父单号做冲突校验，再应用本次
  提交的覆盖值，同样无法解锁。
- **根因**：单仓拆分沿用了多仓“AR 在下单时已经确定”的只读渲染分支；
  `requirementGraphPlan()` 又在覆盖值落袋前读取旧图做碰撞校验，前后端是同一处
  合同断裂。
- **修复与复验**：同 URL 出现多个单元时逐单元显示可编辑 AR；计划校验直接
  使用本次原子提交的 ticket/assignee overrides。原现场填
  `REQ2026090101/02/03` 后确认成功，三子任务按各自单号创建。

### MFC-052 · P1 · 方案写“零 TBD”，负责面和下游决定仍不闭合（已修，5ab233c）

- **实测失败现场**：CHAIN 有「已确认事项清单」且无 TBD，第一单元也确为
  契约骨架；但 unit-1 的 `notify-service/src/` 吞住 unit-2 的子目录，任务书
  同时要求改 `notify-web/Main.java`、SDK 测试依赖却没有把
  `notify-web/.../Main.java`、`notify-sdk/pom.xml` 纳入 scope。编码后负责面
  门禁如实拦出这两个文件。进入 unit-2 后又连续问了已在主任务拍过的
  null-user 语义，并补问审计值域、DND 边界和装配归属，证明“文档无 TBD”
  不等于方案真的闭合。
- **根因**：分析 prompt 只要求模型写改动面和“无 TBD”，没有机械核对
  “任务书提及路径 ⊆ 本单元 scope”及同仓 scope 唯一归属；确认入口也接受
  相互包含的路径。子任务只被告知去读 CHAIN，没有把「已确认事项清单」声明
  为不得重复询问的权威输入。
- **修复**：①改动面强制沿运行链和构建链检查调用点、装配点、资源、模块构建
  文件与测试依赖；②确认入口机械拒绝同仓 scope 缺失、相等或按路径段互相
  包含，并点名两个单元和冲突路径；③契约单元职责提到的所有接缝必须在本单元
  scope；④子任务书明确已确认事项不得换说法重问，只有新决定或代码事实冲突
  才能举卡。测试包含宽面 `src/contract/` 吞
  `src/contract/filter/` 的真实拒绝用例。

### MFC-053 · P2 · 越权裁决 403 不告诉用户具体找谁（已修，5ab233c）

- **实测失败现场**：以 `outsider` 登录 task-2 真点「放行」，HTTP 真实返回
  403、现场未变化，但文案只有“只能由主任务责任人裁决”，没有点名账号。
- **根因**：路由已计算出 `decider` 并正确鉴权，返回文案却丢掉了这个值。
- **修复与复验**：403 现在返回“只能由主任务责任人 `<账号>` 裁决，请联系
  该账号处理”；补起真 HTTP 服务、两个真实登录态的测试，`other-dev` 点击后
  403 正文点名 `main-owner`，待裁决文件原样保留。

### MFC-054 · P2 · 模型额度耗尽把网关 JSON 糊到任务卡（已修，5ab233c）

- **实测失败现场**：task-7/task-8 并行运行时真实 GLM 返回 429，任务卡展示
  `rate_limit_error`、内部 code、request_id 和整段 JSON；真正有用的重置时间
  被埋在中间。
- **根因**：`SessionDriver.turnOutcome()` 对模型层错误直接 `String(error)`，
  没有像交付平台错误那样做面向用户的定向翻译。
- **修复与动态复验**：仅对明确的 429/额度错误收敛成“额度已用完，将于
  2026-09-01 03:34:40 恢复；恢复后点重跑续推，数据不会丢失”；其他未知故障
  仍保留原文。重启新版本后对 task-7 真点重跑，真实 429 已按上述人话展示，
  DOM 中不再出现 `rate_limit_error` 或 request_id。

### 逐项实测结论

#### 场景一：单仓拆三块

1. **实测通过（有一项质量失败并已修）**：分析先读代码，再分两批提问，每题
   均有建议；未把可从仓库确认的文件/接口事实问人。子任务重问已拍板语义为
   MFC-052，修复后任务书契约已钉死。
2. **实测通过**：划分方向卡固定出现；核心单选择「你看着切」后继续生成方案。
3. **实测失败后已修**：第一个单元确是契约骨架并全仓编译通过，注册与 service
   pom 也归它；但 SDK pom/Main 接缝遗漏、scope 与 unit-2 重叠，见 MFC-052。
4. **CHAIN 通过、scope 失败后已修**：CHAIN 有完整已确认清单且无 TBD；旧图的
   scope 不闭合。新确认门禁会在建子任务前拒绝这种图。
5. **实测失败后已修并通过**：不给子单号会被可读地拒绝；原卡无输入出口，
   MFC-051 修复后填三个子单号成功。
6. **实测通过到关键解锁点**：task-3 在 task-2 合入前始终等待；MR !1 merged
   后 task-3 自动启动，task-4 继续等待 task-3。后续全链被下述真实模型额度
   外部边界截停，未伪报三单元全完成。
7. **实测通过**：三个子任务正文均含第 N/3、职责、负责面、上下游和单号；
   每个工作区都有 `chain-plan.md`，列表标题能区分同仓单元。

#### 场景二：负责面与越界裁决

1. **实测通过**：提交 `3fae613` 在 push 前停摆，明确点名「契约骨架」及
   `notify-sdk/pom.xml`、`notify-web/.../Main.java`，未提前创建 MR。
2. **部分通过**：工作台真实出现裁决卡；本轮主责任人和单元责任人都是 owner，
   没有构造“通知另一个账号”的真浏览器场景，因此“异账号收到通知”不冒充
   已验。服务层仍有按主责任人发送的既有路径。
3. **实测失败后已修并通过**：outsider 真点为 403 且不改状态；原文案不点名
   找谁，MFC-053 修复并补真 HTTP 登录态复验。
4. **放行实测通过；打回如实停下**：放行后同一 SHA 续推，两个越界文件进入
   23 文件最终检视清单并随 MR !1 合入。打回使命只允许撤点名文件且禁止
   reset/rebase；Agent 核实撤掉任一文件都会破坏编译，因而没有伪造撤出，
   原 HEAD `3fae613` 与面内实现全部保留。此结果证明旧拆分方案错误，不算
   “打回成功撤出”。
5. **实测通过（真实 Git 服务门禁）**：scope 为 `src/filter/` 时，提交中的
   `src/filterX/other.ts` 被列为越界，路径段闭合判定正确。

#### 场景三：回归

1. **实测通过到并行起跑**：多仓不显示单仓勾选项、自动分析；两个原始 AR
   `REQ2026090120/21` 保留到各自单元，task-7/task-8 均无 blocked_by 并真实
   并行进入内核。两会话随后同时命中真实 GLM 5 小时额度，未伪报 MR 收口。
2. **实测通过（完整链）**：单仓不勾选没有 analysis 阶段；task-5 直接走旧
   局部修改链，真实编码、Build-Fix、最终 diff、三门禁、MR !3 合入、completed。
3. **实测通过**：Chain 节点显示“仓名 · 单元名”和负责面；父卡显示 0/3、
   1/3 已合入及当前单元；同仓三个子任务在列表中可直接区分。

### 外部边界与恢复现场

- task-3 因模型单轮输出达到上限停在可恢复位置，自动诊断包：
  `task-3/diagnostics/2026-08-31T17-28-18-369Z-1e652b3c.md`。
- task-7/task-8 因真实 GLM 五小时额度于 03:34:40 前耗尽停下；task-7 已用
  新版本重试确认人话错误，现场与重跑入口均保留。该外部额度使“核心后三个
  单元全部合入”和“多仓两个 MR 全部合入”本轮不能宣称通过。
- 单仓直干 MR !3 与契约骨架 MR !1 均已真实合入，不受上述额度边界影响。
- 修复后全量回归：1054 项，1046 通过，0 失败，8 项按环境显式跳过；
  TypeScript 主/contract 双配置、Web 生产构建与 `git diff --check` 均通过。
  所有 task-2/3/4/5/7/8 克隆仓 `.git/objects` 硬链接数均为 0。
