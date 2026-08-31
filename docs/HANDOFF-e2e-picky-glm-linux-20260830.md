# MFC 真实 GLM + Linux 端到端挑剔测试修复交接

> 日期：2026-08-30
>
> 接手对象：CC / MFC 维护者
>
> 测试方式：真实 GLM API、MFC Web 全流程点击、Linux 隔离容器、Java Maven 示例仓、Fake Git Platform
>
> 结论：**No-Go。当前不适合把“批注返工 → Build-Fix → 最终复检 → MR 合入”视为可无人值守闭环。**

## 1. 测试现场与最终状态

- MFC 仓：`/Users/liaoxiang/dev/mae-flow-cloud`
- 业务靶场任务仓：`.tasks/e2e-picky-20260830/task-1/mae-flow-fieldtest-java`
- 任务：`task-1` / `REQ2026081101`
- 基线：`8e7f2ad6e8a6a4179a23fb00f4c711c2fb3f1f65`
- 最终业务 HEAD：`76d0aae5fe702a318c1bcee2ccfeae2f2cf7b82e`
- 最终交付范围：17 个文件，基线到 HEAD 为 `+815/-12`
- 最终任务状态：`await_merge`
- Linux Build-Fix：compile 通过，SDK 3 项、service 20 项 UT 全绿，CodeCheck / 假流水线为绿
- MFC 自身校验：typecheck 通过；定向 UI 测试 59/59；全量 943 项中 934 通过、1 项超时、8 项跳过；超时用例单跑通过，属于疑似 flaky
- 本轮测试前后均未修改 MFC 业务源码；本文件是新增的交接文档

为了继续验证后半程，测试中使用了两个**人工恢复动作**，因此后半程不能算自然通过：

1. 软删除无法闭环的批注；append-only 审计记录仍在。
2. 将已确认的同一业务 HEAD 手工补推到 FakeGitPlatform 的本地裸仓，否则 MR 创建永远 HTTP 400。

## 2. 优先级与建议修复顺序

| ID | 优先级 | 问题 | 根因状态 | 建议批次 |
| --- | --- | --- | --- | --- |
| MFC-001 | P0 | 本地 clone 硬链接 Git 对象，任务可污染源仓/兄弟任务 | 已定位 | 第一批 |
| MFC-002 | P1 | pre-MR 批注返工缺逐条回执，形成不可闭环死锁 | 已定位 | 第一批 |
| MFC-003 | P1 | 缺回执后的“重跑续推”清空 review loop | 已定位 | 第一批 |
| MFC-004 | P1 | FakeGitPlatform 忽略逐单 repo，push 与 MR 查不同仓 | 已定位 | 第一批 |
| MFC-005 | P1 | Fake MR 没有页面和合入 API，浏览器无法完成 E2E | 已定位 | 第一批 |
| MFC-006 | P1 | Linux 镜像只有 `python3`，内核/提示反复调用 `python` | 已定位 | 第一批 |
| MFC-007 | P1 | 增量 Diff 已实现，但入口、标题和 SHA 表达不一致 | 已定位 | 第二批 |
| MFC-008 | P1 | 小窗口“专注审阅”代码区不可见 | 已定位 | 第二批 |
| MFC-009 | P2 | `await_merge` 仍显示“最终范围 2/21”，与 17 文件矛盾 | 已定位 | 第二批 |
| MFC-010 | P1 | “执行方案与定格不一致”告警来源/判据错误 | 已定位 | 第二批 |
| MFC-011 | P1 | 模型设置协议与健康检查协议不一致 | 已定位 | 第二批 |
| MFC-012 | P1 | Linux systemd 示例与 isolate user 启动约束冲突 | 已定位 | 第一批 |
| MFC-013 | P1 | 构建缓存重建后 ownership marker 可能陈旧 | 已定位 | 第一批 |
| MFC-014 | P1 | Issue Flow 隔离/凭据边界偏宽 | 静态审计已定位 | 第一批 |
| MFC-015 | P2 | 容器资源检查没有核验 Memory/NanoCpus/User | 已定位 | 第二批 |
| MFC-016 | P1 | 时间耗时统一偏移约 8 小时 | 已定位 | 第二批 |
| MFC-017 | P2 | 通知 BEL 无桌面效果，相关环境未透传 | 高概率根因 | 第三批 |
| MFC-018 | P2 | 密码、帮助搜索、标点门禁、Story 自检等 UI/流程细节 | 部分已定位 | 第三批 |
| MFC-019 | P1 | Agent 擅自重写 Git 对象并删除 core，缺少高风险动作闸门 | 现象确定 | 第一批 |
| MFC-020 | P2 | 外部交付失败时同一 MR 400 高频刷屏 | 现象确定 | 第三批 |
| GEN-001 | 阻断 | 超时记为 FAILED，但不可中断发送可能迟到成功 | 已定位 | 业务样例单独修 |

