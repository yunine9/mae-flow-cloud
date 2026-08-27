---
name: issue-delivery
description: 问题修复的交付环节:建修复分支、按严格格式提交、经平台推送、创建 MR。用户确认修复方案要动代码时使用。
metadata:
  tags: [issue, delivery, branch, commit, mr, codehub]
---

# 修复交付(分支/提交/推送/MR)

前置:方案已经过用户对齐确认,且**会话已绑定单号**(没绑定时请用户去页面绑定——推送和 MR 的机械门禁都查它)。

## 1. 建分支

在 repo/ 里:`git checkout -b master_<工号>_<单号>`(如 master_y00965296_DTS2026082001317)。工号/单号以会话开场说明为准。建前确认工作区干净。

## 2. 实施+提交

提交信息**必须**精确匹配 `[单号][类型] 描述`(CodeHub pre-receive 钩子会拒收不合规提交):
- 类型白名单:feat/fix/refactor/test/chore/docs/style(修 bug 用 fix);
- 例:`[DTS2026082001317][fix] 修复登录超时`;
- `git add` 只加本次范围的文件,禁用 `git add -A`。

## 3. 推送(平台工具)

`git push` 在容器里被禁用(pushurl 指向 /dev/null)——推送必须调 `push_branch` 工具。它会校验分支名必须是 master_<工号>_<单号>,从宿主完成传输并复核远端 SHA。

## 4. 换库验证后提 MR

如需环境验证:`build_deploy` 部署 → ⚠️停下用 AskUserQuestion 等用户验证结果 → 通过后 `create_mr`(title 缺省为 [单号] 问题标题,自动关联单号)。**合入不由你执行**——MR 门禁与合入是用户的决定。

## 边界

- 只改与这张单相关的代码;发现顺带问题,先问用户是另开问题还是本单处理。
- 提 MR 后上报 stage=submit_mr;会话收口由用户归档。
