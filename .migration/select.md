# select

2026-09-11, 变换引擎(Portal>Positioner>Popup + 部件改名 + Value 渲染语义)。判词:落地;Value 语义变化是本组件真正的破口,三个消费点全部补 items 映射。

## Changed

- `web/src/components/ui/select.tsx`:
  - `Select` 改裸再导出 `SelectPrimitive.Root`(Base 的 Root.Props 泛型,包函数反而破类型;data-slot=select 随之退役);
  - `Content` → `Portal > Positioner > Popup`:定位 props(align/side/sideOffset/alignOffset)前转纪律显式传 Positioner;radix `position` 语义译为 `alignItemWithTrigger`(item-aligned=true 缺省;popper=false,且此时 sideOffset 缺省补 4——对应原 popper 态的 translate-y-1 视觉间隙);
  - `Viewport` → `List`;`ScrollUp/DownButton` → `ScrollUp/DownArrow`(公开名保留原包装名);`Label` → `GroupLabel`(公开名 SelectLabel 保留);
  - CSS 变量:`--radix-select-content-available-height` → `--available-height`、`--radix-select-content-transform-origin` → `--transform-origin`、popper 态 `--radix-select-trigger-width/height` → `--anchor-width/height`;
  - 动画重述(transition + data-starting-style/data-ending-style,按侧 1 单位平移入场);
  - `Icon asChild` → `render={<ChevronDownIcon/>}`;Item 的 `focus:bg-accent` → `data-highlighted:bg-accent`(Base 项不走 DOM 焦点,走 highlight 属性——不换则键盘高亮全瞎);`data-[disabled]:` → `data-disabled:`。
- `web/src/AnnotationPanel.tsx:124`(意见处置):`position="popper" align="start"` → `alignItemWithTrigger={false} align="start"`;**onValueChange 值可空**——空态占位由 `value={outcome || null}` 表达、回写 `next ?? ""`;**items 映射补齐**(Base 的 Value 渲染原始值而非条目文本,不补 items 触发钮会显示 "fixed" 而非中文标签);`onEscapeKeyDown={(e)=>e.stopPropagation()}` 无 Base 等价(见行为差异)。
- `web/src/EnvironmentEditorDialog.tsx:255`(环境形态):同款——items 映射、`alignItemWithTrigger={false}`、`next ?? "virtualized"` 兜空。
- `web/src/issues/Registration.tsx:943`(DTS 单预绑模块):items 用 `[{value:"__none",label:…}, ...moduleCatalog.map(…)]`(触发钮显示模块名而非 module_id);onValueChange 补 `value == null` 兜空。
- 遗留扫描:select.tsx 与三个消费文件均无 radix 引用。

## Left alone

- `SelectGroup`/`SelectSeparator`/`SelectLabel` 无消费者,纯 API 保留随迁。

## Behavior changes

- **Value 渲染语义**:radix 触发钮显示选中条目的 ItemText 内容;Base 显示原始值,靠 Root.items/children fn 映射——三个消费点已全部补齐,显示不变。后续新增 Select 用法**必须**给 items(或接受显示原始值)。
- **onValueChange 签名**:`(value: Value | null, eventDetails)`——值可能为 null(清空/取消场景),消费点均已兜;新用法注意。
- **AnnotationPanel 的 Esc 拦截退役**:radix `onEscapeKeyDown` + stopPropagation 在 Base 无对等钩子(Esc 关闭统一走 Root.onOpenChange 的 eventDetails.reason,可 cancel 但拦不住底层键盘事件冒泡)。弹层本就 portal 到 body,原拦截防的是页面级 Esc 监听——若任务页有"Esc 关任务"类全局监听,select 开着按 Esc 可能连带触发,实测确认。
- item-aligned 模式 Base 在空间不足/触屏自动降级为对齐弹层(radix 无此自适应)——属增强不是退化。

## Verify by hand

- 意见处置下拉:展开对齐触发钮左缘、键盘上下选中项有高亮底、触发钮显示中文标签、Esc 关闭不连带关掉编辑器(重点);
- 环境形态下拉:虚拟化/容器化标签正确、选中回显;
- DTS 列表模块预绑:触发钮显示模块名、切模块即保存、禁用态半透明;
- 触屏/窄屏:item-aligned 空间不足时自动改弹层方向。
