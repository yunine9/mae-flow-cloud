import { scanForSecrets } from "./hostSkillLibrary.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export function executeFile(
  file: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 30000,
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, EC_DEBUG: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) =>
        error
          ? reject(
              Object.assign(
                new Error(
                  error.name === "AbortError" ? "操作已取消"
                    : error.code === "ENOENT" ? `${file === "git" ? "Git" : "ec"} 工具未安装或路径错误`
                    : error.code === "EACCES" ? "当前服务账户无权执行工具"
                    : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "返回内容过大，请缩小搜索或读取范围"
                    : error.killed ? "操作超时，请缩小范围后重试"
                    : file === "git" ? "本地源码操作失败，请检查仓库、版本和路径" : "ec 调用失败，请检查工具配置、凭据和网络",
                ),
                { code: error.code },
              ),
            )
          : resolve(stdout),
    ),
  );
}
export const ecBinary = () =>
  process.env.MAE_FLOW_EC_BIN ||
  (existsSync(join(homedir(), ".local/bin/ec"))
    ? join(homedir(), ".local/bin/ec")
    : "ec");
export async function checkEc(signal?: AbortSignal) {
  await executeFile(ecBinary(), ["tools"], undefined, signal);
}
export function evidencePreview(text: string) {
  const preview = text.slice(0, 4000);
  try {
    scanForSecrets("源码摘要", Buffer.from(preview));
    return preview;
  } catch {
    return "摘要含疑似敏感值，不在记录中展示";
  }
}
const reply = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});
export function componentSourceTool(
  root: string,
  revision: string,
  range: string,
  onUse: (record: object) => void,
  sourceLabel = "当前仓",
) {
  return defineTool({
    name: "component_source",
    label: "读取组件源码",
    description:
      '只读本次固定版本的源码。list 列目录，read 读文件。search 多关键词用 keywords 数组，任意一个命中即可，例如 keywords:["CODC","PCI","MRO"]；完整短语用 query，空格不会拆词，两者只填一个。默认忽略大小写，区分大小写时设置 ignore_case:false。每次只搜索指定仓，其他仓须分别调用。不能修改源码。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("search"),
        Type.Literal("read"),
      ]),
      path: Type.Optional(Type.String({ description: "仓内完整相对路径，read 请使用 list/search 返回的路径，不要仅凭文件名猜测。" })),
      query: Type.Optional(Type.String({ description: "完整短语搜索，按字面匹配，不支持正则；多个关键词请用 keywords。" })),
      keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, description: "多个字面关键词，任意一个命中即可；与 query 二选一。" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "默认 true：忽略大小写；false：区分大小写。" })),
      start: Type.Optional(Type.Integer({ minimum: 1, description: "read 的起始行，或 list 的起始条目（从 1 开始）" })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: "read 的末行，或 list 的末条目" })),
    }),
    async execute(_id: string, input: any, signal) {
      try {
        const path = String(input.path ?? range);
        if (
          path &&
          (path.startsWith("/") ||
            path
              .split("/")
              .some((p: string) => p === ".." || p === "." || !p) ||
            /[\\\0\r\n]/.test(path))
        )
          throw new Error("请使用仓内相对路径");
        if (range && path !== range && !path.startsWith(range + "/"))
          throw new Error(
            "请在配置的组件源码范围内阅读，跨仓调用请用 code_search",
          );
        let text = "";
        if (input.action === "list") {
          text = await executeFile(
            "git",
            [
              "--literal-pathspecs",
              "ls-tree",
              "-r",
              "--name-only",
              revision,
              "--",
              ...(path ? [path] : []),
            ],
            root, signal,
          );
          const entries = text.trimEnd().split("\n").filter(Boolean);
          const start = Math.max(1, input.start ?? 1);
          const end = Math.min(entries.length, input.end ?? start + 99, start + 199);
          text = `目录共 ${entries.length} 项，本次 ${start}–${end} 项\n${entries.slice(start - 1, end).join("\n")}`;
          if (end < entries.length) text += `\n后续请用 list start=${end + 1} 继续，或指定 path 分目录读取`;
        }
        else if (input.action === "search") {
          const hasQuery = typeof input.query === "string" && !!input.query.trim();
          if (hasQuery && input.keywords !== undefined) throw new Error("query 与 keywords 只能填写一个；多关键词请用 keywords 数组");
          if (input.keywords !== undefined && (!Array.isArray(input.keywords) || !input.keywords.length || input.keywords.length > 32 || input.keywords.some((word: unknown) => typeof word !== "string" || !word.trim())))
            throw new Error("keywords 须包含 1～32 个非空字符串");
          const patterns: string[] = input.keywords !== undefined ? [...new Set<string>(input.keywords)] : hasQuery ? [input.query] : [];
          if (!patterns.length) throw new Error("请填写 query 完整短语，或 keywords 关键词数组");
          if (patterns.some(word => /[\r\n\0]/.test(word))) throw new Error("搜索词不能包含换行或空字符");
          if (input.ignore_case !== undefined && typeof input.ignore_case !== "boolean") throw new Error("ignore_case 须为布尔值");
          const ignoreCase = input.ignore_case ?? true;
          try {
            text = await executeFile(
              "git",
              [
                "--literal-pathspecs",
                "grep",
                "-n",
                "-F",
                ...(ignoreCase ? ["-i"] : []),
                ...patterns.flatMap(word => ["-e", word]),
                revision,
                "--",
                ...(path ? [path] : []),
              ],
              root, signal,
            );
          } catch (error) {
            if ((error as any).code !== 1) throw error;
            text = "没有命中。仅表示本仓当前版本和范围内未匹配，不代表其他仓没有相关代码。";
            if (hasQuery && /\s/.test(input.query)) text += "当前按完整短语搜索；若要查多个词，请改用 keywords 数组。";
          }
          text = `仓库：${sourceLabel}\n版本：${revision}\n范围：${path || "全仓"}\n匹配：${input.keywords !== undefined ? "多关键词任意命中" : "完整短语"}；${ignoreCase ? "忽略大小写" : "区分大小写"}；字面搜索\n${text}`;
        } else {
          if (!path) throw new Error("read 需要文件路径，请先用 list 查看目录");
          const entry = await executeFile("git", ["--literal-pathspecs", "ls-tree", revision, "--", path], root, signal);
          if (!entry.trim()) throw new Error(`当前版本下文件不存在：${path}。请先用 list 查找完整仓内路径，再 read；不要反复猜测文件名。`);
          if (/^040000 tree /.test(entry)) throw new Error(`路径是目录：${path}。请用 list 列出文件后再 read。`);
          const content = await executeFile(
            "git",
            ["show", `${revision}:${path}`],
            root, signal,
          );
          const lines = content.split("\n"),
            start = Math.max(1, input.start ?? 1),
            end = Math.min(lines.length, input.end ?? start + 159, start + 399);
          text =
            `${path} @ ${revision}\n` +
            lines
              .slice(start - 1, end)
              .map((s, i) => `${start + i}: ${s}`)
              .join("\n");
          if (end < lines.length) text += `\n后续从 ${end + 1} 行读取`;
        }
        onUse({
          tool: "component_source",
          ...input,
          path,
          revision,
          status: "returned",
          characters: text.length,
          preview: evidencePreview(text),
        });
        return reply(text.length > 30000 ? text.slice(0, 30000) + "\n返回内容已截断，请缩小 path 或 start/end 范围继续读取。" : text);
      } catch (e) {
        onUse({
          tool: "component_source",
          ...input,
          status: "failed",
          error: (e as Error).message,
        });
        return { ...reply((e as Error).message), isError: true };
      }
    },
  });
}
export function codeSearchTool(onUse: (record: object) => void) {
  return defineTool({
    name: "code_search",
    label: "Sourcegraph 代码搜索",
    description:
      "通过内网 ec 查询真实调用。kw query 可带 repo: 和 lang:；nls 为模糊搜索；read 用搜索返回的仓库名、完整路径读上下文。勿把片段当完整语义；返回未标明版本时注明版本未知。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("repos"),
        Type.Literal("kw"),
        Type.Literal("nls"),
        Type.Literal("read"),
      ]),
      query: Type.Optional(Type.String()),
      repository: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      start: Type.Optional(Type.Integer({ minimum: 1 })),
      end: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id: string, input: any, signal) {
      try {
        const args =
          input.action === "read"
            ? [
                "read",
                input.repository,
                input.path,
                `--start:=${input.start ?? 1}`,
                `--end:=${input.end ?? 160}`,
              ]
            : [input.action, input.query];
        if (
          args.some(
            (a: any) =>
              typeof a !== "string" ||
              !a ||
              a.includes("\0") ||
              (a.startsWith("-") &&
                !a.startsWith("--start:=") &&
                !a.startsWith("--end:=")),
          ) ||
          (input.action === "read" &&
            [input.repository, input.path].some((a: string) =>
              a.startsWith("-"),
            ))
        )
          throw new Error("请提供查询或仓库与文件路径");
        const text = await executeFile(ecBinary(), args, undefined, signal);
        onUse({
          tool: "code_search",
          ...input,
          status: "returned",
          characters: text.length,
          preview: evidencePreview(text),
        });
        return reply(text.slice(0, 30000));
      } catch (e) {
        onUse({
          tool: "code_search",
          ...input,
          status: "failed",
          error: (e as Error).message,
        });
        return { ...reply((e as Error).message), isError: true };
      }
    },
  });
}

