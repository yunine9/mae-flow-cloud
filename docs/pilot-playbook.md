# 进场执行手册(给内网 agent 的任务书)

> 这份文档是**部署与联调的任务书**,接在能力核对报告(2026-08-17)
> 之后。执行者是内网的 agent,角色是**部署执行员,不是程序员**:
> 装环境、填配置、跑验证、记证据。全程一行 .ts 都不许改——需要改
> 代码才能通过的地方,那是外网契约有洞,把真实形状记进报告带回去,
> 外网改。
>
> 先修文档(执行中要反复查):
> - `docs/deploy-intranet.md` —— 部署手册(机器前置/依赖/启动/自查)
> - `docs/mr-loop-adaptation.md` §11 —— adapter.json 参考填法
> - `README.md` 已知边界 —— 哪些已验证、哪些等你补验

---

## 开场提示词(复制下面整段粘给内网 agent)

---

你是一名部署执行员。任务:把 mae-flow-cloud 在这台机器上部署起来、
把 CodeHub 适配层配通、补验三件事、真跑一单验收。你的产出是一份
《进场执行报告》,不是代码。

铁的纪律(违反任何一条,执行作废):

1. **禁止修改本仓任何 .ts/.py 文件**。你只允许:新建/编辑
   `adapter.json`、`/etc/mae-flow-cloud/` 下的辅助脚本(jq 过滤、
   MCP 桥)、`.local/` 下的本机配置。收工时 `git status` 必须干净;
2. **密钥不进报告、不进命令行历史可见处**:token 写进 0600 文件,
   报告里一律 `<token>` 打码,但 JSON 字段名与结构原样保留;
3. **每一步的验收都要真实输出**:命令的 stdout/stderr 原文(脱敏)
   抄进报告;失败也是证据,报错原文照抄,不许只写"失败了";
4. **写操作只打试点仓**:建 MR、push、造检视意见都用试点仓的测试
   分支,动了什么记进报告;
5. **卡住 30 分钟以上的项**:记下卡点与已试过的路,标「未通过」
   继续下一项,不要死磕,更不要绕过纪律 1 去改代码;
6. 测试 skip 不等于通过:`npm test` 里显式 skip 的用例要在报告里
   列出 skip 原因(缺 docker?缺 PG?)。

执行前先向我(人)要齐这些输入,拿不齐的项标注后跳过对应步骤:

- 试点仓地址、目标分支(项目 id 不用要:REST 用自动派生的
  `{repo_path}`;CLI 真要数字 id 时你自己按 §11 查一次);
- 一个能用的 CodeHub token(写进哪个文件我会告诉你);
- codehub CLI 的可执行路径与版本(`--version` 真跑一次);
- MCP 网关地址与 access token 的获取方式(没有就说没有);
- 两个 UT skill 文件(人会给你,放数据目录 skills/);
- 内网 npm 源地址。

然后打开本仓 `docs/pilot-playbook.md`,按阶段 0→4 逐阶段执行。
每完成一个阶段,把该阶段的验收证据先发我过目,再进下一阶段。
最后按文末格式汇总《进场执行报告》,写到仓库外(如 `~/pilot-report.md`)。

---

## 阶段 0:环境就位(验收:npm test 能跑)

1. 确认快照版本:`git log --oneline -1` 应不早于
   `a3b8a27`(feat(mr-loop): 按内网能力核对报告钉契约)。早于它的
   快照检视语义是错的,停下来要新 ZIP;
2. 装依赖:`npm install` 走内网源。**esbuild 是平台专属二进制,
   不能用别的机器拷来的 node_modules**;装不上
   `@earendil-works/pi-coding-agent` 是一票否决项,原文记报错;
3. 机器前置按 `docs/deploy-intranet.md`「WSL 实战速记」;
4. 验收:`npm run typecheck` 0 错;`npm test` 跑完,pass/fail/skip
   数字与 skip 原因记进报告(此时没配 docker/PG,skip 是正常的)。

## 阶段 1:适配层配通(验收:selftest 全端点有真实输出)

1. 照 `docs/mr-loop-adaptation.md` §11 的骨架写 `adapter.json`
   (权限 600)。要点:
   - REST 优先;CLI 只用装机上真实那一代的语法(先 `--version`,
     v0.4.9 与 1.6.0 参数完全不同,别混抄);
   - 项目定位用 `{repo_path}` 占位符(适配层从仓 URL 自动派生的
     URL 编码路径),不手抄项目 id;只有 CLI 命令非要数字 id 时,
     `curl .../api/v3/projects/{路径}` 查一次把 `.id` 写进模板;
   - `pipeline_status` 的 is_valid 过滤、`mr_discussions` 的
     未解决过滤,写成 /etc 下的小脚本(jq),脚本只做取数和过滤,
     不做判定;
   - `discussion_resolve` **默认不配**(resolve 归检视人,报告 D3);
   - MCP access token 拿不到就不配 `pipeline_artifacts`(宿主自动
     降级摘要通道,不是错误);
