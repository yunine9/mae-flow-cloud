# 重启/重部署恢复手册(2026-08-29 三路审计)

> 场景:明天铺开使用,运维会频繁"改 bug → 重启服务"。本文回答两个
> 问题:**每个阶段的任务重启后能不能无感恢复;不能的话人怎么救。**
> 审计方法:三个独立审计逐文件核查 + 真 kill -9 重启演练
> (harness/restart-drill.sh 绿)。带"✅ 已修"的条目是审计当晚落的代码,
> 其余照实记录现状。

## 安全重启流程(每次部署照抄)

```bash
# 1. 先 SIGTERM,给 shutdown 钩子机会(容器、问题会话收尾)
systemctl stop mae-flow-cloud        # 或 kill <pid>,不是 kill -9
# 2. 确认没有还挂着的 detached git(推送走独立进程组,能活过服务)
ps -eo pid,ppid,etime,command | grep "[g]it push"   # 有就等它(≤5 分钟预算)
# 3. 换代码,起服。起服自带四道清扫:遗留容器(按实例指纹)、
#    明文 git 凭据现场(.runtime/*/operation-*,15 分钟年龄闸)、
#    skill 暂存、资产库写入残骸。
systemctl start mae-flow-cloud
# 4. 看启动日志:「已清理遗留任务容器 N 个」「恢复任务 N 个」是正常字样;
#    容器清扫 ownership 复验失败会**拒绝启动**(fail-closed,别硬绕)。
```

部署公告固定加一句:**"部署后浏览器请强制刷新(Cmd/Ctrl+Shift+R)"**
——老页签的懒加载 chunk 换代码后会 404(有可读错误页兜底,不白屏)。
登录会话已落盘(✅ 已修),重启**不再**把大家踢回登录页。

## 各阶段恢复矩阵

| 阶段/状态 | 重启后 | 人工动作 |
|---|---|---|
| queued / running(编码中) | 无感:重新入队,以内核 current 为锚续跑(队列已按任务号数值排序 ✅ 已修) | 无 |
| waiting_for_human(等决定) | 无感:原地继续等;已答未消费的决定自动带回重建会话 | 无 |
| prepush 验证中 | 无感:僵尸轮自动翻新一轮(reconcileInterruptedPrePush);卡住时页面有「重试」出路 | 无 |
| verifying + 流水线 running | 无感:按 delivery.sha 续轮,新预算 | 无 |
| verifying + 轮询预算耗尽/拒陈灯注记 | 无感(✅ 已修):续轮不重触发。修前每次重启会重建 MR + 同 SHA 白烧一条流水线 | 无 |
| verifying + 证据缺口(红灯待分诊) | 无感:同 SHA 重新取证分诊 | 无 |
| verifying + 已如实停摆(stalled) | 保持停摆(它在等人不是等机器) | 页面点「重跑」 |
| await_merge(等合入) | 无感:watchMerge 重新武装,新预算 | 服务不重启时监控预算烧完会停盯;重启即恢复,或等下次部署 |
| completed / failed | 无感:只重建索引 | 无 |
| paused / pausing | pausing 安全落 paused,不擅自续跑 | 人工恢复 |
| 问题流会话(issue) | 标记「服务重启打断」,现场保留 | 用户发一句话即续聊 |
| 修复环(CI/检视修) | 无感:轮数与同 SHA 刹车都在派单前落盘,不重置不白送轮次 | 无 |

## 容器(重点核查过)

- **需求侧 coding/prepush/system-check 容器**:kill -9 遗留的下次起服
  按「managed + 实例指纹 + 角色白名单」两道 ownership 复验后清掉;
  复验不过整个服务拒启(绝不误删别人的容器)。
- **问题流 issue 容器**:✅ 已修——补上了与需求侧同一套 ownership
  标签并纳入清扫白名单。**注意:修复之前创建的 issue 容器没有标签,
  清扫认不出**,上线后手动清一次存量:
  ```bash
  docker ps -a --filter name=mfc- --format '{{.Names}}\t{{.Label "com.mae-flow-cloud.instance"}}'
  # instance 列为空的 mfc-*-issue-* 是旧残留;确认不是在跑的,逐个:
  docker rm -f <名字>
  ```
- Colima 纪律不变:**有容器任务在跑时绝不 colima start/stop 任何
  profile**(会切 docker context,活容器 exec 全灭,实测打死过续跑)。

## 坏档急救(理论上不该发生,发生了这么救)

- **task.json 损坏**:该任务恢复时被逐条 try/catch 跳过,**列表里静默
  消失**(现场目录还在)。救法:到 `<data>/task-N/` 手工修 JSON
  (tmp+rename 原子写,坏档极罕见;常见坏因是磁盘满),修好重启。
  找它:`for f in <data>/task-*/task.json; do python3 -m json.tool "$f" >/dev/null || echo "$f 坏"; done`
- **waiting.json 损坏**:同上,HumanGate 构造会抛;同一目录同一修法。
- **资产库发布撞 409「已发布版本文件已存在」**:✅ 已修——崩溃孤儿
  vN 发布时自动回收,不再焊死;回收只认「WAL(operations.jsonl)里
  查无该版本 approve_commit 提交确认」的文件,真发布过的版本铁证
  不可覆盖。若升级后仍持续 409:说明 WAL 里有这笔提交确认而
  asset.json 的提交点被人碰过,人工核对 `<data>/workflow-assets/<id>/`
  再决定,别删版本文件。
- **资产库 create 半份残骸**(列表页长期挂 warning):
  `rm -rf <data>/workflow-assets/<点名的 id>` 消警。

## 已知的非无感项(如实记录,今晚不修)

- **通知**:在途/失败的通知重启即丢,不重发;「没送到」红旗现已落盘
  (✅ 已修),重启后页面仍标红,但**补发要人工**:扫一遍等待中的
  任务,私下知会责任人。
- **PG 历史投影**:服务活着期间 PG 挂了,读侧缺的数据要等下次重启
  重放补齐(投影是旁路,不影响任务本身)。
- **表单**:重启时浏览器里填了一半的表单会丢(会话不丢,表单内容丢)。
