# 02: 重启续表补挂落后监看账——救活已卡死现场

**What to build:** 服务重启的监看续表扫描目前只重挂 watching=true 的表;
已死表的现场(MR 在、监看 SHA 落后于推送账、watching=false)重启也救
不活,issue-72 形态的卡死会横跨重启存活。扩展续表扫描:凡有 MR 的仓,
监看缺席或监看 SHA 与推送账对不上时补挂监看(重挂入口幂等,
自会按推送账新 SHA 起表并沿用红灯账/刹车账)。同 SHA 已结算的不碰,
避免重放红结算扰动同提交刹车账。

**Blocked by:** None (can start immediately;与 01 并行,两者改动区域
不相交,建议独立分支先后合并).

**Status:** done(2026-09-18,与 01 同批落地)

- [x] 构造 issue-72 形态状态(MR 在、旧 SHA 死表、申报受理账在)→
      模拟重启 → 按新 SHA 补挂 → 拿到真终态开派修回合
      (issuePipelineWatchIgnition.test.ts「重启补挂」:第 2/20 轮照常
      投递,红灯账跨 SHA 结转,受理账随红灯打回清掉;另「重启补挂·
      监看缺席」变体钉 fixedRollback 清表后的缺席分支)
- [x] watching=true 的正常续表行为不变
      (既有续表循环原样,delivery.part6「重启只继续盯同 SHA」回归绿)
- [x] 同 SHA 已结算(watching=false 且 SHA 一致)不重挂、不重放红结算
      (issuePipelineWatchIgnition.test.ts「重启不重放」:零轮询、零
      回合、刹车账原样)
- [x] 无 MR 的仓不挂表(补挂遍历 state.mrs,一仓一表)
