质量链与领域归档已结束。执行 `manifest set` 生成当前尚未提交改动的精确交付清单。

领域归档有真实增量时，使用
`manifest set --file <精确路径> [--file <精确路径>...] --message <提交说明> --target <目标分支>`。
清单只能包含当前尚未提交的真实候选增量，禁止把已经提交的源码再次加入清单。

领域归档结果明确为 `unchanged` 且没有新增未提交文件时，使用
`manifest set --unchanged --target <目标分支>`。该命令生成已确认的空操作清单，直接执行 `done`；
无需再次询问用户，也无需创建空提交。

普通模式：向用户展示清单，只确认一次；收到回答后执行 `messages`，再用
`manifest confirm --message-id <消息ID>` 绑定文件、提交说明和目标分支。

月光宝盒：禁止询问用户，使用 `manifest confirm --moonlight-auto` 绑定同一精确清单，并把自动裁决、
完整 diff 和质量证据写入晨间报告。

非空清单确认后执行清单给出的精确 `git add -- <文件...>`，再按 `[单号][feat|fix]描述` 创建一个提交；
禁止目录、glob、全量暂存、amend 或夹带过程文件。提交成功后执行 done；非空清单没有真实提交不能进入 push。
