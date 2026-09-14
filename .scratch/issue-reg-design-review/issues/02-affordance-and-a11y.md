# 02: 登记域操作可供性与无障碍打包——能点的看得出来,进行态读得到

**What to build:** DTS 列表里「进行中」徽标是包在 ghost 按钮里的静态胶囊,悬停才有底色,静态外观辨不出可点(IssueBoard 侧同款处已有注释承认此问题):给它与单号链接同款的 hover 下划线语言 + focus-visible 焦点环,键盘与悬停都即知可点;IssueBoard 侧同款注释所指向的样式属该文件在途改动,不在本票范围。无障碍三小修:登记页「截图上传中…」提示补 role="status"(与「远程查单中…」等其余进行态对齐);DTS 列表「列设置」弹层触发钮去掉 aria-pressed(那是切换钮语义),弹层开合语义交给 Popover 原语自带的 aria-haspopup/aria-expanded,列显隐状态由弹层内 Checkbox 表达;展开详情里「问题链接」的长 URL 加断行(min-w-0 + break-all),不再撑破详情网格。

**Blocked by:** None (can start immediately)

**Status:** done(本票即提交)

- [x] 「进行中」徽标静态外观即可辨可点:悬停下划线、键盘焦点环可见,读屏仍读出「打开 X 的进行中会话」。复审注:焦点环由 Button 基类 focus-visible:ring 自带,不另落;下划线不挂 offset(Badge overflow-hidden 且 h-5 贴边,默认位置最稳);契约锚 variant/size/group/live 结构钩子
- [x] 「截图上传中…」挂 role="status";列设置触发钮无 aria-pressed、开合语义由原语表达
- [x] 详情长 URL 断行(dd min-w-0 + 链接 break-all),详情网格不被撑破
- [x] 契约测试钉住四处决议;web typecheck + issueUiContracts 54 绿