/** One language-wide tool; checkouts are prepared only when the agent inspects a component. */
export function languageComponentSourceTool(
  components: import("./componentRepositories.ts").ComponentRepository[],
  prepare: (component: import("./componentRepositories.ts").ComponentRepository) => Promise<{root: string; revision: string}>,
  onUse: (record: Record<string, unknown>) => void,
) {
  const base = componentSourceTool("", "", "", onUse);
  const sources = new Map<string, Promise<{root: string; revision: string}>>();
  return defineTool({
    ...base,
    description: `按 component_id 选择本次研究清单中的一个仓。未提供 ID 时仅在一个仓时自动选择。${base.description}`,
    parameters: Type.Object({ ...base.parameters.properties, component_id: Type.Optional(Type.String()) }),
    async execute(id: string, input: any, signal, onUpdate, context) {
      const component = components.find(c => c.id === input.component_id) ?? (!input.component_id && components.length === 1 ? components[0] : undefined);
      if (!component) return { ...reply("请指定本次组件清单中的 component_id"), isError: true };
      try {
        if (!sources.has(component.id)) sources.set(component.id, prepare(component));
        const source = await sources.get(component.id)!;
        return await componentSourceTool(source.root, source.revision, component.path, event => onUse({ ...event, component_id: component.id, repository: component.repository }), `${component.id} (${component.repository})`).execute(id, input, signal, onUpdate, context);
      } catch (error) {
        sources.delete(component.id);
        const message = error instanceof Error ? error.message : "源码准备失败";
        onUse({ tool: "component_source", action: input.action, component_id: component.id, repository: component.repository, status: "failed", error: message });
        return { ...reply(message), isError: true };
      }
    },
  });
}
