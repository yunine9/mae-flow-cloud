# CC 并行任务：工作流资产库与纯前端壳

主线负责工作流编译器、内核、任务快照和现有页面接入。CC 不得在主线核心
文件上并行修改。共享契约以 `src/workflowDefinition.ts` 为唯一事实来源。

## 第一批：工作流资产库

只新增：

- `src/workflowAssetLibrary.ts`
- `tests/workflowAssetLibrary.test.ts`

允许按需新增仅由资产库使用的测试 fixture；不要另建一套工作流类型。

实现文件存储型工作流资产库：

- 个人、团队两种 scope。
- Owner、maintainers；团队发布/归档/设置默认的最终权限留给 route 层，
  library 导出 `canView/canEdit/canPublish` 判断。
- 创建、列表、详情、保存草稿。
- 草稿 `expected_revision` 乐观锁；旧 revision 必须给出可识别冲突错误。
- 从平台、已发布工作流或任务来源复制；副本深拷贝，保留 `copied_from`，
  绝不共享编辑。
- 草稿、待审核、已发布、已归档生命周期；支持提交、撤回、通过、驳回。
- 已发布 `vN.json` 永不可覆盖；修改必须创建新草稿和版本。
- 归档只禁止新任务选择，不删除任何历史版本。
- `tmp + rename` 原子写、ID/路径/软链接防护、JSONL 操作留痕。
- 损坏记录读侧跳过并返回 warning，写侧 fail-closed。
- 所有 definition 必须调用 `normalizeWorkflowDefinition`，digest 必须调用
  `workflowDigest`。

建议目录：

```text
<dataDir>/workflow-assets/
├── operations.jsonl
└── <asset-id>/
    ├── asset.json
    ├── draft.json
    └── versions/v1.json
```

第一批不要修改：

- `src/server.ts`
- `src/taskService.ts`
- `src/executionProfile.ts`
- `src/executionPlan.ts`
- `src/workflowDefinition.ts`
- `kernel/**`
- `web/**`

完成后提交独立 commit，附目标测试命令。不要直接 push `main`，把 commit SHA
交给主线审计合入。

## 第二批：独立前端组件

等主线冻结 `web/src/api.ts` 类型和 fixtures 后再开始。只新增
`web/src/workflows/**` 与独立 `web/src/workflows/workflow.css`：

- 工作流列表与状态、来源、版本、适用范围。
- 最终方案、与标准方案差异、依赖资产三个只读视图。
- 桌面三栏阶段编排器：阶段导航、唯一最终方案、资产目录/详情。
- 方案选择器与“复制后编辑”。
- 组件通过 props/callbacks 工作，不直接发请求。

不要修改 `App.tsx`、`LaunchWorkspace.tsx`、`SettingsView.tsx`、`api.ts` 或现有
`style.css`；主线统一集成，避免两边同时碰大文件。
