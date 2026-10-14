# 平台执行与交付约定

本包是随平台代码发版的内置领域萃取方法，在方法阅读页查看；维护本方法时修改仓库中的本包并随代码交付，不通过任务会话上传或替换方法。任务仍执行其固定版本，运行中任务不会因仓库文件修改而切换。业务资料上传属于来源输入，和方法维护不同。

原模板中的多仓图用于说明逻辑关系；源码只读，文稿由平台保存到各自目标仓。包内文件用 extraction_skill 读取，工具参数以本轮实际定义为准。写作与评审均读取 [共同质量要求](document-quality.md)。

## 工具与原工作方式的对应

| 工作 | 平台操作 | 读到或保存什么 |
|------|----------|---------------|
| 读取提示词和模板 | extraction_skill，指定包内 path | 本次固定版本的完整 Markdown |
| 识别仓 | 上下文 repositories；knowledge_structure 不填 repository_id | 本次来源仓与用户限定范围 |
| 扫描目录与构建候选 | knowledge_structure 指定 repository_id；component_source list | 候选结构，仍需逐仓读源码核实 |
| 查看跨仓构建候选 | knowledge_structure 同时填 repository_id 与 include_dependencies=true | 显式扫描配置的各仓，返回所选仓的依赖候选 |
| 搜索和通读源码 | component_source search/read，指定 repository_id | 固定版本文件、实际返回的行号 |
| 保存 current-plan.md | knowledge_work save_document，id=current-plan | 完整规划过程文稿，不进入知识发布 |
| 登记完整输出清单 | knowledge_work plan，document_ids 与 work_document_id | 全部预期文稿编号，关联已保存规划正文 |
| 分页读取输出清单 | knowledge_work read_plan，start/limit | document_ids 分页、total、next_start 与排除说明 |
| 读取规划 | knowledge_work read_document，id=current-plan | 完整规划正文；不支持章节读取，本项必要字段由 step.instructions 提供 |
| 保存知识文稿 | knowledge_draft save | 指定目标中的草稿或修订建议 |
| 读已生成的文稿 | knowledge_draft read，指定 id | 当前正文、sources 与 revision |
| 独立分析、写作和核查 | 主会话 knowledge_work schedule/run | 独立上下文与持久结果 |
| 校验源码引用 | knowledge_source_check | 路径、行号、符号存在性；结论仍需阅读源码核实 |
| 校验 PlantUML | knowledge_diagram_check，document_id 或 work_document_id 二选一，可选 start/limit | 知识文稿或过程稿当前正文的真实渲染报告、图位置及错误；不判定业务语义 |
| 取得业务依据 | knowledge_material、business_knowledge、knowledge_evidence | 按 [来源方法](business-sources.md) 读取上传资料和无线背景，保存可回读的位置及适用范围 |

本平台不提供工作目录写文件、Shell 或 codebase_graph_explore。追踪调用链时用源码中的真实方法名继续 search/read，逐跳读入口、实现、参数、返回处理和异常分支。子步骤不再安排子步骤，文稿独立评审通过写作步骤的 review 配置执行。

## 保持有界上下文

knowledge_work read 不带 id 只返回进度摘要与 plan 数量，不返回全部工作正文。需要具体结果时 read 指定步骤 id；完整计划编号用 read_plan 按 next_start 继续分页，排除说明也有自己的分页。knowledge_work list、read_document 不带 id，以及 knowledge_draft read 不带 id 均返回分页摘要，start 从 0 开始，limit 默认 30、最多 100；返回 next_start 时继续到末页，不能将第一页当作全部文稿。

