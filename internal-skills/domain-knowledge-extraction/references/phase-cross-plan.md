> 平台适配：本文中的 `_work/`、`spec` 和输出文件是研究内容的组织说明。实际任务从当前上下文与 `knowledge_work` 读取；中间发现用 `knowledge_work_result` 保存，最终正文用 `knowledge_draft` 保存到平台给出的目标和 docs_path。不得自行写本地文件。输出协议以 [平台执行协议](platform-pipeline.md) 为准。

# 跨模块规划：识别模块之间的链路和跨仓契约

所有模块都已完成。现在处理单看任何一个模块都看不到的东西。

## 输入

- 各模块的 `knowledge/chains/<模块>/README.md` 与 `interactions.md`。
- `_work/inventory.json` 中的 `depends_on`。
- `_work/scan.json` 中不同模块所属单元之间的依赖边（尤其是跨仓依赖）。
- 待确认问题（`_work/questions/`）中涉及多个模块的问题。

## 要识别的两类对象

**跨模块链路（chains）**：一个模块的动作触发或影响另一个模块的业务流程。例如：邻区关系变化后，负载均衡和移动性优化如何感知并调整；某个优化结果如何影响另一个优化的输入。判断标准是有真实的因果或数据依赖，并且在代码中可以找到证据（调用、消息、共享数据、通知机制）。

**跨仓契约（contracts）**：跨仓的接口或消息，其**语义约束**无法从定义本身看出。例如：字段取值的业务含义、调用顺序要求、兼容性规则、失败时双方的约定。仅仅是"存在一个接口"不值得写，要有语义约束才写。

## 产出：`_work/plans/_cross.json`

```json
{
  "chains": [
    {
      "id": "anr-to-mlb-mro",
      "title": "邻区关系变化对负载均衡与移动性优化的影响",
      "modules": ["anr", "mlb", "mro"],
      "questions": ["邻区删除后，MLB 正在进行中的负载迁移如何处理？", "……"],
      "related_code": ["backend:src/son/anr/notify/**", "backend:src/son/mlb/**"]
    }
  ],
  "contracts": [
    {
      "id": "backend-southbound-param-msg",
      "title": "后台到南向的参数下发消息",
      "repos": ["backend", "southbound"],
      "questions": ["……"],
      "related_code": ["backend:src/msg/ParamSetReq.h", "southbound:src/adapter/common/**"]
    }
  ],
  "notes": "……"
}
```

`id` 只能用小写字母、数字、连字符。总数不超过任务 spec 中的 `max_items`，按价值排序，靠前的优先。没有找到任何一类时，对应列表为空即可。
