Story 保持既有业务模板；实施附录只承载 Story 装不下的那一件事——文件结构与任务边界。
附录写什么、写到什么程度，一律以 `IMPLEMENTATION-TEMPLATE.md` 为准（它已写明"只写签名不写实现、全文不出现函数体"），
这里不再重复规定：同一件事在两处规定，迟早互相打架。

1. 从项目本地资源取得 `STORY-TEMPLATE.md` 和 `IMPLEMENTATION-TEMPLATE.md` 精确路径。
2. 执行 `python "{MAEFLOW_PATH}" role-task story-generate`，把输出的唯一启动话术原样交给 story-generator-agent。任务卡明确给出 `.mae-flow-work/{单号}/spec.md`、`grill.md`、相关 `docs/specs/*.md`、两个模板和代码路径。
3. 生成 `.mae-flow-work/{单号}/story.md` 与 `implementation.md` 后，执行 `python "{MAEFLOW_PATH}" role-task story-review`，把输出的唯一启动话术原样交给 craft-reviewer-agent，执行一次联合设计检视；任务卡给出同一组输入和两个输出路径。
4. 主 Agent 根据检视结果修正真实问题；不得因文件时间戳、摘要、格式或修正动作自动重新派 Reviewer。
5. 展示 Story 章节摘要、实施附录和全部未决项，用本步骤唯一一次用户选择明确分流：
   - `Story 与实施附录无需再调整，确认进入编码`
   - `Story 或实施附录仍需调整（按当前检视意见修改）`
   选择调整时先留在本步更新对应文件、重新展示；只有选择“无需再调整”才执行
   `done` 进入编码。不得把附带待处理意见的回答当作确认通过。

Story 与实施附录都不入库。禁止生成额外的编码前计划过程件。

本步的取舍依据（设计取舍与接口深度），见 `.mae-flow-work/plugin-resources/guidance/story-design.md`。

Story 转测自检表属于后续转测阶段：串讲、翻译、DT、自验证等动作未执行时如实保留“待确认”“待执行”，不得为进入编码改成“已完成”。设计正文与实施附录的真实未决项仍须在确认前呈现并裁决；不要把设计未决项移入自检表规避检查。

测试设计以本单 Spec 的用例编号为准：Story 既有测试章节说明内部设计、装配入口与依赖替换方式，引用相应用例，不手工复制另一份完整用例清单。实现中发现遗漏或设计变化时，同步修订受影响用例并说明原因；尚未执行的验证保持计划状态。
