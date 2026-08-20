{{#LOCAL_COMPILE}}
执行 `python "{MAEFLOW_PATH}" agent-task compile --scope "质量阶段源码改动"`，按任务卡启动 compile-agent。
编译成功后执行 `done`，回到统一质量改动检视。保持全部改动未提交；compile-agent 禁止提交或推送。
{{/LOCAL_COMPILE}}
{{#PIPELINE_COMPILE}}
本机没有构建链。不要生成 COMPILE 任务卡或启动 compile-agent；直接执行 `done` 登记外部
COMPILE 义务，再回到统一质量改动检视。流水线核销前状态只叫“待验证”，不叫编译通过。
{{/PIPELINE_COMPILE}}
