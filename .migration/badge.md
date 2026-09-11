# badge

2026-09-11, 变换引擎(useRender+mergeProps 工作例),Slot idiom → 多态 render。判词:干净落地。

## Changed

- `web/src/components/ui/badge.tsx`:`const Comp = asChild ? Slot.Root : "span"` → `useRender({ defaultTagName: "span", props: mergeProps(...) })`;prop 类型 `useRender.ComponentProps<"span">`(data-* 对象字面量按规矩 cast 成 `React.ComponentProps<"span">`);cva 类逐字保留。
- `web/src/EnvironmentRegistry.tsx:461`:`<Badge asChild><button>…</button></Badge>` → `<Badge render={<button …>…</button>} />`(children 移入 render 元素,mergeProps 把徽章类合并到按钮上)。
- 遗留扫描:badge.tsx 无 radix 引用;另两处 Badge 消费点(EnvironmentEditorDialog、Registration)为纯 span 形态,零改动。

## Left alone

- 其余 Badge 消费点(非 asChild 形态不受影响)。

## Behavior changes

- 无。

## Verify by hand

- 环境管理页标签徽章:点击可筛、aria-pressed、active 态换色(mergeProps 后 cursor-pointer 与徽章类同存)。