建议 CC 严格按以下顺序处理：

1. `MFC-001/002/003/006/012/013/014/019`：先修数据安全、Linux 可运行性和批注闭环。
2. `MFC-004/005`：让 Fake 平台真正支持逐单仓与浏览器合入，恢复可重复的端到端测试能力。
3. `MFC-007/008/009/010/011/016`：修人审页面的事实一致性。
4. 其余 P2 和生成代码问题另批处理。

---

## 3. MFC-001：本地 clone 硬链接 Git 对象（P0）

### 用户/现场表现

- Linux 容器内 `git commit` 返回 128，并报多个 loose object `corrupt`。
- `git fsck` 报 `unable to mmap ... Permission denied`。
- 容器内调用者与对象都是 `10001:10001`，mode 为 0644，普通 `cat` 仍 EACCES。
- 宿主可以正常读相同对象；复制并 `rename` 生成新 inode 后，`cat-file` 和 `fsck` 恢复。
- 任务对象修复前 `nlink=2452`，脱离硬链接后 `nlink=1`。
- `510a5fa` 实际已更新 HEAD；Git 是在 ref 更新后的摘要/后续读取阶段失败。

现场证据：

- `.tasks/e2e-picky-20260830/task-1/transcript.jsonl:538-568`
- `.tasks/e2e-picky-20260830/task-1/task.json`

### 已定位根因

任务来源是宿主本地绝对路径仓。正式 clone 使用：

- `src/taskService.ts:13578-13617`
- `src/issueFlow/issueGit.ts:195-213`

本地 `git clone source target` 默认通过 hardlink 复用 `.git/objects`；代码没有使用 `--no-local` 或 `--no-hardlinks`。仓库 Skill 临时 clone 已有正确先例：

- `src/repositorySkills.ts:273-279`

任务 cwd 被整体 RW bind 给容器：

- `src/taskService.ts:9133-9139`
- `src/containerRuntime.ts:879-910`

即使源仓另一条挂载是 `:ro`，任务 `.git/objects` 的 RW hardlink 仍是同一个 inode 的别名。任务从 RW 别名执行 `chmod/chown/truncate` 会影响源仓与兄弟任务。

Linux root 部署还会递归 chown 任务仓，不检查 nlink：

- `src/taskService.ts:1700-1723`
- `src/containerOwnership.ts:81-113,181-207`

### macOS/Colima 与原生 Linux 的边界

本次“同 UID、0644，仍 `cat/mmap EACCES`，换 inode 立刻恢复”的**精确表现**高度像 macOS + Colima VZ/virtiofs 与高链接 APFS inode 的交互，不应宣称原生 ext4/xfs 必现。

但“任务对象与源仓/兄弟任务共享 inode”是与虚拟化无关的确定性设计缺陷，在原生 Linux 同样成立；root 下递归 chown 风险更高。

`loose object corrupt` 是读取/mmap 失败的下游诊断，不足以证明 zlib/hash 字节已经损坏。core 已被 Agent 删除，当前不能回溯具体 Git 崩溃栈。

### 建议修复

- 两条正式本地 clone 路径统一加 `--no-local`，或显式 `--no-hardlinks`。
- clone 完成后可在 debug/selfcheck 模式抽样对拍源/任务对象 `dev:ino`，发现相同立即拒绝任务启动。
- ownership 准备前拒绝对 `nlink > 1` 的 Git 对象执行递归 chown。
- 不要用 alternates 代替隔离；持久 alternates 仍会制造生命周期耦合。

### 必加回归测试

1. 本地普通仓、bare 仓、Issue Flow 三种 clone，源/任务对象 `dev:ino` 必须不同。
2. 执行 ownership 准备后，源仓对象 uid/gid/mode/ctime 不变。
3. 两个兄弟任务分别 chmod/写对象时不得影响对方或源仓。
4. 真 Linux root 容器内执行 `git fsck --full --no-dangling`。

