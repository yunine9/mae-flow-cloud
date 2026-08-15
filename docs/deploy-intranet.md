# 内网部署手册(准备件——外部完全就绪才执行)

> 原则(用户拍板):**外部完全就绪才部署内网;需要内网能力就模拟。**
> 本文是"真件就绪=换地址"的可执行版:每个假件对应一个配置点,
> 语义契约不随部署改变——契约写在各自的测试里,换真件后测试仍然是裁判。

## 机器前置

| 依赖 | 版本/说明 |
| --- | --- |
| Node.js | ≥ 20(`tsx` 直跑 TS,无构建步) |
| Python 3 | ≥ 3.10,mae-flow 内核的运行时 |
| mae-flow 内核 | checkout 到服务器,`MAE_FLOW_HOME` 指向仓根(缺省找 `../mae-flow`) |
| Git | 任务克隆/推分支/ls-remote 都用它 |
| JDK + Maven | 试点仓(Java)编译验证用;版本按试点仓 `pom.xml` 要求 |
| npm 依赖 | `npm ci`(pi 锁 0.84.1,升级必须重跑 probe+全套测试再拍板) |

**Linux 容器编译验证(外部已模拟通过)**:2026-08-14 在 Colima
arm64 Linux 容器(maven:3.8-eclipse-temurin-8)对 fieldtest-java
干净副本验证 compile/test 退出码 0。上内网第一件事仍然是:在**目标
容器镜像**里跑 `mvn compile && mvn test`,退出码必须真实核验
(不许管道吞码)——外部模拟不替代目标镜像的最终裁决。

## 四个假件 → 真件切换表

| 能力 | 外部假件 | 内网真件切换点 | 语义契约(不变) |
| --- | --- | --- | --- |
| 模型网关 | scriptedModel / bigmodel | `--models` 指向内网网关 models.json | Anthropic Messages + SSE;注意网关是否静默改路由模型 |
| 小鲁班通知 | FakeLubanServer | Notifier `endpoint` + 鉴权头 | 投递失败不改流程状态;有限退避;按 waiting_id 幂等 |
| Git 服务端 | FakeGitPlatform 裸仓 | `--repo` 指向内网仓地址(克隆凭证走 git credential) | 服务端仓是唯一远端真相 |
| MR + 流水线 | FakeGitPlatform HTTP | `delivery.platformUrl` + 鉴权 | MR 按(源→目标)幂等;流水线结果绑 SHA;验证中→等待合入 |

models.json 形状(key 只放服务器本地文件,权限 600,永不进仓):

```json
{
  "providers": {
    "内网网关名": {
      "baseUrl": "https://<内网网关>/api/anthropic",
      "api": "anthropic-messages",
      "apiKey": "<从凭证系统注入>",
      "models": [{ "id": "glm-5.1" }]
    }
  }
}
```

## 启动与守护

```bash
MAE_FLOW_HOME=/srv/mae-flow \
MAE_FLOW_ADMIN_USER=admin \
MAE_FLOW_ADMIN_PASSWORD='<从凭证系统注入的初始密码>' \
npm run serve -- --models /etc/mae-flow-cloud/models.json \
  --provider <网关名> --model glm-5.1 \
  --repo <内网仓地址> --platform <MR/流水线网关地址> \
  --pg postgresql://<用户>@<PG地址>/<库名> \
  --data /var/lib/mae-flow-cloud --port 8787
```

(外部演练交付链:去掉 `--platform`,改用 `--fake-platform`——
从 `--repo` 灌裸仓当远端,推送/MR/流水线全环回。)

- **`--pg` 是投影不是真相**:不配它一切照旧(文件即真相);配了它
  写失败也不影响流程(fail-open,页面只多一条投影失败日志)。建表
  自动幂等;重启后 recover() 会以现场文件为源把投影补齐,PG 里的
  数据可整库重建——备份优先级远低于数据目录。
- **数据目录就是命根**:task.json / waiting.json / events.jsonl /
  transcript.jsonl / auth.json / 仓库克隆(内核状态文件在里面)全在 `--data` 下。
  备份它=备份一切;丢它=任务从头来。
- **本地登录**:正式模式首次启动必须提供 `MAE_FLOW_ADMIN_PASSWORD`
  (至少 10 个字符),可用 `MAE_FLOW_ADMIN_USER` 指定初始管理员账号。
  之后由管理员在页面创建成员。`auth.json` 只保存 scrypt 加盐哈希且权限
  为 `0600`;会话只驻进程内,8 小时过期,重启后全部重新登录。开发成员可
  查看全团队任务,但只能创建到自己名下并处理自己的审批/重跑;管理员可
  操作全部任务。对外提供页面时必须由反向代理终止 HTTPS,并传递
  `X-Forwarded-Proto: https`,服务会据此给会话 Cookie 加 `Secure`。
