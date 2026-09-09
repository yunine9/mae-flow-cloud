/** 4+1 的覆盖结论来自 Story 的显式声明，缺失不能推断为“不涉及”。 */
export const STORY_VIEWS = [
  { id: "logical", label: "逻辑视图", aliases: ["逻辑视图", "逻辑模型设计"] },
  { id: "development", label: "开发视图", aliases: ["开发视图", "仓库与模块组织"] },
  { id: "process", label: "进程视图", aliases: ["进程视图", "运行视图设计"] },
  { id: "physical", label: "物理视图", aliases: ["物理视图", "部署设计", "部署约定"] },
  { id: "scenarios", label: "场景视图（+1）", aliases: ["场景视图", "场景设计"] },
] as const;
export type StoryViewId = typeof STORY_VIEWS[number]["id"];
export interface StoryViewCoverage {
  id: StoryViewId; label: string;
  status: "已完成" | "待补充" | "不涉及";
  reason: string; line?: number; endLine?: number;
  classDiagram?: { line?: number; reason: string };
}

export function storyViewCoverage(story: string): StoryViewCoverage[] {
  const lines = story.split(/\r\n|[\n\r\u2028\u2029]/);
  const prose = [...lines];
  const classes: number[] = [];
  let fence: { marker: string; language: string; start: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      prose[i] = "";
      if (match && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) {
        if (fence.language === "plantuml" && /^\s*(?:abstract\s+)?(?:class|interface|enum)\s+\S/m.test(lines.slice(fence.start + 1, i).join("\n"))) classes.push(fence.start + 1);
        fence = undefined;
      }
    } else if (match) {
      fence = { marker: match[1], language: match[2].trim().toLowerCase(), start: i }; prose[i] = "";
    }
  }
  const headings = prose.flatMap((line, index) => {
    const match = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return match ? [{ line: index + 1, level: match[1].length, title: match[2] }] : [];
  });
  const cells = prose.map((line) => line.trim().startsWith("|")
    ? line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim().replace(/[`*]/g, "")) : []);
  return STORY_VIEWS.map((view) => {
    const declarations = cells.filter((row) => row[0] === view.label || row[0] === view.aliases[0]);
    const declared = declarations.length === 1 ? declarations[0] : undefined;
    const explicit = headings.filter((heading) => heading.title.includes(view.aliases[0]));
    const candidates = explicit.length ? explicit : headings.filter((heading) => view.aliases.some((alias) => heading.title.includes(alias)));
    const heading = candidates.length === 1 ? candidates[0] : undefined;
    const endLine = heading ? (headings.find((item) => item.line > heading.line && item.level <= heading.level)?.line ?? lines.length + 1) - 1 : undefined;
    const hasDesign = heading && lines.slice(heading.line, endLine).some((line) => line.trim() && !/^\s*<!--|^\s*待补充\s*$/.test(line));
    const reason = declared?.[2]?.trim();
    let status: StoryViewCoverage["status"] = "待补充";
    let detail = heading ? "已有相关设计，尚未明确覆盖结论，请在 Story 中核对。" : "尚未定位到独立设计段落，请核对并补充覆盖说明。";
    if (declarations.length > 1) detail = "覆盖结论重复，请在 Story 中核对。";
    else if (declared?.[1] === "不涉及") {
      if (reason && !/^(待补充|无|暂无|—|-)$/.test(reason)) { status = "不涉及"; detail = reason; }
      else detail = "声明不涉及，但尚未说明原因。";
    } else if (declared?.[1] === "已完成" && hasDesign) {
      status = "已完成"; detail = reason || "设计已记录在 Story。";
    } else if (declared) detail = reason || "覆盖声明或对应设计尚未补全。";
    const classLine = classes.find((line) => heading && line > heading.line && line <= endLine!);
    const classDeclarations = cells.filter((row) => row[0] === "类图");
    const classDeclaration = classDeclarations.length === 1 ? classDeclarations[0] : undefined;
    const classReason = classDeclaration?.[1] === "不涉及" && classDeclaration[2]
      && !/^(待补充|无|暂无|—|-)$/.test(classDeclaration[2]) ? `类图不涉及：${classDeclaration[2]}` : undefined;
    if (view.id === "logical" && status === "已完成" && !classLine && !classReason) {
      status = "待补充"; detail = "逻辑设计已有正文，类图仍需补充或说明不涉及的原因。";
    }
    return { id: view.id, label: view.label, status, reason: detail, line: heading?.line, endLine,
      ...(view.id === "logical" ? { classDiagram: { line: classLine,
        reason: classLine ? "类图已在 Story 中，可打开查看。" : classReason ?? "尚未识别到类图，请补充或在 Story 中说明不涉及的原因。" } } : {}) };
  });
}