现有测试缺口：

- `tests/cloneCredentialBoundary.test.ts:117-128` 只验内容/config，不断 inode。
- `tests/containerOwnership.test.ts:222-249` 使用孤立 object，不制造源仓 hardlink。
- `tests/issuePullRepoOwnership.test.ts:133-159` 不断言 origin 元数据不变。

---

## 4. MFC-002/003：pre-MR 批注回执死锁（P1）

### 完整复现链

1. 在最终代码 Diff 的 `SmsChannelHandler.java:25` 创建行级批注。
2. 在 pre-MR push 确认卡选择“需要调整代码”。
3. Agent 收到批注、修改代码、提交、Build-Fix 通过。
4. 新 push 卡提示“1 条意见未闭环”，直接放行被服务端正确拦截。
5. “批注与检视”页没有“确认已修复 / 仍需调整”按钮；只有编辑和删除。
6. 再选“需要调整代码”后，Agent 又改了 3 个文件，但没生成 `local-receipts.json`。
7. 系统停机并提示缺 `an-mtflkqly-1` 回执。
8. 点击“重跑续推”后，新 push 卡出现，但 review loop 被清空，批注仍只有 `sent`、没有 `respond`。
9. 最终只能软删除批注继续。

审计账证据：

- `.tasks/e2e-picky-20260830/task-1/annotations.jsonl`
- `.tasks/e2e-picky-20260830/task-1/reviews/local-annotations.json`
- 缺失：`.tasks/e2e-picky-20260830/task-1/reviews/local-receipts.json`

### 已定位根因 A：pre-MR 返工使命漏回执契约

- push 非接受选项被识别为 feedback：`src/taskService.ts:7083-7094`
- unresolved 批注进入 continuation：`src/taskService.ts:7124-7165`
- helper 只把 draft 记为 sent，不会生成 response：`src/taskService.ts:6782-6804`
- `sent` 回放只改状态：`src/annotations.ts:157-175,280-283`
- 唯一合法 response 路径：`src/annotations.ts:285-320`
- pre-MR enqueue mission：`src/taskService.ts:6830-6870`

致命点是 `6830-6870` 生成的使命只带自然语言批注和清单整理要求，没有附上：

- `workspaceReviewReceiptInstructions()`：`src/feedbackPolicy.ts:126-139`

正确的 post-MR review 路径会显式拼入该契约：

- `src/taskService.ts:3709-3717`

所以首次漏回执不是单纯“GLM 偶发忘记”，而是宿主确定没有告诉它写机器回执。

### 已定位根因 B：UI 必须有 response 才允许裁决

- 全部 sent 批注都是 blocker：`src/feedbackPolicy.ts:14-22`
- push accept 拒绝：`src/taskService.ts:7094-7115`
- UI 裁决按钮要求 `reviewReady && item.response`：`web/src/AnnotationPanel.tsx:459-488`
- `reviewReady` 又要求当前 workspace-review push 卡：`web/src/TaskWorkspace.tsx:519-525`
- 服务端 verify 当前 cycle 也正确拒绝缺 response：`src/taskService.ts:3439-3475`

因此当前状态不是“按钮藏得深”，而是确实无合法用户路径闭环。

### 已定位根因 C：retry 清空恢复意图

- 缺 receipts 时任务会正确 halted/stalled：`src/taskService.ts:3775-3813`
- generic retry 随后直接把 `delivery.loop=undefined`：`src/taskService.ts:5590-5655`
- 此时上一轮 `mission` 已在 session settle 时清掉：`src/taskService.ts:14003-14019`

结果是 annotation 仍为 sent blocker，但 review_source、annotation IDs 和补回执使命都消失。

### 建议修复

- pre-MR 与 post-MR review 必须复用同一个 receipt prompt builder。
- missing-receipt retry 必须保留 loop、review_source、annotation IDs 和当前 revision。
- retry 应派一条“复核当前 HEAD 并补齐逐条回执”的窄使命，不能走 generic clear-loop。
- UI 增加“重新请求 Agent 逐条回应”，但仍不能允许无 response 直接 verify。
- Agent 不需要改代码时也必须允许 `outcome=fixed/not_fixed` + 当前 HEAD 的纯回执闭环。

### 必加回归测试

