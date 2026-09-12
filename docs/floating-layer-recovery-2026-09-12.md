# 工作台浮层遮挡修复

现场表现是点击任务详情等入口后，看不到面板，原页面也不能继续点击。真实服务在修复前能复现：无障碍树已有任务详情及关闭按钮，截图却仍只有工作台。

`456e76ce` 没有修改前端。问题来自此前公共组件迁移留下的 `z-50`：工作台为 120，部分全屏内容达到 720。Sheet 的遮罩和内容低于工作台，但模态组件照常锁定背景交互。只修 Dialog 仍会遗漏抽屉，以及弹窗内被遮挡的 Select。

沿用现有层级，不增加任意数值或样式覆盖：Dialog、Sheet 使用 `--z-modal`；确认框及 Popover、Select、DropdownMenu、Tooltip 的 Portal 根使用 `--z-topmost`。菜单必须提高 Positioner 根层级，仅调整其内部 Popup 无效。

验证：

- `npm run gate`：类型检查、前端构建、134 项通过，1 项既有环境条件跳过。
- `tests/floatingLayerBrowser.test.ts`：真实生产 CSS 和 Chrome 验证六种浮层在全屏内容上可命中，包含模态框内选择下拉项；运行前需构建 web，Chrome 路径可由 `MFC_TEST_CHROME` 指定。
- 扩展现有 CSS 棘轮检查 TSX Portal 根，防止 Tailwind 类绕过原来只扫描 CSS 的检查。
- 真实服务 8956：任务详情展示与关闭、关闭后切换原始需求和返回列表、邀请检视弹窗、环境表单内展开并选择容器化、取消表单后进入账号管理。模态框关闭使用真实浏览器点击验证，不依赖虚拟时钟。

本地截图保存在 `.pilot/floating-layer-fix-evidence/`。本次只改公共浮层层级，不变更任务状态或业务动作。
