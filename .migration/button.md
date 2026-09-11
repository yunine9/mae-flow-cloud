# button

2026-09-11, 变换引擎(legacy new-york 无 golden pair,保留项目样式),Slot/asChild → 真 `@base-ui/react/button` primitive。判词:干净落地。

## Changed

- `web/src/components/ui/button.tsx`:整体重写——
  - `import { Slot } from "radix-ui"` + `const Comp = asChild ? Slot.Root : "button"` idiom → `ButtonPrimitive`(`@base-ui/react/button`,原生支持 `render`);
  - prop 类型 `React.ComponentProps<"button"> & { asChild?: boolean }` → `ButtonPrimitive.Props`(含 `render`/`nativeButton`);
  - `asChild` 公开 prop 移除;多态走 `render={<元素/>}`。
  - cva 变体类逐字未动(项目外观即项目的外观)。`disabled:*` 伪类保留——Base Button 仍渲染 `<button>`,伪类活着。
- 消费面:全项目无 `<Button asChild>` 调用点(预检 grep 证实),零应用代码改动。
- 遗留扫描:`grep -n "radix-ui\|@radix-ui" web/src/components/ui/button.tsx` 空。

## Left alone

- `ui/dialog.tsx` 里对 `Button` 的导入(它消费 Button,不消费其 asChild;dialog 自己的提交另算)。

## Behavior changes

- 无预期行为差异。Base Button 事件签名(如 onClick 的合成事件细节)按 Base UI 语义,调用点均只传普通 onClick。

## Verify by hand

- 任意页面的按钮 hover/focus 环(focus-visible:ring)与 disabled 半透明;
- 若有 `render` 用法(目前无),确认 props 合并方向。
