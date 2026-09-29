import { recordComponentObservations, applyComponentExemptions } from "./componentKnowledgePolicy.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, relative, resolve } from "node:path";
import type { KnowledgeContext } from "./knowledgeSearch.ts";
import { componentKnowledgeCatalog, componentSelectionTable, type ComponentKnowledgeCatalog } from "./componentKnowledgeCatalog.ts";
import { checkComponentKnowledge, componentCheckMessage, type ComponentKnowledgeCheckReport } from "./componentKnowledgeCheck.ts";

/** 选型和代码观察均现读正式知识，不将研究草稿或过期规则快照用于开发。 */
export class ComponentKnowledgeConsumption {
  private lastNote = "";
  constructor(private options: {
    dataDir: string; cwd: string; context: () => KnowledgeContext; languages: () => string[]; baseline: () => string;
    onReport?: (report: ComponentKnowledgeCheckReport) => void;
  }) {}
  catalog(): ComponentKnowledgeCatalog {
    try { return componentKnowledgeCatalog(this.options.dataDir, this.options.context(), this.options.languages()); }
    catch (error) { return { paradigms: [], rules: [], digest: "unavailable", warnings: [`组件正式知识读取未完成：${String(error)}`] }; }
  }
  guidance() { return componentSelectionTable(this.catalog()); }
  async check(input: { target?: string; paths?: string[]; trigger: ComponentKnowledgeCheckReport["trigger"] }) {
    const report = await checkComponentKnowledge({ cwd: this.options.cwd, baseline: this.options.baseline(), catalog: this.catalog(), ...input });
    try { const repository = this.options.context().repositories[0] ?? this.options.context().repo;
      applyComponentExemptions(this.options.dataDir, repository, report);
      recordComponentObservations(this.options.dataDir, repository, report); } catch { /* 观察记录失败不阻塞开发。 */ }
    try { this.options.onReport?.(report); } catch { /* 消费记录不可改变代码或交付结果。 */ }
    return report;
  }
  async afterTool(name: string, input: Record<string, unknown>) {
    if (!["Write", "Edit", "Bash"].includes(name)) return;
    const path = name !== "Bash" ? relative(this.options.cwd, resolve(this.options.cwd, String(input.file_path ?? input.path ?? ""))).replaceAll("\\", "/") : undefined;
    if (path !== undefined && (isAbsolute(path) || path.startsWith("../") || !/\.(?:c|cpp|cc|cxx|h|hpp|hh|hxx|java)$/i.test(path))) return;
    const report = await this.check({ trigger: "edit", ...(path === undefined ? {} : { paths: [path] }) });
    if (report.status === "not_applicable") return;
    const note = componentCheckMessage(report);
    if (note === this.lastNote) return;
    this.lastNote = note;
    // 无命中时保留检查记录；无需在每次写文件后用成功提示占用上下文。
    return report.findings.some(f => f.level === "warning" && !f.exempt_reason) ? note : undefined;
  }
  tool() {
    const service = this;
    const reply = (text: string, details: object) => ({ content: [{ type: "text" as const, text }], details });
    return defineTool({ name: "component_knowledge", label: "组件选型与使用检查",
      description: "list 读取当前适用的已采纳组件选择表，按 query 过滤、start 分页；正文用 knowledge read。check 检查相对目标分支新增的代码，仅返回观察提示。草稿不在消费范围，失败不冒充通过。",
      parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("check")]), query: Type.Optional(Type.String({ maxLength: 2000 })),
        start: Type.Optional(Type.Integer({ minimum: 0 })), paths: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })) }),
      execute: async (_id: string, input: { action: "list" | "check"; query?: string; start?: number; paths?: string[] }) => {
        if (input.action === "check") {
          const report = await service.check({ trigger: "manual", paths: input.paths });
          const visible = { ...report, findings: report.findings.filter(f => f.level === "warning" && !f.exempt_reason) };
          return reply(componentCheckMessage(visible) + "\n" + JSON.stringify(visible), visible);
        }
        const catalog = service.catalog(), query = input.query?.trim().toLocaleLowerCase();
        const entries = catalog.paradigms.filter(p => p.policy.level === "warning").filter(p => !query || `${p.need} ${p.component} ${p.api.join(" ")} ${p.applicability}`.toLocaleLowerCase().includes(query));
        const start = input.start ?? 0, selected = entries.slice(start, start + 30);
        const result = { paradigms: selected, digest: catalog.digest, warnings: catalog.warnings, total: entries.length,
          ...(start + selected.length < entries.length ? { next_start: start + selected.length } : {}) };
        return reply(JSON.stringify(result), result);
      },
    });
  }
}
