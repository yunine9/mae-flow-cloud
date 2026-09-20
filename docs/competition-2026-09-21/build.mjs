import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const output = path.dirname(fileURLToPath(import.meta.url));
const { RUNTIME_NODE_MODULES, RUNTIME_PYTHON, SKILL_DIR, BUILD_DIR } = process.env;
for (const value of [RUNTIME_NODE_MODULES, RUNTIME_PYTHON, SKILL_DIR, BUILD_DIR]) {
  if (!value || !path.isAbsolute(value)) throw new Error('Supply absolute runtime, skill and build paths.');
}
const { Presentation, PresentationFile, FileBlob } = await import(pathToFileURL(
  path.join(RUNTIME_NODE_MODULES, '@oai/artifact-tool/dist/artifact_tool.mjs')).href);
const { finalizePresentation } = await import(pathToFileURL(
  path.join(SKILL_DIR, 'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(BUILD_DIR, { recursive: true });
await fs.mkdir(path.join(output, 'slides'), { recursive: true });
const deck = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C = { ink: '#142A43', muted: '#5D6E82', blue: '#3057D5', teal: '#047A82', pale: '#EDF2FF', line: '#B8C5D8', white: '#FFFFFF' };
const font = 'Arial Unicode MS';
function text(s, value, x, y, w, h, size = 28, color = C.ink, bold = false, align = 'left') {
  const shape = s.shapes.add({ geometry: 'textbox', position: { left: x, top: y, width: w, height: h }, fill: 'none', line: { fill: 'none', width: 0 } });
  shape.text = value;
  shape.text.style = { typeface: font, fontSize: size, bold, color, alignment: align, verticalAlignment: 'middle', autoFit: 'none', insets: { left: 0, right: 0, top: 0, bottom: 0 } };
  return shape;
}
function box(s, x, y, w, h, label, sub, fill = C.pale, color = C.ink) {
  const sh = s.shapes.add({ geometry: 'rect', position: { left: x, top: y, width: w, height: h }, fill, line: { fill: C.line, width: 1 } });
  text(s, label, x + 18, y + 12, w - 36, 46, 29, color, true, 'center');
  if (sub) text(s, sub, x + 18, y + 64, w - 36, h - 72, 23, color, false, 'center');
  return sh;
}
function link(s, a, b, from = 'right', to = 'left', both = false) {
  return s.shapes.connect(a, b, { kind: 'elbow', fromSide: from, toSide: to,
    line: { fill: C.muted, width: 2 }, tail: { type: 'arrow' }, ...(both ? { head: { type: 'arrow' } } : {}) });
}
function slide(title, num, notes) {
  const s = deck.slides.add(); s.background.fill = C.white;
  if (title) text(s, title, 72, 45, 1136, 70, 43, C.ink, true);
  text(s, 'MAE Flow', 72, 674, 230, 25, 18, C.muted);
  text(s, String(num).padStart(2, '0'), 1148, 674, 60, 25, 18, C.muted, false, 'right');
  s.speakerNotes.textFrame.setText(notes);
  return s;
}

{
  const s = slide('', 1, '35 秒。讲参赛范围：只讲 MAE Flow 的核心 Harness，Cloud 作为落地演示。Harness 指围绕 Agent 的工作方法、工具执行、状态与人工控制。不要把全部 Cloud 能力都称为插件自带。完整讲稿见同目录 talk.md。');
  text(s, '万马奔腾 · 工程工具', 76, 88, 1050, 45, 24, C.blue);
  text(s, 'MAE Flow', 72, 204, 1136, 104, 82, C.ink, true);
  text(s, '面向需求交付的 Agent Harness', 76, 332, 1110, 76, 43, C.ink);
  text(s, '用可靠、易改、够快的代码，打造真正好用的工程工具', 76, 447, 1130, 65, 28, C.muted);
  text(s, '可靠性          可维护性          高效          安全', 76, 560, 1100, 55, 29, C.blue, true);
}
{
  const s = slide('核心 Harness 架构', 2, '75 秒。职责示意图，不是进程部署图。Agent 分析与执行，Prompt/Skill 承载工作方法，宿主与内核协调状态、操作和人的决定。Cloud 承接团队交互和平台集成。来源：kernel/docs/kernel-authority.md；src/sessionDriver.ts；src/taskHostTools.ts；src/platformAdapter.ts；docs/execution-continuity.md。');
  const human = box(s, 420, 148, 440, 84, '人：目标、检视与交付决定', '', '#EAF5F3');
  const method = box(s, 72, 306, 285, 150, '工作方法', 'Prompt / Skill\n分析、编码、验证约定');
  const agent = box(s, 495, 306, 290, 150, 'Agent', '理解需求\n分析、实现与修复', C.ink, C.white);
  const host = box(s, 920, 306, 288, 150, '宿主与内核', '执行协调与状态恢复\n记录人工决定');
  const facts = box(s, 495, 535, 713, 94, 'Git、编译测试、MR 与流水线', '', '#EAF5F3');
  link(s, human, agent, 'bottom', 'top', true);
  link(s, method, agent);
  link(s, agent, host, 'right', 'left', true);
  link(s, host, facts, 'bottom', 'right', true);
  link(s, facts, agent, 'top', 'bottom', true);
  text(s, 'Cloud 提供团队工作台\n与宿主集成', 76, 540, 310, 78, 24, C.muted);
}
{
  const s = slide('可靠与安全：真实结果，明确决定', 3, '90 秒。程序读取事实，模型不能凭一句完成替代实际结果。可定位 CI/代码质量失败属于自动修复候选，仍受状态、证据和配置约束。MR 检视意见交责任人，选中后才交 Agent。权限、人的回答、取消与接管保留。来源：src/mergeWatch.ts；src/externalReviewInbox.ts；src/annotationSubmissionView.ts；kernel/docs/kernel-authority.md。不承诺绝对隔离或所有失败都能自动修好。');
  text(s, '同样是反馈，处理权不同', 74, 132, 1120, 55, 28, C.muted);
  const result = box(s, 72, 300, 305, 153, '平台与工具结果', '执行记录、真实状态\n保存后可追溯', C.ink, C.white);
  const ci = box(s, 503, 225, 294, 112, 'CI / 扫描失败', '可定位、可修复的问题');
  const fix = box(s, 919, 225, 289, 112, 'Agent 修复', '执行后重新验证');
  const review = box(s, 503, 427, 294, 112, 'MR 检视意见', '涉及取舍与质量判断', '#EAF5F3');
  const owner = box(s, 919, 427, 289, 112, '责任人决定', '选中的意见交给 Agent', '#EAF5F3');
  link(s, result, ci); link(s, ci, fix);
  link(s, result, review); link(s, review, owner);
  text(s, '权限、人的回答、取消与接管，由实际执行链保留', 74, 596, 1130, 50, 29, C.teal, true);
}
{
  const s = slide('易改与够快：规则各有归属', 4, '80 秒。方法更新在 Prompt/Skill，平台差异在适配器，状态及权限事实在宿主/内核。当前仍有大模块和历史耦合，不宣称全面解耦。例子：同样内容 add/commit 不重复作废人工确认，形式检查不替代质量判断。并行需职责与依赖明确，避免多个写入者抢同一工作区。来源：AGENTS.md；kernel/docs/kernel-authority.md；src/platformAdapter.ts。');
  const rows = [
    ['变化发生在哪里', '修改落点', '维护范围'],
    ['工作方法变了', 'Prompt / Skill', '更新方法与示例'],
    ['平台接口变了', '平台适配器', '收敛命令与返回差异'],
    ['执行控制变了', '宿主 / 内核', '核对状态、决定与事实'],
  ];
  const table = s.tables.add({ rows: 4, columns: 3, left: 74, top: 158,
    width: 1134, height: 365, columnWidths: [412, 384, 338], values: rows });
  table.borders.assign({ fill: C.white, width: 0 });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    const cell = table.getCell(r, c); cell.fill = C.white;
    cell.text.style = { typeface: font, fontSize: r === 0 ? 24 : c === 2 ? 26 : 29,
      bold: r > 0 && c !== 2, color: r === 0 || c === 2 ? C.muted : c === 1 ? C.blue : C.ink,
      verticalAlignment: 'middle', alignment: 'left', autoFit: 'none' };
  }
  text(s, '重复确认与形式检查，会消耗真正交付的时间', 74, 563, 1134, 56, 32, C.teal, true);
}
{
  const s = slide('一个已完成需求的交付过程', 5, '20 秒后切浏览器，演示 4 分钟。选同一个已合入需求：业务目标35秒，设计45秒，人的意见及实际修改65秒，测试/MR结果65秒，交付摘要30秒（如不存在，停在MR结果页）。任务尚未指定，不填造数据。现场只读，不运行长命令或重新触发推送。');
  text(s, '在 MAE Flow Cloud 中看一次真实落地', 74, 141, 1120, 57, 29, C.muted);
  const steps = [
    ['01', '需求与设计', '要解决什么问题'],
    ['02', '人的介入', '意见怎样进入执行'],
    ['03', '实际改动', '具体修改了什么'],
    ['04', '交付证据', '测试结果与 MR 合入'],
  ];
  steps.forEach(([n, t, d], i) => {
    const x = 74 + i * 294;
    text(s, n, x, 304, 220, 70, 53, C.blue, true);
    text(s, t, x, 404, 270, 62, 34, C.ink, true);
    text(s, d, x, 482, 276, 60, 24, C.muted);
  });
}
{
  const s = slide('MAE Flow 的核心取舍', 6, '最后 1 分钟。回到四个评选导向：可靠是结果有依据；易改是规则有归属；够快是减少无意义等待；安全是保留人的决定和真实权限。Cloud 是落地现场，不展开全平台。不要以规模或提交数量比较其他作品。完整答辩口径见 talk.md。');
  text(s, '人决定目标与取舍', 74, 179, 1120, 78, 45, C.ink, true);
  text(s, 'Agent 承担分析与执行', 74, 281, 1120, 78, 45, C.blue, true);
  text(s, '工具提供真实结果依据', 74, 383, 1120, 78, 45, C.teal, true);
  text(s, '流程要带来质量收益，也要让交付更快', 74, 549, 1120, 70, 32, C.muted);
}

const candidatePath = path.join(BUILD_DIR, 'candidate.pptx');
await (await PresentationFile.exportPptx(deck)).save(candidatePath);
const finalPath = path.join(output, process.env.DECK_NAME ?? 'MAE-Flow-Harness.pptx');
await finalizePresentation({ workspaceDir: path.resolve(output, '../..'), candidatePath, finalPath,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR, 'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(SKILL_DIR, 'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-heading-fit', '--require-native-table-slide', '4'],
  explicitTotalSlideCount: 6,
  requiredNativeTableOwnerSlides: [4],
  fontPolicy: { basis: 'design', families: [font] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(BUILD_DIR, `${path.basename(finalPath)}.validation.json`),
});
// Render the exported final file so previews match the delivered deck.
const checked = await PresentationFile.importPptx(await FileBlob.load(finalPath));
for (let i = 0; i < checked.slides.items.length; i++) {
  const png = await checked.export({ slide: checked.slides.items[i], format: 'png', scale: 1.5 });
  const data = new Uint8Array(await png.arrayBuffer());
  await fs.writeFile(path.join(output, 'slides', `${String(i + 1).padStart(2, '0')}.png`), data);
  if (i === 1) await fs.writeFile(path.join(output, '02-harness.png'), data);
  if (i === 2) await fs.writeFile(path.join(output, '03-control.png'), data);
}
console.log(finalPath);
