# 03: 构建产物 48h 冷却清理 + 返工通知

**What to build:** 构建产物由同一每日清扫器按冷却期回收。范围(2026-09-11
拍板对齐):**只清 status=idle 的单子**——running/queued/waiting_user 被
状态守卫挡住(随时会续跑);failed 全豁免(可恢复态,手动转取消是其
出口,用户拍板"不用管");suspended 等转正,保守不碰;canceled/archived
由票 01 整仓回收覆盖。满足"非运行中且产物 mtime 冷却 ≥48h(旋钮可调)"
的 idle 单,删 `repo/<仓>/` 下 target/build/node_modules/depend,源码与
.git 保留——单体积从 ~4.4G 降到 ~1.9G。返工处理
拍板:**不走预热**(清理不碰分仓缓存,首编=全量但缓存热);改为返工
重开阶段的回合提示词带一句平台通知:「构建产物已按磁盘纪律回收,首次
编译为全量编译(依赖缓存热),按正常流程编译验证,勿当作环境故障排查」
——防止模型把慢编译误诊为环境问题。

**Blocked by:** 01(共用清扫器骨架与旋钮位)

**Status:** ready-for-agent

- [ ] 状态守卫:running/queued/waiting_user 单子的产物绝不清理
- [ ] mtime 冷却判定(旋钮 `issue_build_products_cooldown_hours`,缺省
      48;0=关);产物目录名清单:target/build/node_modules/depend
- [ ] 清理时容器不在场;清理写事件账
- [ ] 返工通知:已清理过的单子重开阶段(reply 返工/续跑)时,回合提示
      词带上述通知一句;有 state 标记支撑,前端不靠猜
- [ ] 终态单由 01 整仓回收覆盖,本票不重复处理
