评审意见处理阶段的独立增量 UT 步骤。harness 已冻结本轮基点，任务卡只列本轮文件。

先直接尝试 done：本轮没有业务代码改动时机器自动放行；有业务代码改动则必须拿到 UT PASS。
需要 UT 时：
0. 先审计并复用已有测试；覆盖充分时无需为了制造差异重写，只有缺口才补测试；
1. 执行 `python "{MAEFLOW_PATH}" agent-task ut`；
2. 把命令输出的**唯一一句启动话术原样**交给 ut-generator-agent，禁止自行拼任务；
3. Agent 必须读取任务卡并按其中 `UT生成方式` 调用 Mae-Flow 插件自带的
   AutoUT/java-autout Skill 或既有写法；
{{#LOCAL_UT_RUN}}
   参考 `UT运行命令` 真实执行测试；该项写“随生成方式自带”时由对应 Skill 按项目决定；
4. Agent 返回后以真实测试调用和退出状态判断；失败不能当通过，返回文字不参与格式校验。
{{/LOCAL_UT_RUN}}
{{#PIPELINE_UT_RUN}}
   本机只负责编写/审计测试，不运行测试、不编造数字；
4. 每个编写批都必须真实返回。全部完成后执行 `done` 登记待流水线核销的 UT 运行义务。
{{/PIPELINE_UT_RUN}}

任务卡按修改函数自适应分批，每个实例只执行 Harness 当前签发的一批。批间共享本轮未提交测试，
不逐批提交、不逐批询问用户；全部批次结束后
{{#LOCAL_UT_RUN}}必须用收口实例执行全量 UT，{{/LOCAL_UT_RUN}}
{{#PIPELINE_UT_RUN}}不再派本地运行批，{{/PIPELINE_UT_RUN}}
随后只进行一次统一用户检视和提交。

PENDING_QUESTIONS / SUSPECTED_BUGS 仍按主流程协议呈用户裁决；未经用户确认，UT agent 和主会话都不得修改被测源码。
源码经 unlock 修复后执行 done，Harness 会先
{{#LOCAL_COMPILE}}回流编译{{/LOCAL_COMPILE}}{{#PIPELINE_COMPILE}}刷新外部编译义务{{/PIPELINE_COMPILE}}
和统一检视，提交后从评审意见 CodeCheck 继续，
不回跑 Ponytail。未经 unlock 却检测到被测源码变化会直接判越权。

本仓未配「测试路径」时也不再放开任意源码写入：harness 使用 tests/、test/、src/test/、*_test.*、*Test.java 等保守默认规则。本仓是非标准测试目录时，先在 `.mae-flow-defaults.json` 补「测试路径」，不要用 unlock 长期绕过。
