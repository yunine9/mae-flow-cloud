---
name: issue-delivery
description: 交付流程。阶段性推送或提 MR 时使用:分支核实、提交格式、push_branch 推送、一仓一 MR、complete_stage 申报验绿;多仓逐仓各走一遍。
metadata:
  tags: [issue, delivery, branch, commit, mr, codehub, multi-repo]
---

# 修复交付

前置:方案经用户确认,会话已绑定单号;没绑定请用户去页面绑定。

怎么改码调用 implement 技能,冲突时以本 skill 为准。本地适配:先写能复现问题的单测再改码转绿;收尾只跑与本修改直接相关的测试,全量回归交给平台流水线。

## 1. 分支

修复分支 `master_<工号>_<单号>` 由平台在 `pull_repo` 时自动切好,开工前 `git branch --show-current` 核实;回执报过「基线分支不可用」的仓没有分支,问用户定分支来源。

## 2. 提交

提交信息必须匹配 `[单号][类型] 描述`(CodeHub pre-receive 会拒收不合规提交):
- 类型白名单:feat/fix/refactor/test/chore/docs/style(修 bug 用 fix);
- 例:`[DTS2026082001317][fix] 修复登录超时`;
- `git add` 只加本次范围的文件;工作区可留未提交改动,推送只发已提交历史,如实说明未包含的改动。

## 3. 推送

`git push` 在容器里被禁用,推送用 `push_branch`(不受阶段限制),多仓改过的仓各自调,`repo` 传该仓地址。

同单重跑撞远端遗留分支时推送被 non-fast-forward 拒绝(回执会点名):确认是本单上次遗留后带 `force: true` 重推覆盖(平台按租赁式核对远端旧 tip,不盲盖)。该分支已有 MR 的,覆盖后原 MR 自动更新,不重复建。拿不准是不是本单遗留,先 AskUserQuestion 核对。

## 4. 提 MR

`create_mr` 逐仓调用,`repo` 参数指定仓;标题由平台按绑定单号自动填写、自动关联,不用填。合入由用户决定,不由你执行。

## 5. 申报验绿

建齐 MR 后调 `complete_stage` 申报 MR 清单(mrs 参数:MR 链接或仓地址)。平台核对清单台账(少报/多报点名打回)并验流水线:有红当场打回,修完同分支再推、重建 MR 后重新申报;流水线在跑则停等,绿了自动收口。

## 多仓口径

- 只给真正改过的仓建 MR,没改的不硬凑。
- 每个改过的仓:各自分支(同名)→ 各自 push_branch → 各自 create_mr → 一起申报。
- UT 结果(`report_ut`)只是事实上报,不是建 MR 的前置。

## 边界

- 只改与这张单相关的代码;发现顺带问题,先问用户是另开问题还是本单处理。
