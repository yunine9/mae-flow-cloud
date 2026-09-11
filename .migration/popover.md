# popover

2026-09-11, 变换引擎(Positioner 定位模型)。判词:干净落地;Anchor 无消费者,顺手退役。

## Changed

- `web/src/components/ui/popover.tsx`:
  - `Content` → `Portal > Positioner > Popup`;定位 props `align/sideOffset/side/alignOffset` 按前转纪律解构后显式传 **Positioner**(缺省 align="center"/sideOffset=4 与原一致);
  - Positioner `isolate z-50`;Popup 保留原视觉类;`origin-(--radix-popover-content-transform-origin)` → `origin-(--transform-origin)`;
  - 动画重述:开态淡入+缩放+按侧平移(`data-[side=x]:data-starting-style:±translate-*`,与原 slide-in-from-* 一一对应),闭态淡出+缩放;tw-animate 的 animate-in/out 退役,改 transition-[opacity,transform] duration-200;
  - 类型:各部件 `.Props`;Content 兼收 `Pick<Positioner.Props, …>`。
- `web/src/EnvironmentPicker.tsx:159`:`PopoverTrigger asChild`(环境快选按钮)→ `render={<button …>…</button>}`;内容宽度 `w-[var(--radix-popover-trigger-width)]` → `w-(--anchor-width)`(var 由 Positioner 设置,子元素继承可达)。
- `web/src/EnvironmentRegistry.tsx:134`:列筛选漏斗 `PopoverTrigger asChild` → `render` 形态。
- 遗留扫描:三文件均无 radix 引用;全应用再无 `--radix-*` CSS 变量引用。

## Left alone

- `PopoverAnchor` 导出**移除**:Base 无 Anchor 部件(Positioner `anchor` prop 是替代),且全项目零消费者——按最小 API 纪律不保留死出口。

## Behavior changes

- onOpenChange 第二参 eventDetails 加宽,现有单参处理器兼容不变。
- Hover/focus 打开类新触发理由枚举(Base 特性),无调用面。

## Verify by hand

- 环境快选:点开弹层与触发钮同宽(anchor-width)、贴齐左侧(align=start)、箭头方向侧滑入场;Esc/点外关闭;键盘导航列表;
- 环境管理列筛选漏斗:激活列有 accent 底块,弹层过滤项可勾选、清除入口可见。
