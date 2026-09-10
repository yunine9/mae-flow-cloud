import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIFY_ROOT } from "./archifyRender.ts";

/** 提供固定版本的参考和离线渲染器，让 Agent 能验证布局，而不只检查 JSON 格式。 */
export function materializeArchifyReferences(directory: string): string {
  try {
    mkdirSync(directory, { recursive: true });
    for (const name of ["schemas", "examples", "renderers", "assets", "LICENSE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.json"]) {
      cpSync(join(ARCHIFY_ROOT, name), join(directory, name), { recursive: true });
    }
    const instructions = [
      "# Archify 离线参考与预览",
      "先读取 schemas/ 和 examples/ 中的对应类型，勿照抄示例业务。",
      "平台架构图必须写入独立的 architecture.json，禁止把 Archify JSON 塞进 Story。",
      "提交前将 architecture.json 中每个 source 提取为临时 JSON，使用这里的固定渲染器逐图试渲染：",
      "node <本目录>/renderers/<diagram_type>/render-<diagram_type>.mjs <临时JSON> <临时HTML>",
      "渲染器不需要安装依赖。图源禁用 brand、repository、sources 外部读取字段。",
      "JSON 合法不表示图可展示。按诊断修复连线端点、标签遮挡等问题，再试渲染；不要关闭布局校验。",
      "Story 是设计正本，architecture.json 是平台内部派生产物；设计变化时同步重新生成，临时 JSON/HTML 仅作验证。",
      "如实报告验证结果。无法运行或修复时告知用户具体缺口，不新增流程门禁。",
    ].join("\n");
    writeFileSync(join(directory, "README.md"), instructions);
    return `Archify 离线资料与渲染器：${directory}/README.md；先查对应 schema 和示例，提交前按说明实际试渲染每张图，修复布局错误。无法验证时如实说明。`;
  } catch {
    return "Archify 参考资料暂时不可用。无法可靠表达的图保留 PlantUML 和文字，不编造受支持语法。";
  }
}
