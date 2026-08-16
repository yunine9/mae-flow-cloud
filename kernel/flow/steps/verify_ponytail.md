按下方内嵌的代码精简审查规则执行，范围 = git diff {基线分支}..HEAD 的变更
(只审本单 diff,禁止全库 audit)，不调用外部 Ponytail 插件。
按其原生输出对待结果:逐条 tag(delete/stdlib/native/yagni/shrink)+ 净减行数;输出 "Lean already. Ship." → 直接 done。
有建议 → 逐条精简,但守住两条边界:
- **YAGNI 不得砍规格条目要求的行为**——spec 是合同,"这功能没人用"不是删除理由;YAGNI 只作用于实现方式(怎么写),不作用于需求范围(写什么)。
  若你认为某条 spec 要求**本身**有误(矛盾/过时/实现揭出的不可行),同样不许砍——呈报用户裁决,
  确认后 goto open --ack 回流修订 spec,再顺流回来(裁决通道,不是死路);
- **delete 只作用于本次的代码**:本次新增的多余代码、被本次改动弄死的旧代码,删;
  顺路发现的、**不是本次弄死的**旧死代码,在本步报告里点一句位置交用户定夺,diff 里不出现——
  它可能被反射或外部仓按名字调用,而且顺手删会让本单 diff 混进与需求无关的行(编码基准第 13 条);
- correctness/security 类问题不归本步(ponytail-review 明确出界),**必须落盘**:逐条写进
  实现清单备注行(格式:`> 待核对(correctness): <现象+位置>`),verify 阶段规格符合性检查时
  逐条核对处理——只留在会话里=一次 /clear 就蒸发。
本需求只执行这一轮 Ponytail，不因后续 CodeCheck/UT 返工重跑。精简后保持改动未提交并执行 done：
状态机会自动进入 compile-agent，编译通过后进行统一用户检视；确认后才精确提交并进入 CodeCheck。
没有源码变化则直接进入 CodeCheck。主会话不要自己编译，也不要在本步提交。
(本步排在 CodeCheck 与 UT 之前:先删掉该死的代码,再修规范、再补测,不做无用功。)

──── 本步骤内嵌方法原文（已固定版本） ────
{{CAPABILITY_PACK:ponytail-review}}

本步的取舍依据（精简与质量链的判断口径），见 `.mae-flow-work/plugin-resources/guidance/quality.md`。