1. pre-MR push 卡：draft + already-sent → mission 必须含 receipt 契约。
2. 真跑 settle/consume：文件生成 → annotations `respond` → 作者 verify → push。
3. receipts 缺失 → retry → loop/IDs 保留 → 补回执 → 不新增无关 commit。
4. 不能用测试中手工 `annotations.respond()` 冒充真实链路。

现有缺口：

- `tests/pushConfirmation.test.ts:325-379` 只断 status/mission，不断 receipt prompt 和消费。
- `tests/pushConfirmation.test.ts:599-693` 手工构造 loop/response，绕过真实路径。

---

## 5. MFC-004/005：Fake 平台无法覆盖真实逐单仓与合入（P1）

### 用户/现场表现

- 最终确认后页面先显示“代码已提交，流水线验证中”。
- 随后 MR 创建持续 HTTP 400：Fake 平台 `git rev-parse master_picky_dev_REQ2026081101` 找不到分支。
- 业务分支实际已被宿主推到开发账号配置的源仓。
- Fake 平台查询的是另一份 `.tasks/.../origin.git`。
- 手工将同 HEAD 补到 fake bare 后，MR/流水线恢复为绿。
- “打开合入请求”链接是 `http://127.0.0.1:<port>/mr/1`；Fake 服务没有该 HTML 路由，也没有 merge HTTP endpoint，浏览器无法完成合入。

### 已定位根因

- `--fake-platform` 只用 `--repo` 初始化一个单一 bare：`src/serve.ts:421-433`
- bare 平台实现：`src/gitPlatform.ts:67-122`
- 任务允许逐单 repo，并优先 clone/push `summary.repo_url`：
  - `src/taskService.ts:4504-4507,4848-4863`
  - `src/taskService.ts:13374-13408,13457-13484,13547-13580`
- MR 请求携带 `repo`：`src/taskService.ts:10899-10944`、`src/mrClient.ts:51-60`
- Fake `createMergeRequest()` 完全忽略 `body.repo`，只在 `this.barePath` 查 source branch：`src/gitPlatform.ts:209-234`
- router 只有精确 `/mr` API，没有 `GET /mr/:id` 页面或 merge API：`src/gitPlatform.ts:133-193`
- 唯一合入能力是进程内测试 helper `settleMr()`：`src/gitPlatform.ts:304-309`

### 建议修复

推荐完整方案：

- Fake 平台维护 `normalize(repo) → barePath` 仓库注册表。
- MR、pipeline、gates、discussion 全部按请求的 repo 路由。
- 提供 `GET /mr/:id` 的最小 HTML 页面。
- 提供 `POST /mr/:id/merge`，并真实更新目标 ref，再把 MR state 置为 merged。
- 页面展示 source/target/SHA、流水线和合入按钮，足够完成浏览器 E2E。

若暂时不做多仓 Fake，则启动时必须明确禁止逐单 repo，而不是运行到最终 MR 才失败。

### 必加回归测试

- Fake seed repo A + 任务 repo B → clone B → push B → MR B → 打开页面 → merge → 任务 completed。
- `tests/gitPlatform.test.ts` 不得只从 `platform.barePath` 自己 clone/push。
- 不得只用 `platform.settleMr()` 进程内翻状态代替浏览器路径。

---

## 6. MFC-006：Linux `python` / `python3` 契约冲突（P1）

### 实测表现

真实任务中至少四次出现：

```text
sh: 1: python: not found
```

### 已定位根因

- 构建镜像只保证 `python3`：`deploy/build-image/Dockerfile:29`
- 内核/任务指令仍输出 `python`：
  - `kernel/scripts/mae_flow_core/.../current.py:383`
  - `src/taskService.ts:2499`

### 建议修复

- 契约统一为 `python3`，不依赖发行版是否提供 `python` alias。
- 若确需 `python`，镜像显式安装 `python-is-python3` 并加 selfcheck。
- 生成给 Agent 的所有命令必须使用宿主探测出的实际解释器路径，不写死命令名。

### 回归测试

- 在只有 `python3`、没有 `python` 的 Ubuntu 镜像中完成 init/current/manifest/domain archive 全流程。
- 搜索生成使命与帮助文本，禁止重新出现裸 `python`。

---

## 7. MFC-007：增量 Git Diff“已实现但不一致”（P1）

### 正确事实

“相较上次检视 HEAD”的能力已经实现，不是完全没做：

