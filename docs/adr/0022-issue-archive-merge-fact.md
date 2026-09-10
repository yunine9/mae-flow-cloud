# 问题会话归档按合入事实记账(软闸)

2026-09-10 拍板,平移需求侧外部合入契约(docs/task4-domain-and-external-merge.md)
到问题流程。背景:问题侧链路止于 mr_green 验绿——"绿→人合入→人归档"
窗口平台完全被动,归档零校验,结论 kind 靠"台账里有 mrs 就记 delivered"
机械推断;验绿≠合入,团队看板问题域的"已交付"绩效口径失真。

关键裁定:
1. **软闸·事实记账**:归档不设硬门(现场"推了不合/换单重做"是真实场景,
   硬闸会把有效收口逼成 canceled,口径更脏);但结论按合入事实记——
   全部 MR merged→delivered,有 MR 未全合→fixed(已推送未合入),归档
   对话框逐仓摆明 MR 状态。无 MR 路径(non_issue 闭环、挂起转正
   converted)不核,闸只对 mrs 非空生效。
2. **双轨跟踪**:closeMrGreen 后起合入监听循环(复用 /mr/gates 的
   fetchMrGates,节奏沿用流水线旋钮),全部合入→stage_note+通知一次;
   归档动作时再核一次(竞态守卫,防"点归档瞬间平台恰好合入"错账)。
   MR 被关闭→通知+note,不自动返工(问题侧返工由人驱动,续聊即返工)。
3. **SHA 漂移接受**:合入的是 merge/squash 产物,merged_sha 照平台
   返回记,不要求与验绿 SHA 相同(需求侧 2b4797e 同款裁定)。
   merged_at/closed_at 为首次观测时间,不冒充平台动作时间。

曾考虑「硬闸:未全 merged 拒归档」,被否——见裁定 1。曾考虑「独立
watch 表记账」,被否——mrs 本就是逐仓账,逐 MR 增 merged_at/merged_sha/
closed_at 三字段即可,不另起第二份账。

团队看板问题域"已交付"口径随之收紧:delivered=全部 MR merged,fixed
(已推送未合入)单列,不再混计。