2. 跑自检并把**完整输出**抄进报告:

   ```bash
   npm run adapter -- --config adapter.json --selftest \
     --repo <仓> --source-branch <测试分支> --target-branch <目标> \
     --sha <一次真实提交> --mr <已存在的 MR iid>
   ```

3. 验收:四个只读端点(status/gates/discussions/artifacts)都有
   真实返回或明确的「未配置(404)」;**字段对不上的不要改 .ts**,
   先试着在 adapter.json/jq 脚本里翻译形状,翻译不动的原样记进报告
   「契约洞」一节。

## 阶段 2:三个补验(能力核对报告的遗留缺口)

1. **push**:在试点仓克隆里推一次测试分支:
   `git push https://oauth2:<token>@<host>/<repo> HEAD:refs/heads/<测试分支>`
   - 504 → 检查 no_proxy 是否包含 CodeHub 域名,再试;
   - 401 → 把 `oauth2` 换成平台账号名再试一次;
   - 每次尝试的完整报错原文都要记录,成功也要记录用的是哪种形式;
2. **MCP 完整日志**:如果拿到了 access token,写
   `/etc/mae-flow-cloud/mcp-log-bridge.py`(GET /sse 拿 session_id →
   POST /messages 调 download_build_task_log → 落盘),配进
   `pipeline_artifacts` 后重跑一次 selftest;拿不到 token 就记
   「未供给,已降级摘要通道」;
3. **SuperChecker**:在流水线历史里找一条 SuperChecker 类失败,把
   工具名/错误码/返回 JSON 脱敏抄进报告(找不到就记「本期无样例」)。

## 阶段 3:工作流件(人机各半)

1. 把人给你的两个 UT skill 放 `<数据目录>/skills/`(数据目录是
   serve 的 `--data` 参数指向的目录);
2. 小鲁班/WeLink 的接入**不要自己动手**——把它们的接口形态(是不是
   MCP、鉴权方式、发消息的调用样例)调研清楚记进报告,由人拍板后
   外网出适配。通知暂用假小鲁班(serve 不配 --luban 即是)。

## 阶段 4:真跑一单验收(验收:任务时间线完整闭环)

1. 起服务(按部署手册「启动与守护」),交付平台指向阶段 1 的适配层;
2. 在试点仓下一单小需求(比如改一行注释级别的),盯到底:
   建 MR → 流水线 → 合入或明确停机;
3. 加餐(如果检视人配合):在 MR 上留一条检视意见,验证
   拉讨论 → 专职会话回复 → 回复出现在讨论里且**未被代点已解决** →
   人点掉后任务收口;
4. 验收证据:任务详情页时间线截屏或文字誊抄、MR 链接、每个外部
   动作的平台侧真实状态。**流水线结果必须绑本单的 SHA**,拿旧灯
   交差等于造假。

## 《进场执行报告》格式(最终产出,原样带回外网)

```
# 进场执行报告 <日期>
## 总判定: 全链路通 / 通到阶段 N 卡在 X / 环境未就位
## 阶段 0: typecheck/test 数字,skip 清单与原因
## 阶段 1: selftest 完整输出(脱敏);adapter.json 全文(脱敏)
## 阶段 2: 三个补验各自的结论 + 尝试记录(含失败原文)
## 阶段 3: skills 就位确认;小鲁班/WeLink 调研结果
## 阶段 4: 一单到底的时间线 + MR 链接 + 各环节平台侧状态
## 契约洞: 哪个端点/字段的真实形状与文档对不上(这节最重要,
##          外网按它改代码——没有就写"无")
## 遗留: 卡住未过的项、需要人拍板的事
```

---

## 附:给人看的(不用粘给 agent)

- 盯三件事就够:①它有没有改 .ts(`git status` 一眼);②报告里
  每项有没有真实输出(没有原文的打回);③密钥有没有被它写进
  报告或命令行明文;
- 阶段间人工过目是刹车点:阶段 1 的 selftest 输出值得你亲自扫一眼
  字段名,那是外网契约对不对的第一现场;
- 报告拿回来原样发外网 Claude:「契约洞」一节有内容就是要改代码,
  在外网改完出新 ZIP;没有就进多用户推广的准备。