- backend 优先 `delivery_selection.head`，其次最近 `git_push.sha`：`src/taskService.ts:10301-10318`
- revision 比较与 ancestry 校验：`src/artifacts.ts:414-444`
- 返回 `base_sha/baseline_sha/head_sha/has_focused_changes`：`src/taskService.ts:10319-10334`
- UI 最终 push 卡默认“这次修改”：`web/src/TaskWorkspace.tsx:243,797-825`

本次实测：

- `a2f2715 → 510a5fa`：10 个返工文件。
- `510a5fa → 76d0aae`：3 个文件。

### 问题 1：中间 AskUser 卡绕过原生增量入口

Agent 自己生成的普通 `AskUserQuestion` 检视卡没有 `push_review`，因此多轮返工中间只能回整单累计 Diff 找变化。只有原生 `cloud_push_confirm` 卡展示“这次修改 / 完整交付”。

建议：普通代码检视卡若存在稳定前次审阅 HEAD，也应提供同一 Diff scope；不要让 Agent 卡和宿主卡使用两套审阅体验。

### 问题 2：增量模式标题仍写“任务基线至当前工作区”

- 硬编码位置：`web/src/GitDiff.tsx:539-544`

这会让真实的 HEAD→HEAD 增量看起来仍是 baseline→worktree。

建议：GitDiff 接收明确 `scope/base_sha/head_sha`，标题分别显示：

- `本次修改 · a2f2715 → 510a5fa`
- `完整交付 · 8e7f2ad → 76d0aae`
- `未提交工作区 · HEAD → worktree`

不要只返回 SHA 而不展示。

### 问题 3：完整交付与工作区本地文件的语义混杂

“完整交付”文案说待推送代码，但工作区材料同时包含 untracked/unstaged 文件。虽然最终选择门禁能排除，本页仍容易把“本地存在”和“将推送”混为一谈。

建议把以下三组严格分开：已提交且将推送、已提交但被排除、本地未提交。

---

## 8. MFC-008：窄屏专注审阅不可用（P1）

### 实测

约 399px 宽度时进入专注审阅：左侧约 240px 文件树仍保留，右侧代码区域越出屏幕，新增行基本不可访问。

### 已定位根因

- focused 三栏规则：`web/src/style.css:7020`
- 代码画布最小宽度 760px：`web/src/style.css:7183-7185`
- 窄屏通用规则：`web/src/style.css:8711`

`.git-change-view.is-focused .git-change-browser` 的选择器优先级压过窄屏 `.git-change-browser`，且 canvas 的 `min-width:760px` 保持溢出。

### 建议修复/测试

- 在 max-width 断点增加更高优先级的 focused override。
- 窄屏默认隐藏文件树，以抽屉/返回按钮切换。
- 代码画布允许横向滚动，但左右 diff 的关键列不能完全位于屏外。
- Playwright 覆盖 399×799、560px、768px 三档；断言新增行和行级批注按钮可点击。

---

## 9. MFC-009：await_merge 残留“最终范围 2/21”（P2）

### 实测

任务后端已确认 17 文件并进入 `await_merge`，页面同时显示：

- `本次提交 · 将推送 17`
- `最终推送范围：2 / 21 个文件`

后台 `delivery_selection.status=confirmed` 且仍为 17；这次没有污染远端事实，但页面事实自相矛盾。

### 已定位根因

1. App 用轻量 list snapshot 浅合并当前完整 task：`web/src/App.tsx:731-744`。
2. await_merge 的轻量对象省略 `waiting` 键，spread 不会删除旧 `cloud_push_confirm waiting`。
3. 完整 getTask 只在 artifactTaskId 变化时取一次：`web/src/App.tsx:746-754,842-845`。
4. `TaskWorkspace` 的 GitDiff selectable 只检查 `task.waiting?.recommended_view === "diff"`，缺少 `status === waiting_for_human`：`web/src/TaskWorkspace.tsx:863-870`。
5. pushReview 消失后旧 3-file content 没立即清空；GitDiff 将权威 17 先过滤成与 3-file scope 相交的 2，再在同 selectionKey 下只保留交集：`web/src/GitDiff.tsx:264-298`。

### 建议修复

- list API 明确返回 `waiting:null`，或 snapshot merge 对 volatile 字段做替换语义，不做普通 spread。
- selectable 同时要求 `task.status === waiting_for_human`、当前 waiting.step 为 cloud push confirm。
- pushReview 消失时立即清 content 并重载完整材料。
- delivery selection 以权威 all_paths/initialSelectedPaths 管理；展示 scope 不得破坏选择 universe。
- 分组标题改成事实表达，如“已提交 17”，不要冒充当前最终选择。

