# 01: 登记域微文案与中文标点体例清一——动词归「发起」,体例归一律

**What to build:** 用户在「问题登记 / DTS 列表」两个页签里,同一件事(发起一次问题处理)看到同一个动词,中文标点全域一律。词汇:RepositoryResourceNotice 两处「下单」改「发起」(旧词汇残留);登记页主按钮「开始分析」改「发起分析」、busy 态「分析中…」改「发起中…」——与 DTS 页「发起处理 / 发起中」同构(发起 + 域词),与成功提示「成功发起 N 张」同词。标点体例(本域既有惯例=半角逗号 + 全角句号 + 直角引号「」):网管环境密码说明行里的全角逗号改半角;「隐藏远程单提示」与「无可拉取状态」两处给状态串套的英文直引号改直角引号;RepositoryResourceNotice 的全宽斜杠「／」改半角、「…… · 查看详情」间隔号衔接改为句内直述;DTS 页 DEV 徽标行「DEV·模拟 DTS」的间隔号去掉,中西文之间留空格。

**Blocked by:** None (can start immediately)

**Status:** done(本票即提交)

- [x] 「下单」在登记域(两页签 + RepositoryResourceNotice)UI 文案清零;登记页提交钮「发起分析」、busy「发起中…」。备注:web 其余 11 个文件的「下单」多住需求域词汇与注释,属全域漂移,不在本票范围
- [x] 域内 UI 文案体例一致:半角逗号/冒号/分号、全角句号、直角引号;全宽斜杠与「/」「·」间隔号元信息串清零(含弹窗文件清单行)
- [x] 中西文之间留空格(「DEV 模拟 DTS」)
- [x] 契约测试钉住词汇与体例决议(issueUiContracts 新增一锚,业务模块加载失败改锚随标点归一律);web typecheck + issueUiContracts 53 绿 + issuePolish/launchForm/dtsText/helpCenter 65 绿
