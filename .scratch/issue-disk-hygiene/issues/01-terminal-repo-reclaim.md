# 01: 终态 repo 回收清扫器

**What to build:** 问题单进入终态(canceled/archived)后,其代码现场
(`issues/<id>/repo/` 整个子树)由每日清扫器回收,取消/归档当场也回收
一次。过程记录(issue.json/events/transcript/waiting/分析报告/拉取日志/
登记截图/skills)全部保留——历史会话、报告、证据链照常可看。首跑即把
存量(canceled 23 个 75.1G + failed 0——failed 不动,4 个 8.9G 保留)
收回,无需单独脚本。**failed 不在回收范围**(用户拍板:可恢复态,手动
转取消是其出口)。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 每日清扫:终态(canceled/archived)且容器不在场/driver 已释放的
      issue,删除 `issues/<id>/repo/` 子树;幂等(重扫不炸)
- [ ] control() 的 cancel/archive 路径当场回收(与每日扫同一函数)
- [ ] 回收写事件账(单号、回收字节数),日志留痕
- [ ] 只删 `repo/`;报告/事件/图片/日志证据/skills 不碰
- [ ] 旋钮 `issue_repo_reclaim`(管理页,缺省开,可关=行为与现状全等)
- [ ] 启动恢复路径兼容:重启续跑/恢复任务对已回收单不再触碰 repo(如
      需要重建现场,如实报"现场已回收")
