# 01: 分支匹配后端单点:列表带出分支,发起未配置即拒

**What to build:** 配置中心版本→分支映射按包含匹配(多命中取最长)生效于两条链路:DTS 列表 API 逐单带出分支(未命中缺省);发起时对 dts 来源按同口径解析并快照为基线,未命中硬拒绝报「未配置分支」,废除"沿用原基线"兜底;显式携带产品版本的发起路径(手工登记)行为不变。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 互为包含的两个配置版本,单据版本同时包含两者时取最长命中
- [ ] 未配置版本的单子:列表 API 分支缺省;create(dts 来源)被明确拒绝
- [ ] 单据无版本号等同未配置
- [ ] 显式 product_version 路径(手工登记/需求侧)仍走精确解析,行为不变
- [ ] HTTP 契约测试覆盖以上(先例:issueFlowContract / configurationCenter 两套)