### 回归测试

- waiting push card → await_merge：waiting 必须消失，选择条不得渲染。
- focused 3（与17交集2）→ full 21：最终选择仍为17。
- 现有源码 regex 测试不足，需要真实 React 状态生命周期测试。

---

## 10. MFC-010：执行方案与定格不一致告警（P1）

### 用户表现

页面显示：任务下单时定格了工作流，但内核实际来源为 `platform_default+overrides`，因此“页面定格方案与实际不一致”。普通用户无法判断自己是否下错单、是否需要重开任务。

### 已定位根因

- UI 展示来源：`web/src/WorkflowProfileCard.tsx:7`
- 服务端只要有 workflow_profile，却没有 `compiled_final_plan`，就判为告警：`src/taskService.ts:2673`
- 内核执行方案仍可从平台默认 + overrides 正常编译：`kernel/.../execution_plan.py:326`

本次更像“定格展示数据与运行时编译产物没有使用同一个事实源”，不应由用户背锅。

### 建议修复

- 下单成功时原子持久化最终 compiled plan、来源、hash。
- UI 只展示内核真正消费的 plan/hash。
- 若只是 profile 展示缺 compiled projection，应报“方案投影缺失/正在恢复”，不要说 Agent 未按定格执行。
- 真不一致时提供 expected hash、actual hash、差异字段和恢复动作。

---

## 11. Linux 部署与隔离问题

### MFC-011：模型设置协议不一致（P1）

- 部署侧可配置 `anthropic-messages`：`src/server.ts:683`
- UI 健康检查会回落 OpenAI chat `/chat/completions`：`web/src/SettingsView.tsx:346,381`
- gateway check 分支：`src/modelGatewayCheck.ts:37,204`

结果是同一模型配置在实际 Agent 调用与设置页健康检查中可能走不同协议，产生假红/假绿。

修复：provider/protocol/base URL/path/model 必须由同一结构化配置驱动；健康检查调用与真实 runtime 同一 adapter。

### MFC-012：systemd 示例与 isolate user 冲突（P1）

- 部署文档 systemd 样例以 root 运行且没有 `User=` / `--isolate-user`：`docs/deploy-intranet.md:995` 附近。
- 容器启动约束会拒绝不安全的 root 配置：`src/containerRuntime.ts:357` 附近。

修复：提供一个唯一可复制的生产样例，显式非 root `User=`、固定数据目录 owner、明确 isolate UID/GID；启动 selfcheck 应对照文档样例跑。

### MFC-013：缓存 ownership marker 陈旧（P1）

- marker 判定：`src/containerOwnership.ts:150`
- 缓存重建：`src/buildCache.ts:315`
- 镜像入口权限准备：`deploy/build-image/entrypoint.sh:20`

缓存目录被重建后，旧 marker 仍可能让宿主误以为 ownership 已准备完成。

修复：marker 绑定目录 inode/device/generation，缓存 recreate 必须原子删除/重建 marker。

### MFC-014：Issue Flow 隔离与凭据边界（P1）

静态审计发现 Issue Flow 运行路径可获得过宽的 live root / 模型配置，存在让 Bash 读取 API key 的可能；同时 Issue Flow 与需求流的 cache mount/ownership 约束不完全一致。

修复方向：

- 模型密钥只通过宿主代理/进程内 IPC 使用，不写入 Agent 可读工作区或 Bash 环境。
- Issue Flow 使用与需求流相同的最小 RW mounts、cache ownership 和 user 约束。
- 为模型文件、live root、Git token 加负向读取测试。

此项建议 CC 修复前再做一次针对当前部署配置的 secret boundary 动态验证，避免只按静态推断改错层。

### MFC-015：资源 inspect 不完整（P2）

容器创建时配置了 CPU/Memory/User，但运行后检查没有完整核对 `Memory`、`NanoCpus`、`User`。配置漂移或 Docker daemon 忽略参数时，页面仍可能报“容器正常”。

修复：启动后 inspect 必须对拍期望值；不一致 fail loud，并把 expected/actual 写入健康检查。

---

## 12. 其他 UI / 流程问题

### MFC-016：耗时统一偏移约 8 小时（P1）

涉及：

