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

**Linux 容器编译验证(未做,内网侧动作)**:外部只在 macOS 验证过
fieldtest-java 直接编译。上内网第一件事:在目标容器镜像里跑
`mvn compile && mvn test`,退出码必须真实核验(不许管道吞码)。

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
npm run serve -- --models /etc/mae-flow-cloud/models.json \
  --provider <网关名> --model glm-5.1 \
  --repo <内网仓地址> --data /var/lib/mae-flow-cloud --port 8787
```

- **数据目录就是命根**:task.json / waiting.json / events.jsonl /
  transcript.jsonl / 仓库克隆(内核状态文件在里面)全在 `--data` 下。
  备份它=备份一切;丢它=任务从头来。
- **重启语义(已实现并有测试)**:进程可死任务不死。启动时 `recover()`
  重建索引;崩溃时在跑的任务重新入队,以内核 current 为锚重建会话续跑;
  等人的任务原地挂起,决定到来走重建会话。演示模式(无 `--models`)
  每次清场,真模型模式永不自动清数据。
- 守护用 systemd `Restart=on-failure` 即可,恢复逻辑在服务内部。
- 环回代理教训(外部踩过三次):如果服务器有全局代理,
  确认 `NO_PROXY=127.0.0.1,localhost`(代码里 `ensureLoopbackDirect()`
  已兜底,但 curl 排障时记得 `--noproxy '*'`)。

## 上线自查清单(按序)

1. 容器内 `mvn compile && mvn test` 真实退出码 0;
2. `npm test` 全绿(17 项,含恢复/并发/交付三条路);
3. `npm run probe` 九项事实全绿(内核裁判在场);
4. 网关连通:发一个最小任务,确认首回合不是空转
   (429/网关错误会如实落 failed + detail,不会假 completed);
5. 一单真需求走到 `await_merge`,MR 出现在真平台上;
6. 杀进程重启,确认等待中的任务还在、决定后能续跑。

## 监控与排障

- 页面 `GET /`:任务状态说人话;通知失败红条;MR 链接。
- `GET /tasks/:id/events`(SSE):语义事件实时镜像。
- 任务 detail 字段:失败原因原文(含网关 429 的重置时间)。
- 内核侧真相:任务克隆目录 `.mae-flow.json`(current/config)与
  `.mae-flow-work/panel.html`(现场面板)。
- 疑难对拍:transcript.jsonl 是语言中立契约,
  `harness/verify_transcript.py` 可独立裁决证据链。
