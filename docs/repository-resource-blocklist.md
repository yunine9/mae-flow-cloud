# 屏蔽仓库 Skill 与指令文件

管理员进入「平台设置 → 团队执行约定 → 屏蔽仓库 Skill 与指令文件」，每行填写一条规则。例如：

```text
.cac
AGENTS.md
AGENTS.override.md
.agents/skills/department-workflow
```

规则是文件名或仓库相对路径，不支持通配符。目录匹配其全部子项；按完整路径段匹配，不区分大小写，兼容 Windows 分隔符。`.cac` 不会匹配 `.cac-other`。`AGENTS.md` 匹配各仓以及子目录中的同名文件；需要屏蔽 `AGENTS.override.md` 或 `CLAUDE.md` 时分别添加。

保存后适用于需求流和问题流，包括恢复会话与子 Agent。运行中的会话须重启才能刷新已加载的系统上下文；历史对话不会被删除。清空列表恢复默认装载行为。默认列表为空，不擅自屏蔽任何仓库文件。

平台过滤技能发现目录、仓库技能快照装配、系统提示词中的仓库契约以及问题流历史必读列表，并在系统指令中说明命中的内容不能作为执行指令。仓库文件保留，Git 不产生删除变更。此功能是指令资源装载策略，不是文件系统访问隔离；Bash、搜索仍可能读到文件内容。

配置复用管理员 API：`PUT /api/settings/execution-policy`，字段 `blocked_repository_resources` 为字符串数组。省略字段保留当前规则，空数组清空。配置保存在平台数据目录的 `settings.json`，不写入业务仓。
