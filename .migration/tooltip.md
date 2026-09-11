# tooltip

2026-09-11, 变换引擎(Positioner 定位模型)。判词:干净落地;零消费者,纯 API 换轨。

## Changed

- `web/src/components/ui/tooltip.tsx`:
  - 命名空间 `radix-ui` → `@base-ui/react/tooltip`;
  - `Provider delayDuration` → `delay`(项目缺省 0 保留:悬停即出);
  - `Content` → `Portal > Positioner > Popup`,定位 props 前转纪律(sideOffset 缺省 0 保留项目原值;side/align/alignOffset 新增可传);
  - 动画重述:原 `animate-in fade-in-0 zoom-in-95`(+反向)→ transition-[opacity,transform] duration-150 + data-starting/ending-style,按侧 1 单位平移入场;
  - `--radix-tooltip-content-transform-origin` → `--transform-origin`;
  - Arrow:Base 渲染 `<div>`,沿用项目的 rotate-45 方块小箭头类(原 radix svg 同款视觉)。
- 遗留扫描:无 radix 引用。全项目 Tooltip 零消费(预检证实),无应用代码改动。

## Left alone

- Arrow 的固定 `translate-y-[calc(-50%_-_2px)]` 偏移只按缺省 side=top 校准;非 top 侧的逐侧偏移未按 golden pair 的箭头几何逐侧调准(Base 原语自动贴边,偏移量可能差 1-2px)——零消费,等首个真实用例再校。

## Behavior changes

- delayDuration/delay 默认语义一致(本项目恒 0);Base Trigger 另有 closeDelay(缺省 0)不构成差异。

## Verify by hand

- 首个接入方出现时:悬停即出、离焦即收、箭头贴边方向正确。