- `kernel/.../advancement.py:127`
- `web/src/timeline.ts:31,232`
- `web/src/TaskCard.tsx:1129`
- `src/containerRuntime.ts:26`

内核产出无时区/UTC 风格时间，Web 又按本地时间解析，导致“耗时/卡点”整体偏移。

修复：所有存储时间使用带 `Z`/offset 的 ISO-8601；前端只在展示层转换；禁止解析无时区字符串。

### MFC-017：BEL/桌面通知无效果（P2）

Agent/内核有 BEL 通知意图，但容器环境与宿主通知能力没有完整透传，测试中没有实际桌面反馈。

修复：通知应是宿主结构化事件，不依赖容器 TTY BEL；增加通知假件与桌面消费确认。

### MFC-018：零散但确定影响体验的问题（P2）

1. **短密码错误直接显示 `Error:`**：应映射为字段级中文校验，不显示内部异常前缀。
2. **帮助搜索无结果仍展示默认文章**：应显示明确空状态和清除搜索入口。
3. **规格确认标点异常**：ASCII 逗号会被拒、全角逗号通过，门禁把排版当语义。涉及：
   - `kernel/.../flow.json:186`
   - `kernel/.../current.py:286`
   - `kernel/.../ack.py:215`
   - `kernel/.../ack_confirmation.py:149`
   - `kernel/.../consent.py:81`
4. **Story 阶段过早声称 coding/tests 已完成**：模板/生成器/reviewer 没区分“计划完成”和“已执行完成”。
5. **Grill 数量不服从请求**：请求一轮时实际连续出现约五张卡，应核对次数契约和终止条件。

---

## 13. MFC-019：Agent 对 Git 故障采取高风险无授权动作（P1）

### 实测

Git 对象 EACCES 后，Agent：

- 批量复制/rename 松散对象以脱离异常 inode。
- 删除了 core 文件。
- 随后宣称 `git fsck` 全绿；历史命令中还出现过 `git fsck | head; echo $?`，这里拿到的是下游命令退出码，证据不可靠。

这些动作确实让测试任务继续，但也可能：

- 在 hardlink 存在时污染源仓。
- 覆盖/删除故障证据。
- 在没有 backtrace 的情况下把“环境异常”误说成“已修复”。

### 建议修复

- 对 `.git/objects`、refs、index、core、宿主注入文件的修改设高风险动作策略。
- 自动 Agent 只能做只读诊断：`stat/namei/getfacl/findmnt/git fsck`。
- 复制/重写对象、chmod/chown、删除 core 必须向用户明确确认。
- 发生 Git integrity/permission 异常时，任务应进入“工作区基础设施故障”，不要让业务 Agent自行修对象库。
- core 默认移入隔离证据目录并保留，不直接删除。

---

## 14. MFC-020：外部交付失败刷屏（P2）

Fake MR 400 期间，同一错误在短时间内反复输出，执行现场产生大量重复日志。

涉及 `src/taskService.ts:10715-11014` 的 `tryDeliver()` / recovery 路径。

建议：

- 相同 error fingerprint 指数退避。
- UI 聚合为“已重试 N 次，最近一次时间”，完整记录留审计日志。
- 配置错误/branch-not-found 这类确定性 4xx 不应按瞬时 5xx 无限频率重试。
- recovery budget 用完后提供明确“修复配置并重跑”按钮。

---

## 15. 生成业务代码问题（不要误修进 MFC）

以下位于测试任务仓，不是 MFC 主仓源码：

`.tasks/e2e-picky-20260830/task-1/mae-flow-fieldtest-java`

### GEN-001：超时被确定记为 FAILED，但发送可能迟到成功（合并阻断）

代码路径：

- `notify-service/.../SmsChannelHandler.java:29-31` 承认 interrupt 对不可中断网关不保证生效，旧任务可能最终送达。
- `SmsChannelHandler.java:175-179` 超时只 `cancel(true)`。
- `SmsChannelHandler.java:107-111` 随后无条件记录 `FAILED`。
- `SmsRetryTest.java:147-173` 只断言 calls=1/FAILED，没有验证 release 后迟到成功。

影响：内部不再自动重试只保证当前 handler 内不重复；上游看到 FAILED 后重新提交同一通知，仍可能重复短信。审计结果也会撒谎。

建议：

- 使用通知 ID / provider request ID 做网关幂等键；或
- 使用可确认取消/状态查询；或
- 超时返回 `UNKNOWN/PENDING`，异步对账，不得确定记 FAILED。

