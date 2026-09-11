# 项目级迁移报告:radix-ui → @base-ui/react

2026-09-11, 整仓迁移(用户指令"把当前服务的组件换一下")。风格为 legacy
`new-york`(无 base-new-york golden pair)——按技能纪律走变换引擎:只重接
原语、逐字保留项目自己的类与外观,不重绘风格。**最终:0 个包装层留在
Radix 上,radix-ui 依赖已卸,web 构建绿(与基线同款存量 chunk 体积警告)。**

## 依赖变化

- `@base-ui/react@1.8.0` 加入;`radix-ui@^1.6.7` 移除(npm uninstall,lock 同步)。
- 未触碰的非 radix 三方:无 cmdk/vaul/sonner/input-otp/react-day-picker/recharts——本项目 UI 面只有 radix 与手写件。

## 组件清单(依赖序,每组件一提交)

| 组件 | 策略 | 要点 | 报告 |
|---|---|---|---|
| button | 引擎→真 primitive | Slot idiom → `@base-ui/react/button`(原生 render) | button.md |
| badge | 引擎(useRender) | Slot idiom → useRender+mergeProps;标签筛选钮改 render | badge.md |
| checkbox | 引擎(1:1) | data 属性改写;indeterminate 拆独立 prop;全选三元随迁 | checkbox.md |
| dialog | 引擎(重排) | Overlay→Backdrop、Content→Popup;动画重述;内部 Close 改 render | dialog.md |
| popover | 引擎(Positioner) | Portal>Positioner>Popup;两 Trigger asChild 改 render;Anchor 零消费者退役 | popover.md |
| select | 引擎(重排+改名) | List/ScrollArrow/GroupLabel;**Value 渲染语义变化→三消费点补 items**;position→alignItemWithTrigger;focus:→data-highlighted: | select.md |
| tooltip | 引擎(Positioner) | delayDuration→delay;零消费者 | tooltip.md |
| collapsible(App.tsx 直用) | 引擎 | Trigger asChild→render;Content→Panel | collapsible.md |

## 应用代码清扫(consumer-props 面)

- `asChild` 全仓清零(5 处:环境快选钮、列筛选漏斗、标签徽章钮、问题导航父行、dialog 内部 Close)。
- `position="popper"` 3 处 → `alignItemWithTrigger={false}`。
- `checked="indeterminate"` 1 处 → 拆 prop。
- `onValueChange` 空值语义:3 处补 `?? 兜底`。
- `--radix-*` CSS 变量全仓清零(app 侧 1 处 `--radix-popover-trigger-width` → `--anchor-width`)。
- `onEscapeKeyDown`(AnnotationPanel 的 select)无 Base 等价,退役并 FLAG(见 select.md 行为差异——Esc 拦截原本防的是页面级监听,接入后实测确认)。
- 动画 idiom:`data-[state=x]:animate-in/out + fade/zoom/slide` 家族全部重述为
  `transition-[opacity,transform] + data-starting-style:/data-ending-style:`(tw-animate-css 保留在依赖里,存量 App.tsx 其他区域自用不受影响)。

## ⚠ FLAG:风格名仍是 radix 侧的(用户决定,未擅动)

`components.json` 的 `style: "new-york"` 没有 base 对应物(不存在 base-new-york,
强行换 base-<别的风格> 会重绘全站外观)。后果:**今后 `shadcn add <组件>` 仍会拉到
radix 变体**——新组件要么手工按本仓 7 个已迁包装层的形态照猫画虎,要么在 add 后
立即按 `.migration/` 对应参考重接。想根治需整体切到某个 base-<style>(外观会变),
由你拍板。

## 验证

- 每组件一提交,提交前 `tsc --noEmit` 全绿;基线(迁移前)tsc 与 `npm run build` 均绿;
- 终态:src/ 零 radix 引用(`grep -rn "radix-ui\|@radix-ui" src/` 空)、radix-ui 出依赖、
  `npm run build` ✓ built in 7.75s(chunk >500kB 警告为存量,基线同款);
- 手工 QA 清单在各组件报告的"Verify by hand"节,重点三处:select 触发钮中文标签
  (items 映射)、键盘高亮(data-highlighted)、AnnotationPanel 的 Esc 联动。

## 派生状态(扫盘即得,不另记账)

- ui 目录 radix 导入:0。Radix 残留:无。
