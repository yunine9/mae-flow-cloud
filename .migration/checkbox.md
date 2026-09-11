# checkbox

2026-09-11, 变换引擎(部件 1:1,类名映射)。判词:干净落地,一处消费点拆 indeterminate。

## Changed

- `web/src/components/ui/checkbox.tsx`:
  - `import { Checkbox } from "radix-ui"` → `@base-ui/react/checkbox`;
  - `data-[state=checked]:`→`data-checked:`、`data-[state=indeterminate]:`→`data-indeterminate:`;
  - `disabled:` 伪类 → `data-disabled:`(Base Root 渲染 `<span>`,伪类成死码,按 class-mapping 规矩换);
  - 公开形态跟进 Base:`checked` 恒 boolean + 新增独立 `indeterminate` boolean;指示图标三元判据从 `props.checked === "indeterminate"` 改为 `indeterminate` prop。
- `web/src/issues/Registration.tsx:877`(DTS 表全选):`checked={… ? true : … ? "indeterminate" : false}` 三元 → `checked={全选}` + `indeterminate={!全选 && 有选中}`。
- 遗留扫描:checkbox.tsx 无 radix 引用;全项目 Checkbox 消费点仅此一处。

## Left alone

- 无(单消费点已随迁)。

## Behavior changes

- 无预期差异;半选态由 `data-indeterminate` 属性样式呈现(与原 `data-[state=indeterminate]` 等价)。

## Verify by hand

- DTS 列表全选框:无选=空、选一部分=横杠、全选=勾;键盘空格切换;禁用态半透明。
