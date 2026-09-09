import { createHash } from "node:crypto";
import { storyViewCoverage, type StoryViewCoverage } from "./storyViewCoverage.ts";

export const ARCHIFY_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type ArchifyType = typeof ARCHIFY_TYPES[number];
export const ARCHIFY_SOURCE_LIMIT = 256 * 1024;
export interface StoryDiagram {
  id: string; title: string; type: ArchifyType; line: number;
  source: Record<string, unknown>;
}
export interface StoryArchitecture {
  revision: string; diagrams: StoryDiagram[]; warnings: string[];
  views: StoryViewCoverage[];
}

/** 图源随 Story 一起检视、修订；正文任何变化都换版本，避免旧图背书新设计。 */
export function storyArchitecture(story: string): StoryArchitecture {
  const result: StoryArchitecture = {
    revision: createHash("sha256").update(story).digest("hex"), diagrams: [], warnings: [], views: storyViewCoverage(story),
  };
  const lines = story.split(/\r?\n/);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!fence) continue;
    const start = i;
    const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
    while (++i < lines.length && !close.test(lines[i])) { /* 跳过其他代码块中的示例。 */ }
    if (fence[2].trim().toLowerCase() !== "archify") continue;
    if (++count > 12) { result.warnings.push("最多展示 12 张图；其余内容请阅读 Story。"); break; }
    try {
      if (i === lines.length) throw new Error("代码块尚未闭合");
      const text = lines.slice(start + 1, i).join("\n");
      if (Buffer.byteLength(text) > ARCHIFY_SOURCE_LIMIT) throw new Error("单图超过 256 KB");
      const source = JSON.parse(text);
      if (!source || Array.isArray(source) || typeof source !== "object") throw new Error("图源必须是 JSON 对象");
      if (!ARCHIFY_TYPES.includes(source.diagram_type)) throw new Error("Archify 不支持此图类型，请阅读 Story 中的完整设计");
      assertOfflineDiagram(source);
      result.diagrams.push({ id: `diagram-${count}`, line: start + 1,
        title: typeof source.meta?.title === "string" ? source.meta.title : `图 ${count}`,
        type: source.diagram_type, source });
    } catch (error) {
      result.warnings.push(`Story 第 ${start + 1} 行：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** 此入口只读 Story JSON。拒绝上游的远程品牌捕获和仓库取证，不能由图源启动网络或 Git。 */
export function assertOfflineDiagram(source: Record<string, unknown>): void {
  const pending: unknown[] = [source];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "repository" || key === "sources" || key === "brand") {
        throw new Error("独立图展示不读取外部品牌或仓库证据，请将相关依据写入 Story 正文");
      }
      pending.push(child);
    }
  }
}

export const STORY_ARCHITECTURE_GUIDANCE = [
  "绘图是主任务分析的交付要求，不只是填写覆盖表：凡本需求涉及的视图，必须在 Story 对应章节画出能解释实际设计的图，并附必要说明；不能用一段文字、目录、状态表或空图代替设计图，也不能仅因没有画图就声称不涉及。",
  "按五个视角绘制：逻辑视图画功能结构及关键类/接口关系（类图）；开发视图画仓库、代码模块与依赖；进程视图画关键运行时序、协作及涉及的并发/异常；物理视图画部署节点、服务、存储及连接；场景视图画关键业务场景的参与者与交互，并关联对应设计和验收。只画与需求有关的关键内容，不要求穷举全部类或私有实现。",
  "4+1 是设计视角，不是五张图的数量指标。同一张图确实覆盖多个视角时可以复用，但在各视图中注明图的具体位置及其说明的设计问题；不可只拿一张模块拓扑宣称覆盖全部视图。",
  "4+1 必须逐项分析并知会用户：在 Story‘4+1 视图覆盖’表中保留逻辑视图、开发视图、进程视图、物理视图、场景视图（+1）五行，列为‘视图 | 状态 | 说明’。状态只用‘已完成 / 待补充 / 不涉及’。不涉及必须说明具体依据，不能静默删去；无法渲染不等于不涉及。",
  "沿用 Story 原章节，在对应内容前增加含视图名称的小标题，方便定位；已完成必须有实际设计支撑。逻辑视图要明确关键类图，有类图保留 PlantUML，无类图需单列‘类图 | 不涉及 | 具体原因’或‘类图 | 待补充 | 原因’，不能用模块拓扑代替。",
  "提交方案确认时，用简短提示集中知会哪些视图不涉及及原因、哪些待补充；责任人可提出异议并决定补充，不为此另建确认卡或 hook 门禁。不把已完成声明当作自动验收通过。",
  "架构可视化：完整 4+1、类图和设计说明仍在 Story 既有章节，PlantUML 保留公司评审兼容性。",
  "对于 Archify 支持且能够准确表达的设计图，在对应章节同时提供 ```archify 代码块，内容是 Archify 原生 JSON，供架构页直接展示；更新设计时同步更新该块，不另建图源文件。类图等不支持的类型保留 PlantUML，不能假冒成支持的类型。",
  "涉及却尚未画出设计图时标为待补充，说明缺口并在方案确认时知会用户；图源已有但不能渲染时分别说明设计状态和展示失败原因，不能伪称可展示或改称不涉及。责任人决定后续处理，不新增 hook 门禁。",
  "上述格式与渲染约定仅供生成时使用，不写入 Story 正文。图标题使用业务名称（如‘模块架构’、‘订单同步时序’），说明只解释职责、契约和交互；不要出现‘Archify 投影’、‘供平台独立展示’、‘与正文同步更新’等平台实现说明。",
  "只支持 diagram_type=architecture/workflow/sequence/dataflow/lifecycle。不要用拓扑冒充类图。图中模块、接口、场景和关系必须与正文一致。",
  "图源必含 schema_version、diagram_type、meta.title；中文设置 meta.locale=zh-CN。不得使用 brand、repository、sources 外部读取字段。",
  'architecture 最小示例：{"schema_version":1,"diagram_type":"architecture","meta":{"title":"模块依赖","locale":"zh-CN"},"components":[{"id":"module","type":"backend","label":"业务模块","pos":[40,40],"size":[160,64]}],"connections":[]}',
  "提交检视前用提供的固定离线渲染器逐图试渲染；JSON 合法不代表布局可展示。修复端点方向与标签遮挡后写回 Story，不关闭布局校验，不以示例图的成功替代当前设计验证。",
  "其他类型应先查阅提供的 Archify schema 与示例；无法可靠表达或渲染时如实说明，保留完整 Story，不阻断分析、编码或交付。",
].join("\n");
