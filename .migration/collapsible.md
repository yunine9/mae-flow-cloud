# collapsible(App.tsx 直用)

2026-09-11, 变换引擎(直用原语,非 shadcn 包装层)。判词:干净落地。

## Changed

- `web/src/App.tsx:7`:`import { Collapsible } from "radix-ui"` → `@base-ui/react/collapsible`;
- `web/src/App.tsx:1635`(问题处理导航组):`Trigger asChild><button>` → `render={<button …/>}`;`Content` → `Panel`;注释里的"radix Collapsible"措辞随迁。Root 的 open/onOpenChange(单参处理器)签名兼容,零改动。
- 遗留扫描:App.tsx 无 radix 引用。

## Left alone

- 展开动画:radix 版本也没写动画类(裸 Content 即显即隐),Panel 保持同款裸行为,未加 starting/ending 动画——视觉零跳变。

## Behavior changes

- 无(onOpenChange 加宽的第二参不影响单参处理器)。

## Verify by hand

- 侧边栏「问题处理」父行:点击展开/收起、chevron 旋转跟手;进入问题处理视图自动展开;深链 /issues 落默认子页签。