- **桌面通知默认关**:内核默认会在"需要裁决/进入新阶段"时弹系统通知,
  那是为"人坐在终端旁"的单机场景设计的;服务里同时跑几单就弹几倍,而且
  弹在服务器上没人看——真正的送达通道是待办页与小鲁班。serve 启动即
  置 `MAE_FLOW_NO_NOTIFY=1`,要单机手感就加 `--desktop-notify`。
  (已在跑的任务想立刻静音,不必重启:在该任务的仓库克隆里写
  `.mae-flow-defaults.json` → `{"桌面通知": false}`,内核每次调用现读现判;
  记得同时写进 `.git/info/exclude`,别让它混进未提交改动。)
- **重启语义(已实现并有测试)**:进程可死任务不死。启动时 `recover()`
  重建索引;崩溃时在跑的任务重新入队,以内核 current 为锚重建会话续跑;
  等人的任务原地挂起,决定到来走重建会话。演示模式(无 `--models`)
  每次清场,真模型模式永不自动清数据。
- **容器隔离(强烈建议内网开启)**:`--isolate-image <构建镜像>`
  后模型的 bash 命令进任务专属容器执行(会话/门禁/内核留宿主,
  工作区同路径挂载)。镜像按试点仓选并需包含 python3 + git +
  构建链(Java 例:maven + JDK + python3,参考 mfc-java-pilot 的
  Dockerfile 形状);`--isolate-volume ~/.m2:/root/.m2` 挂构建缓存;
  `--isolate-memory 4g --isolate-cpus 2` 限额;
  `--isolate-user $(id -u):$(id -g)` 防挂载卷文件属主漂移。
  教训(run7 实锤):宿主没有构建链时,模型会自己发明 docker 包裹
  命令拿到真实绿灯,但内核台账铁面拒收(命令与任务卡不符)——
  环境必须由部署侧给足,不能指望模型绕。
- 守护用 systemd `Restart=on-failure` 即可,恢复逻辑在服务内部。
  单元文件样例:

  ```ini
  [Unit]
  Description=mae-flow-cloud
  After=network.target docker.service

  [Service]
  WorkingDirectory=/srv/mae-flow-cloud
  Environment=MAE_FLOW_HOME=/srv/mae-flow
  Environment=MAE_FLOW_ADMIN_USER=admin
  EnvironmentFile=/etc/mae-flow-cloud/secrets.env
  ExecStart=/usr/bin/npm run serve -- \
    --models /etc/mae-flow-cloud/models.json \
    --provider <网关名> --model glm-5.1 \
    --repo <内网仓地址> --platform <MR/流水线网关地址> \
    --pg postgresql://<用户>@<PG地址>/<库名> \
    --isolate-image <构建镜像> --isolate-volume /var/cache/m2:/root/.m2 \
    --data /var/lib/mae-flow-cloud --port 8787
  Restart=on-failure
  RestartSec=3

  [Install]
  WantedBy=multi-user.target
  ```
  `secrets.env` 至少包含 `MAE_FLOW_ADMIN_PASSWORD=...`,权限设为 `0600`,
  不要把密码直接写进单元文件或仓库。账号库已存在后不会重复创建管理员。
- 环回代理教训(外部踩过三次):如果服务器有全局代理,
  确认 `NO_PROXY=127.0.0.1,localhost`(代码里 `ensureLoopbackDirect()`
  已兜底,但 curl 排障时记得 `--noproxy '*'`)。

## 上线自查清单(按序)

可执行版:`harness/preflight.sh --java-repo <试点仓> --models <models.json> --provider <网关名>`
——1~4 项自动核验真实退出码,5/6 两项人工,脚本会原样提醒。

1. 容器内 `mvn compile && mvn test` 真实退出码 0;
2. `npm test` 全绿(17 项,含恢复/并发/交付三条路);
3. `npm run probe` 九项事实全绿(内核裁判在场);
4. 网关连通:发一个最小任务,确认首回合不是空转
   (429/网关错误会如实落 failed + detail,不会假 completed);
5. 一单真需求走到 `await_merge`,MR 出现在真平台上;
6. 杀进程重启,确认等待中的任务还在、决定后能续跑
   (可执行演练:`harness/restart-drill.sh`——真 kill -9 真 HTTP,
   全绿即过;上线机器上跑一遍)。

## 监控与排障

- 页面 `GET /`:任务状态说人话;通知失败红条;MR 链接。
- `GET /tasks/:id/events`(SSE):语义事件实时镜像。
- `GET /tasks/:id/actions`:外部动作台账(MR/流水线,含幂等键与
  绑定 SHA)——恢复时"先查远端真实状态"的对账入口;需配 `--pg`。
- `GET /history`:任务摘要投影的历史列表(按最近更新倒序)——
  数据目录清理或换机后,历史看板/审计从这里查;需配 `--pg`。
- 任务 detail 字段:失败原因原文(含网关 429 的重置时间)。
- 内核侧真相:任务克隆目录 `.mae-flow.json`(current/config)与
  `.mae-flow-work/panel.html`(现场面板)。
- 疑难对拍:transcript.jsonl 是语言中立契约,
  `harness/verify_transcript.py` 可独立裁决证据链。
