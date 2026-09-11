# 03: 构建产物 48h 冷却清理 + 返工通知

**What to build:** 非活跃单的构建产物由同一每日清扫器回收:状态 ∈
{running, queued, waiting_user} 的不碰;其余单子若 `repo/<仓>/` 下的
target/build/node_modules/depend 的 mtime 已冷却 ≥48h(旋钮可调),删除
这些产物目录,源码与 .git 保留——单体积从 ~4.4G 降到 ~1.9G。返工处理
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
