# dialog

2026-09-11, 变换引擎(部件重排 Overlay→Backdrop、Content→Popup;居中模态无 Positioner)。判词:干净落地。

## Changed

- `web/src/components/ui/dialog.tsx`:
  - `Dialog` 命名空间从 `radix-ui` → `@base-ui/react/dialog`;
  - `Overlay` → `Backdrop`(`DialogOverlay` 公开名与导出不变);
  - `Content` → `Popup`(`DialogContent` 公开名不变;居中模态,不引入 Positioner);
  - 动画重述:class-mapping 规矩,`data-[state=…]:animate-in/out + fade/zoom` → `transition-[opacity(,transform)] duration-200 + data-starting-style:/data-ending-style:`(Backdrop 纯淡入淡出;Popup 淡入+缩放,与原 zoom-in-95 等价);
  - 类型:`React.ComponentProps<typeof X.Part>` → `X.Part.Props`(Root/Trigger/Portal/Close/Backdrop/Popup/Title/Description);
  - 内部 `DialogPrimitive.Close asChild><Button>` → `render={<Button variant="outline">Close</Button>}`(DialogFooter 的 showCloseButton 分支,无消费者在用)。
- 遗留扫描:dialog.tsx 无 radix 引用。消费点 EnvironmentEditorDialog 用 Root/Content/Header/Title/Description/Footer,无 asChild/无受影响 prop,零应用代码改动。

## Left alone

- 关闭 X 钮上的 `data-[state=open]:bg-accent data-[state=open]:text-muted-foreground` 两枚 radix 开态类:Base 的 Close 部件不带开态 data 属性,无忠实等价——按"行为差异如实报"纪律丢弃未译(hover 态保留,视觉损失仅"弹窗开着时 X 钮底色"这一非关键反馈)。

## Behavior changes

- onOpenChange 回调第二参新增 eventDetails(Base 签名加宽);现有消费者 `(open) => …` 单参处理器类型兼容、行为不变。
- 退场动画从 radix animate-out(150ms 级)改为显式 duration-200 过渡,节奏略缓(有意统一)。

## Verify by hand

- 环境编辑弹窗:开关各一次,淡入+缩放、淡出;Esc 与点遮罩关闭;关闭后焦点回到触发钮(finalFocus 默认);
- Tab 在弹窗内循环(focus trap),X 钮可聚焦可点。