主会话只保留范围、清单、短摘要和结果/证据编号。每个调查、写作或评审单元只接收自己的范围、方法入口与证据索引；开始时按 id 读取必要结果，并重新打开本项原始源码或资料。资料摘要中的章节/文档/图片/警告数量不是正文；已有相关资料编号与位置时直接读取，不要求每个单元重新列出全任务资料。业务来源的 data.source_index 与恢复方式见 [来源方法](business-sources.md#来源索引与独立会话交接)。共享结果是定位线索，不代替当前单元的原始依据。可写步骤需要保存过程文稿时，id 使用 `步骤编号--名称`；current-plan 由主会话维护。只读步骤将发现保存到自身 knowledge_work_result，不写过程文稿。

## 读取必须覆盖真实范围

component_source list/read 的 start/end 从 1 开始：list 默认当前目录层，recursive=true 才递归；read 用实际完整文件路径及行范围。收到续读或截断提示时从实际返回位置继续读取相关范围，默认首段不是全文。search 按每个仓执行，keywords 是多个字面词的任意命中，query 是完整字面短语，二者不作正则；搜索截断时缩小到具体目录或关键词，不假定 search 有列表分页参数。完整路径来自 list/search，不能只凭文件名猜测。沿每个功能入口读到实际处理终点，再核对定时任务、事件和配置分支。

knowledge_structure 指定 repository_id 时用 start 从 0 开始，按返回的 next_start 继续；目录、构建文件、构建单元和依赖候选各有数量及分页信息。带 *_preview 的字段只是预览，preview_complete=false 或 dependency_truncated=true 时按 source/from 读取完整构建文件，不把预览当作全部依赖。需要跨仓候选时显式 include_dependencies=true，默认单仓读取不能证明没有跨仓关系。

knowledge_structure 只提供静态候选，不能据此断言没有跨仓关系。接口与调用双方、数据模型、状态变化和关键配置要回到源码确认。首次阅读记录文件与行范围；独立评审打开这些原文件，不能只看作者的摘要或路径清单。

## 规划与路径

规划使用 prompts/plan-template.md 的完整结构。正文清单记录全部预期产物；执行关联表把每项绑定到稳定 document_id、目标仓、写作步骤及最近通过的评审版本。保存正文后用 plan 操作登记全部文稿编号，宿主据此核对漏排或漏生成的文稿。步骤状态以 knowledge_work 实际记录为准，不能只修改规划表就声称完成。

先核对 module_id、scope、knowledge_layout 与 archive_targets；关联仓是源码来源，不代表本任务拥有整个仓的业务或公共文档。浅层盘点定位本业务入口后，仅深入本业务及解释完整链路所需的共享实现。其他业务作为有依据的边界或依赖记录，不为它们生成整套知识。模板中的“模块文档”按本业务内部功能划分，与稳定的 module_id 不是同一层级。

knowledge_layout 为 repository-v1 时，target_id 选择实际归档仓，document.path 是该仓根目录下的完整相对路径。target.docs_path 是用户配置的最终位置，`.` 表示仓根；路径中不写 `./`、工作区仓名前缀或 module_id。module_id 只标识业务归属，不能作为目录名，也不能代替业务名称。

- 领域文稿放在领域 target.docs_path 下；新任务的默认目录由平台根据业务名生成。按工具返回的实际目录写作，Agent 不自行重算目录名。
- 仓级目标默认为仓根。首次生成采用 `docs/README.md`、`docs/module-map.md`、`docs/rules/`、`docs/modules/`；已有文稿保留仓根相对路径，例如 `docs/module-map.md` 仍是 `docs/module-map.md`。工作区的 `FMProductFrontendService/docs/module-map.md` 归入该仓目标时，path 是 `docs/module-map.md`。
- 用户配置其他目标目录或逐篇路径后，沿用平台保存的实际位置，不重复拼接目录。已保存完整 path 优先于模板中的示例；同仓相对链接按最终文件位置计算。

下表用 D 表示领域实际文稿目录、R 表示该仓实际文稿目录；repository-v1 新仓级文稿的 R 默认为 `docs`，不是值为 `.` 的 target.docs_path。保存时将 D、R 换成真实路径，不能将符号写入产物。

| 模板 | 目标与默认 path |
|------|----------------|
| domain/root-agents.md | 领域目标，D/README.md：本业务领域入口 |
| domain/domain-agents.md | 领域目标，D/index.md：本目录详细索引与维护说明 |
| 其他 domain/ 模板 | 领域目标，D/glossary.md、D/architecture.md、D/domains/、D/interfaces/、D/external/ 下实际文件 |
| repo/repo-agents.md | 对应仓目标，R/README.md：本业务在该仓的职责、命令与路由 |
| repo/module-map.md | 对应仓目标，R/module-map.md：本业务功能索引 |
| 其他 repo/ 模板 | 对应仓目标，R/rules/、R/modules/ 下实际文件；真实经验在对应功能的 experience/ 下 |

目标文件已被其他文稿占用时，平台自动添加稳定文稿 ID 后缀，必要时再加序号，并修正文稿间链接；同仓多个业务可以共用目录。沿用避让后的实际 path 和入口，不改回重名文件，不通过追加 module_id 规避冲突，不覆盖其他文稿正文。平台在已有导航文稿中保留可读清单，没有 README.md/index.md 时使用现有文稿承载清单。

每仓只有根 AGENTS.md 作为统一 Agent 入口，由平台按实际知识入口生成并覆盖旧正文，旧内容留在 Git 历史中。根入口不进入模型的 plan、expected_document_ids 或草稿；它只提供可读路由、读取范围与维护约定，不写机器标记或某个业务的具体规则。模型维护普通 Markdown 文稿，root-agents.md、domain-agents.md、repo-agents.md 是模板标识，产物名按上表和保存路径确定，不生成嵌套 AGENTS.md。

已有 module-v1 或 legacy 任务接续时沿用当前保存的文稿位置及固定 Skill，不由 Agent 自行迁移，也不重做已完成研究。平台整理路径时保留正文、编号、调查与历史，更新路径和相对链接；从旧 AGENTS.md 迁入的约定仅在文稿声明的业务范围内使用。发布仍只发布本次选中的文稿，路径整理不授权发布其他草稿，也不绕过正式版本及并发修改核对。历史 current-plan 和步骤结果保持原记录，后续研究以当前保存的文稿位置为准。

Git 归档由维护人发起，发布到平台不会自动创建 MR。已有归档批次重试沿用冻结的文稿、目标路径与布局，module-v1 批次不因新规则改变路径；已推送且回执一致的提交及已创建 MR 按原记录恢复。调整路径后重新归档由平台处理，Agent 不自行关闭 MR、删分支或用草稿删除旧文件。

同仓链接按文稿实际所在位置计算相对路径；跨仓引用明确写出仓名和包含 docs_path 的仓内路径，已知真实仓链接时可附链接。仓名只是跨仓定位，不是知识仓内真实存在的目录。全部路径占位符在产物中替换为实际值。

完整 current-plan 保存格式：

```json
{"action":"save_document","document":{"id":"current-plan","title":"文档生成规划","content":"完整 Markdown 规划正文"}}
```

随后登记完整清单，示例中的 document_ids 必须替换为本次全部规划文稿编号，不能只列最先生成的几篇：

登记前以 knowledge_diagram_check({work_document_id:"current-plan"}) 读取当前规划的全部图表报告；invalid 修正后保存/重查，unavailable 保留已保存规划并报告依赖问题。plan 登记和最终 complete 时宿主还会核对该过程稿，不需要另建知识文稿来校验。

```json
{"action":"plan","work_document_id":"current-plan","document_ids":["domain-readme","domain-index","glossary","architecture","import-domain"]}
```

新增文稿时先更新规划正文，再用 plan 提交包含原清单与新增编号的完整集合。确实不适用的原条目，通过 exclusions: [{document_id, reason}] 说明源码证据或用户范围变更，正文同步保留排除理由；不得以困难、失败或篇幅为由删掉必需产物。discard 只处理不再执行的步骤，不替代计划排除说明。

## 独立调查

主会话先看仓列表、构建文件和目录入口以划分工作，不在分工前通读全仓业务实现。多仓与大规模源码按仓、业务入口和完整场景拆成只读调查单元；每个单元有独立 instructions、实际源码范围、相关资料编号/来源索引与具体问题。调查按来源方法回读相关资料，需要理解无线概念时先复用已有背景原文再补查。以下示例中的仓编号、路径及方法名应先用本次浅层盘点结果替换，不能把示例当成真实来源：

```json
{
  "action": "schedule",
  "steps": [
    {
      "id": "research-import-api",
      "title": "调查导入服务的业务入口与源码范围",
      "instructions": "按 prompts/plan.md 调查 repository_id=repo-api。已盘点入口 src/import/ImportController.java，构建 pom.xml。完整识别导入相关公开入口、定时任务和事件处理，沿调用读取实现、状态、配置与外部交互；区分单条与批量场景，返回各场景涉及文件/符号/行范围、下游仓及尚未确认的问题。这里只保存调查结果，不写知识文稿。用 knowledge_work_result 提交简短 summary、document_ids=[]，data 中保存范围、场景和证据索引；不复制源码全文。",
      "depends_on": [],
      "readonly": true
    },
    {
      "id": "research-import-worker",
      "title": "调查导入执行仓的业务入口与源码范围",
      "instructions": "按 prompts/plan.md 调查 repository_id=repo-worker。已盘点入口 src/import/ImportWorker.cpp，构建 CMakeLists.txt。从任务与消息入口追踪导入执行、结果返回、状态变化、存储和清理，识别全部相关场景及外部系统。独立回读原始代码，不等候另一仓的摘要。用 knowledge_work_result 提交简短 summary、document_ids=[]，data 中保存范围、场景、文件/符号/行范围及待核实跨仓调用；不复制源码全文。",
      "depends_on": [],
      "readonly": true
    }
  ]
}
```

```json
{"action":"run","concurrency":3}
```

每个调查会话在自身上下文使用实际源码工具完成读取，再通过 knowledge_work_result 保存结果。下面仅说明结果结构，字段值必须来自实际读取：

```json
{
  "summary": "已识别导入服务的单条与批量入口；批量结果如何通知调用方仍需核对执行仓。",
  "document_ids": [],
  "data": {
    "scope": {"repository_id":"repo-api","paths":["src/import/"]},
    "scenarios": [{"name":"批量导入","entry":"ImportController.importBatch","evidence_ids":["api-batch-entry"]}],
    "evidence_index": [{"id":"api-batch-entry","repository_id":"repo-api","path":"src/import/ImportController.java","symbol":"importBatch","start_line":40,"end_line":86,"finding":"入口与参数构造，行号须替换为实际返回位置"}],
    "open_questions": ["核对执行仓的完成事件与服务仓消费入口是否对应"]
  }
}
```

summary/data 随步骤结果持久保存；只读单元不能调用 save_document。涉及上传资料或无线背景时，在上述 data 中增加来源方法定义的 source_index、source_gaps 和 source_conflicts；它们与源码 evidence_index 分工，不把通用背景列为实现依据。步骤列表和默认工作摘要不带 data，主会话按 id 读取必要结果，只保留短摘要与引用，不把每份源码或完整发现附加到自己的长期上下文。需要继续核实的跨仓链路可单独登记只读步骤，depends_on 列出双方调查编号，instructions 只传待核实场景和证据索引；该步骤仍要打开调用两端原始代码。单元及后续写作开始时重新读取自身依据；无依赖单元并行，真实依赖先完成，本包不启动外部编排程序。

## 规划核查

区分两个位置的 review：

| 字段 | 谁填写、何时填写 | 含义 |
|------|------------------|------|
| knowledge_work schedule 中的 step.review.instructions | 主会话登记知识文稿步骤时 | 平台在本步提交文稿后另启独立会话，评审指定的知识文稿 |
| knowledge_work_result.review: {pass, feedback} | 当前核查/评审会话返回结果时 | 本次核查是否通过及具体依据；不会再启动一次评审 |

规划 current-plan 是过程文稿。主会话安排 readonly=true 的独立核查，省略 expected_document_ids 与 step.review；instructions 指向 current-plan、prompts/plan.md、prompts/plan-template.md 与调查结果索引。核查读取 read_plan 全部清单/排除分页、knowledge_diagram_check({work_document_id:"current-plan"}) 当前报告及真实入口，核对正文对应和全部适用产物。大范围可分仓或业务域核查。

下面是一对首次登记与子会话返回的示例。登记前规划已保存、相关调查已完成；有前序依赖时填实际步骤编号。已有核查步骤中断时按原编号 run，不为接续重新登记它。

主会话调用 knowledge_work：

```json
{
  "action": "schedule",
  "steps": [{
    "id": "review-plan",
    "title": "独立核查当前文档规划",
    "instructions": "按 prompts/verify-doc.md 的规划核查部分读取 current-plan、完整 read_plan 清单、当前过程稿图表报告及相关调查索引，回查业务入口与适用资料，判断覆盖是否完整。用 knowledge_work_result 返回 summary、document_ids=[]、work_document_ids=[current-plan] 和 review:{pass,feedback}；具体来源缺口放 data。这里只核查规划，不生成知识文稿。",
    "depends_on": [],
    "readonly": true
  }]
}
```

核查子会话调用 knowledge_work_result，反馈内容替换为实际发现：

```json
{
  "summary": "规划核查已完成；定时触发场景仍缺少对应文稿。",
  "document_ids": [],
  "work_document_ids": ["current-plan"],
  "review": {
    "pass": false,
    "feedback": "在实际入口及调查结果中发现的定时场景尚未对应到规划条目。请按所附原始位置补充场景与文稿清单，再核查受影响范围。"
  },
  "data": {"missing_scope": "实际遗漏范围及源码/资料位置"}
}
```

pass=false、图校验 invalid/unavailable 或来源缺口都是可以提交的核查结论，不需要生成知识文稿来提交，也不传 status=paused。没有问题时返回 pass=true 并说明实际核查范围。document_ids 保持空数组，过程稿仅放 work_document_ids；已有知识文稿的真正复核则走下一节的知识文稿步骤。

普通只读步骤的 done 只表示已提交结果，不等于结果的 review.pass=true。主会话读取各项结论并处理遗漏；规划实质修订后的新一轮核查使用新编号，中断或执行配置修正则接续原步骤。没有新证据或修订时不反复重建相同核查。仍有未调查范围或来源失败时不能宣布规划已穷尽。

## 每篇写作与评审

将规划中的每篇文档登记为带评审的步骤，说明具体范围和方法入口。示例：

```json
{
  "action": "schedule",
  "steps": [{
    "id": "write-import-domain-1",
    "title": "生成数据导入业务域文稿",
    "instructions": "本规划条目 import-domain：目标 domain，路径为该目标实际 docs_path 下的 domains/import.md（登记时替换为完整仓内路径），layer=domain，范围为本次 module_id 在 repo-api 与 repo-worker 的数据导入业务。按 prompts/generate-domain.md 和 templates/domain/domain.md 处理，读取 research-import-api、research-import-worker 的结果索引，重新打开两端真实入口、实现和配置，逐实际场景写作并保存完整候选。需要核对其他规划条目时再读 current-plan。",
    "depends_on": ["research-import-api", "research-import-worker"],
    "readonly": false,
    "expected_document_ids": ["import-domain"],
    "review": {
      "instructions": "按 prompts/verify-doc.md 对 templates/domain/domain.md 的专项规则评审。knowledge_draft read 文稿 import-domain，knowledge_diagram_check 读取当前完整图表报告，回读 sources 和本项调查索引指向的各仓源码及资料，逐场景核对真实调用、分支、状态、容量与清理策略，返回 review.pass 与具体 feedback。"
    }
  }]
}
```

示例中的业务、范围和路径由实际规划替换。instructions 带具体源码范围与待验证问题，不能只写“生成文档”或“核对质量”。依赖填确实需要先完成的步骤编号，编号与说明保存后不再改写。

对已经保存的知识文稿作只读复核，也可以登记 readonly=true、expected_document_ids=[实际知识文稿编号] 和 step.review.instructions。该步骤读取并返回已有文稿编号，由平台启动独立评审；反馈需要改稿时交回主会话安排可写步骤，保持当前只读权限。这与不产生知识文稿的规划核查不同，current-plan 不能填入 expected_document_ids。

登记完整清单后 knowledge_work 的 run 操作省略 id，本方法默认 concurrency=3，也可指定 1～4；填 id 则只运行该步骤。只有依赖满足且 expected_document_ids 写入集合不交叉的步骤才能并行，未声明写入范围的可写步骤串行执行。每篇候选保存后，宿主先做真实图表校验，再按 step.review.instructions 开只读会话；具体错误携带反馈修订，最多自动三轮。图校验 unavailable 保留候选、中断本项且不消耗修订次数，主会话继续其他独立工作后报告阻碍。

写作只修改 expected_document_ids 内的文稿。需要修改关联导航或发现新产物时交回主会话登记，不在本篇偷偷改写。需要读取其他步骤正在生成的文稿时等待其完成，并将对方写作步骤列入 depends_on；不能靠碰巧先执行来代替真实依赖。文档类型列表表示阅读层级，不要求把不相关文稿排成串行链。

最终导航同步单独登记带 review 的步骤，也可在相关文稿完成后直接首次生成最终导航，不要求先生成空初稿。repository-v1 与 module-v1 布局下，领域 docs_path 内的 README.md 与 index.md 等待本业务全部实际路由目标；领域入口引用各仓模块 README.md 时也等待这些目标。某仓实际文稿目录内的 README.md 与 module-map.md 等待本业务在该仓的功能/规范文稿。仓根公共 AGENTS.md 不属于导航步骤的写入范围。其他布局按当前保存的实际导航路径同步。depends_on 使用外部前序文稿的写作及最后修订步骤；已有导航初稿时还需等待初稿。

同一步同时写的导航文稿列入 expected_document_ids，不互相声明步骤依赖；相互引用的导航也不能排成循环，可合在一个明确写范围的同步步骤或由一次后续核查处理。只填导航的上次写作编号不足以保证路由目标完成。评审逐一回读全部改动导航及实际目标，核对路径、章节和覆盖。不同仓导航可并行；后续变化影响导航时再安排相关同步并复核。

写作者在 knowledge_draft save 后对每份候选调用 knowledge_diagram_check：参数 document_id，start 从 0 开始、limit 默认 10 且最多 20。读取 status、fingerprint、total、checked、diagrams，按 next_start 继续；各图 index 从 1 开始，line 定位正文，error 给实际诊断。invalid 修正后保存并重查当前版本；unavailable 记录依赖问题而不是删图或编造通过。按需读取 [PlantUML 指南](plantuml.md)，优先简单自包含写法，合法语法交给实际解析器判断；渲染器不访问文件或 URL 资源。

评审会话逐一 knowledge_draft read 全部 expected_document_ids，调用 knowledge_diagram_check 读取当前校验报告，并核对原始业务依据，再提交：

```json
{
  "summary": "已核对数据导入文稿，批量场景缺少错误传播说明",
  "document_ids": ["import-domain"],
  "review": {
    "pass": false,
    "feedback": "场景列表已列批量导入，但对应时序图缺少服务返回部分失败后上游的处理。回读批量实现和调用方，补充实际分支及引用后复核。"
  }
}
```

pass=true 时也简述实际检查范围及非阻塞未知；pass=false 时写具体位置、证据、影响与所需修订。工具调用成功、正文已保存、路径存在均不单独代表评审通过。候选随时保留，便于排查和恢复。

## 文稿与证据

knowledge_draft save 的 document 包含 id、title、target_id、path、layer、content、sources。领域层 layer=domain，仓级 layer=repository；sources 是字符串，不传对象或数组。content 是完整知识正文，sources 记录实际读取的仓编号、revision、文件/行范围、资料编号、章节和结论对应关系；执行过程留在工作记录。

正文按原模板保留必要的代码位置。提交 knowledge_source_check 时使用工具支持的 `仓编号:文件路径:起始行-末行` 或 `仓编号:文件路径#符号`，通过不代表结论正确。业务意图缺证据时明确未知，不把行业背景或代码推断写成历史决策。

修订保持稳定文稿编号。重读人工修改及已有建议，按平台反馈产生可比较的建议，不绕过采纳流程。仅记录可证实的排查经验。

## 恢复与完成

恢复时先用 knowledge_work read 取摘要，分页 list/read_plan，按步骤 id 读候选、结果与反馈，再按知识文稿 id 核对正文和版本；需要核对范围时读取 current-plan。done 的通过结果仅在对应正文未变化时复用，run 会重新核对版本。失败步骤在剩余预算内按原编号重试，实质新调查结论或工作说明改变时才创建新编号并记录替代关系。执行配置修正仍保留原步骤、依赖、调查和文稿；恢复不要求更换 Skill 版本或重做已完成工作。达到三轮上限且无新进展时保留阻碍，不靠换编号重复同一工作。discard 只适用于已有替代安排或确实超出本轮范围的步骤，不能用它消除未通过的必需文稿。

独立会话不能安排下一步或自行切换任务范围。调查返回明确未核实范围，规划核查用结果的 review.pass=false 表达缺口；写作保存已核实内容并在 summary/data 写出具体缺口，由独立评审判断能否通过。子会话正常结果省略 status，保存成功后结束；宿主报告当前步骤无法继续时保留错误与已有成果并结束本次回复，交回主会话，不反复提交被拒参数或补造文稿。主会话在 run 返回后先推进不依赖失败项的工作；只有实际来源/权限/模型服务问题或已用尽有效修订机会导致无法继续时，保存 paused 并说明条件。不会因固定篇数、普通反馈或文稿之间需要切换而主动暂停。

完成前核对全部清单行都有真实文稿、最新版本通过的独立评审、有效导航和完整场景。导航改动也用带 review 的步骤执行，expected_document_ids 覆盖每个改动文稿。阻塞条目保留为未完成，主会话保存 paused 并说明具体条件；中途不因达到固定文档数量暂停。

execution: reviewed-document-plan 只在 extract 要求登记完整 plan，并让全部必需文稿由带 expected_document_ids 与 review 的步骤生成且通过评审。文档类型、数量、模板、深度和范围由本包及用户要求决定；discuss/revise/update 保持本轮指定范围。
