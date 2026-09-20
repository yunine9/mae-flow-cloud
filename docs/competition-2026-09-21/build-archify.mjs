import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const revision = execFileSync('git', ['rev-parse', 'b0c012e0'], { cwd: root, encoding: 'utf8' }).trim();
const source = (file, line, end_line, label) => ({ path: file, line, end_line, label });
const core = 'kernel/scripts/mae_flow_core/';
const node = (id, type, label, sublabel, x, y, sources = [], width = 180, height = 68) => ({
  id, type, label, sublabel, pos: [x, y], size: [width, height], ...(sources.length ? { sources } : {}),
});
const edge = (id, from, to, label, extra = {}) => ({ id, from, to, ...(label ? { label } : {}), ...extra });
const diagram = {
  schema_version: 1, diagram_type: 'architecture',
  meta: {
    title: 'MAE Flow 核心架构',
    subtitle: '方法进入上下文，工具返回事实，人的决定进入后续执行',
    locale: 'zh-CN', visual_preset: 'blueprint', animation: 'none',
    quality_profile: 'standard', viewBox: [1080, 630],
    repository: { url: 'https://github.com/yunine9/mae-flow-cloud', revision, provider: 'github' },
    views: [
      { id: 'core-loop', label: '核心执行循环', focus: ['methods', 'current', 'agent', 'done', 'advance', 'state'], note: 'current 给出本步指令，Agent 执行，done 处理结果，程序推进并保存状态。' },
      { id: 'safety', label: '工具与安全', focus: ['agent', 'host', 'tools', 'safety', 'platform'], note: '工具执行前检查必要边界；Git、MR 和流水线状态来自真实外部结果。' },
      { id: 'feedback', label: '人与交付反馈', focus: ['owner', 'ui', 'feedback', 'agent', 'platform'], note: '客观失败具备条件时自动修复；MR 检视意见先由责任人选择，再交给 Agent。' },
    ],
    legend: { mode: 'auto', entries: {
      external: { label: '人、方法与外部资源' }, frontend: { label: '人工交互' }, backend: { label: '内核逻辑' },
      cloud: { label: 'Agent 与宿主执行' }, database: { label: '持久状态' }, security: { label: '必要安全边界' },
    } },
  },
  components: [
    node('owner', 'external', '需求责任人 / 检视人', '目标、意见与交付取舍', 40, 62, [], 180, 60),
    node('ui', 'frontend', 'Cloud 工作台', '澄清、检视、暂停与接管', 545, 62, [source('src/annotationSubmissionView.ts', 1, 38, '批注提交条件')], 180, 60),
    node('feedback', 'cloud', '反馈分类与处理', 'CI 修复 / 意见交人选择', 810, 62, [source('src/mergeWatch.ts', 30, 50, '自动修复与人工处理')], 200, 60),
    node('methods', 'external', 'Skill 与步骤指令', '明确当前工作方法', 40, 195, [source('kernel/skills/mae-flow/SKILL.md', 16, 28, '主执行循环'), source('kernel/flow/steps/build.md', 7, 15, '用户意图与实施')]),
    node('templates', 'external', '角色与产物模板', 'Story / UT / 实施附录', 40, 330, [source('kernel/agents/ut-generator-agent.md', 24, 40, 'UT 原则与结果'), source('kernel/skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md', 13, 25, '任务拆分原则')]),
    node('knowledge', 'external', '知识与仓库约定', '按需补充 Agent 上下文', 40, 465, [source('src/sessionDriver.ts', 1238, 1261, '上下文接入')]),
    node('current', 'backend', 'current · 当前指令', '按状态与配置组装 Markdown', 290, 195, [source(core + 'cli_commands/current.py', 148, 193, '步骤提示词组装')]),
    node('agent', 'cloud', 'Agent 执行', '理解、分析、实现与验证', 545, 195, [source('src/sessionDriver.ts', 1254, 1275, 'Pi 工具钩子接入')]),
    node('advance', 'backend', '流程推进', '选择下一步，追加历史', 290, 330, [source(core + 'cli_commands/advancement.py', 123, 159, '推进与保存'), source('kernel/flow/flow.json', 61, 80, '步骤分支定义')]),
    node('done', 'backend', 'done · 处理结果', '人工决定与事实核对', 545, 330, [source(core + 'cli_commands/done_status.py', 88, 111, '建议与必要检查分开')]),
    node('state', 'database', '状态持久化', '流程位置、选择与历史', 290, 465, [source(core + 'state_store.py', 224, 257, '锁、版本与原子写入')]),
    node('safety', 'security', '工具安全判断', '保护状态，限制危险操作', 545, 465, [source(core + 'guard/bash.py', 135, 148, '强推边界'), source(core + 'guard/gate.py', 51, 68, '状态文件保护')]),
    node('host', 'cloud', '会话与内核接入', 'SessionDriver / KernelHost', 810, 195, [source('src/kernelHost.ts', 1, 14, '事件桥接与串行调用')], 200),
    node('tools', 'cloud', '工具与平台适配', '文件 / Bash / Git / MR', 810, 330, [source('src/taskHostTools.ts', 1, 28, '宿主操作'), source('src/platformAdapter.ts', 1, 28, '平台适配')], 200),
    node('platform', 'external', 'CodeHub / CI', '实际版本、测试与失败日志', 810, 465, [], 200),
  ],
  boundaries: [
    { kind: 'region', label: '方法与上下文', wraps: ['methods', 'templates', 'knowledge'], pad: 22 },
    { kind: 'region', label: '核心执行循环：Agent 与 MAE Flow 内核', wraps: ['current', 'agent', 'advance', 'done', 'state', 'safety'], pad: 22 },
    { kind: 'region', label: 'Cloud 宿主与外部系统', wraps: ['host', 'tools', 'platform'], pad: 22 },
  ],
  connections: [
    edge('human-input', 'owner', 'ui', '目标与决定', { variant: 'emphasis' }),
    edge('user-steering', 'ui', 'agent', '', { fromSide: 'bottom', toSide: 'top', variant: 'emphasis' }),
    edge('method-injection', 'methods', 'current', '', { variant: 'emphasis' }),
    edge('template-use', 'templates', 'methods', '提供模板', { fromSide: 'top', toSide: 'bottom', variant: 'dashed' }),
    edge('current-instruction', 'current', 'agent', '本步指令', { variant: 'emphasis' }),
    edge('agent-done', 'agent', 'done', '声明完成', { fromSide: 'bottom', toSide: 'top', variant: 'emphasis', labelAt: [635, 300] }),
    edge('done-advance', 'done', 'advance', '处理结果', { fromSide: 'left', toSide: 'right', variant: 'emphasis' }),
    edge('next-current', 'advance', 'current', '下一步', { fromSide: 'top', toSide: 'bottom', variant: 'emphasis' }),
    edge('persist', 'advance', 'state', '保存状态', { fromSide: 'bottom', toSide: 'top', labelAt: [380, 435] }),
    edge('agent-host', 'agent', 'host', '工具请求'),
    edge('host-tools', 'host', 'tools', '执行', { fromSide: 'bottom', toSide: 'top', labelAt: [910, 300] }),
    edge('tool-results', 'tools', 'done', '事实依据', { fromSide: 'left', toSide: 'right' }),
    edge('tool-guard', 'safety', 'tools', '', { fromSide: 'right', toSide: 'left', variant: 'security' }),
    edge('platform-actions', 'tools', 'platform', '推送与查询', { fromSide: 'bottom', toSide: 'top', labelAt: [910, 435] }),
    edge('delivery-feedback', 'platform', 'feedback', '交付反馈', { fromSide: 'right', toSide: 'right', via: [[1048, 499], [1048, 92]], labelAt: [1048, 155] }),
    edge('review-choice', 'feedback', 'ui', '意见通知', { fromSide: 'left', toSide: 'right' }),
  ],
};
const input = path.join(dir, 'mae-flow.architecture.json');
const output = path.join(dir, 'mae-flow-architecture.html');
fs.writeFileSync(input, JSON.stringify(diagram, null, 2) + '\n');
execFileSync(process.execPath, [path.join(root, 'vendor/archify/renderers/architecture/render-architecture.mjs'), input, output], {
  cwd: root, env: { ...process.env, ARCHIFY_REPO_ROOT: root, ARCHIFY_UPDATE_CHECK_DISABLED: '1' }, stdio: 'inherit',
});