### GEN-002：线程上界是 handler 实例级，不是进程级（P2）

- 每个 `SmsChannelHandler` 实例创建独立 pool：`SmsChannelHandler.java:67-92`
- 每次 `HandlerRegistry.load()` 会创建新 handler：`HandlerRegistry.java:22-38`

N 个 registry 可能形成 4N 个不可中断线程。当前 `Main` 只 load 一次，因此不是本样例当前单实例路径的阻断项。

### GEN-003：资源测试可能 flaky（P2）

- `SmsChannelHandlerTest.java:25-34` 枚举 JVM 全局同名线程，可能漏计/受到其他测试污染。
- `107-137` 使用 30ms 超时和四个忙等线程，并要求 calls 恰好为4；重载或并行 CI 下不稳定。
- finally 只 `shutdownNow()`，不 `awaitTermination()`。
- 测试手工共享 executor，没有验证默认装配的实例边界。

### GEN-004：中断和 Java 8 验证缺口（P2）

- `Future.get` 期间调用线程中断的处理位于 `SmsChannelHandler.java:180-183`，没有对应回归 UT。
- `pom.xml:22-23` 仅 source/target 1.8；最终权威构建使用 Linux JDK21，未统一使用 `--release 8` 或 JDK8 toolchain。
- 本次静态检查未发现 >Java8 API，class major 为52，但构建契约仍应修正。

### GEN-005：测试与文档口径（P2）

- `NotifyServiceTest.java:90-116` 真睡约 3100ms，拖慢且易受时钟/中断影响。
- `docs/specs/notify.md:43` 声称“不真实等待”，与测试不一致。
- `docs/specs/notify.md:34` 的“单线程同步模型”与受管线程池不一致。

---

## 16. CC 修复完成后的验收清单

### 必须全部满足

- [ ] 本地普通仓、bare 仓和 Issue Flow clone 均不共享 Git object inode。
- [ ] Linux root/non-root 两种部署都能按文档启动，ownership 不污染源仓。
- [ ] 只有 `python3` 的镜像能完整跑通所有内核命令。
- [ ] pre-MR 行级批注能产生逐条 receipt，作者可 verify/reopen。
- [ ] receipts 缺失后 retry 不丢 loop，不要求删除批注解锁。
- [ ] Fake 平台逐单 repo 的 push/MR/pipeline/gates 使用同一仓。
- [ ] 浏览器能打开 Fake MR 并合入，MFC 最终进入 completed。
- [ ] “这次修改”展示真实 base/head SHA，标题不再声称 baseline。
- [ ] 399px 宽度可查看新增代码并添加行级批注。
- [ ] waiting → await_merge 后旧 waiting/selection UI 完全消失。
- [ ] 模型设置健康检查与真实调用使用同一协议 adapter。
- [ ] 时间线不存在固定 8 小时偏移。
- [ ] Git integrity 故障不会触发未授权对象重写或 core 删除。

### 建议新增的一条真正端到端用例

使用真实 Linux Docker/Podman 环境与可控模型假件：

1. 创建逐单仓任务。
2. 需求澄清、规格、设计、编码。
3. 第一次 Build-Fix 红灯并自动修复。
4. 最终 push 卡添加行级批注，选择返工。
5. Agent 生成逐条 receipts；作者点“确认已修复”。
6. 默认展示相对上一审阅 HEAD 的增量 Diff。
7. 确认17文件范围并推送。
8. 打开 Fake MR 页面、触发绿流水线、点击合入。
9. MFC 观察 merged 并进入 completed。
10. 全程断言源仓 Git object inode/owner/mode 未被任务改变，密钥不可由 Agent Bash 读取。

## 17. 不应被误读的结论

- 增量 Diff **不是完全没实现**；问题是只在原生 push review 生效，且标签/状态有错。
- 本次 exact Git EACCES **不等于原生 Linux 必现**；Colima/virtiofs 很可能参与，但 hardlink 隔离缺陷是平台无关的。
- Linux Build-Fix 全绿 **不等于生成业务代码可合入**；`GEN-001` 是语义阻断。
- MR/假流水线最终变绿使用了人工补推 fake bare，**不能作为自然 E2E 通过证据**。
- 批注软删除保留审计，但“必须删除意见才能继续”本身就是 P1 缺陷，不是可接受工作流。
