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
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, EC_DEBUG: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) =>
        error
          ? reject(
              Object.assign(
                new Error(
                  `${file === "git" ? "源码读取" : "ec 调用"}失败，请检查工具安装、凭据和网络`,
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
export async function checkEc() {
  await executeFile(ecBinary(), ["tools"]);
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
) {
  return defineTool({
    name: "component_source",
    label: "读取组件源码",
    description:
      "只读本次固定版本的组件源码。list 列指定范围，search 搜索源码行，read 展开文件。不能修改源码。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("search"),
        Type.Literal("read"),
      ]),
      path: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      start: Type.Optional(Type.Integer({ minimum: 1, description: "read 的起始行，或 list 的起始条目（从 1 开始）" })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: "read 的末行，或 list 的末条目" })),
    }),
    async execute(_id: string, input: any) {
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
            root,
          );
          const entries = text.trimEnd().split("\n").filter(Boolean);
          const start = Math.max(1, input.start ?? 1);
          const end = Math.min(entries.length, input.end ?? start + 99, start + 199);
          text = `目录共 ${entries.length} 项，本次 ${start}–${end} 项\n${entries.slice(start - 1, end).join("\n")}`;
          if (end < entries.length) text += `\n后续请用 list start=${end + 1} 继续，或指定 path 分目录读取`;
        }
        else if (input.action === "search") {
          if (!input.query) throw new Error("请输入关键词");
          try {
            text = await executeFile(
              "git",
              [
                "--literal-pathspecs",
                "grep",
                "-n",
                "-F",
                "-e",
                input.query,
                revision,
                "--",
                ...(path ? [path] : []),
              ],
              root,
            );
          } catch (error) {
            if ((error as any).code !== 1) throw error;
            text = "没有命中";
          }
        } else {
          const content = await executeFile(
            "git",
            ["show", `${revision}:${path}`],
            root,
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
        return reply((e as Error).message);
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
    async execute(_id: string, input: any) {
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
        const text = await executeFile(ecBinary(), args);
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
        return reply((e as Error).message);
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
    description: "按 component_id 只读本次语言范围内的组件源码；list/search/read。未提供 ID 时仅在一个组件仓时自动选择。",
    parameters: Type.Object({ ...base.parameters.properties, component_id: Type.Optional(Type.String()) }),
    async execute(id: string, input: any, signal, onUpdate, context) {
      const component = components.find(c => c.id === input.component_id) ?? (!input.component_id && components.length === 1 ? components[0] : undefined);
      if (!component) return reply("请指定本次组件清单中的 component_id");
      try {
        if (!sources.has(component.id)) sources.set(component.id, prepare(component));
        const source = await sources.get(component.id)!;
        return await componentSourceTool(source.root, source.revision, component.path, event => onUse({ ...event, component_id: component.id, repository: component.repository })).execute(id, input, signal, onUpdate, context);
      } catch (error) {
        sources.delete(component.id);
        const message = error instanceof Error ? error.message : "源码准备失败";
        onUse({ tool: "component_source", action: input.action, component_id: component.id, repository: component.repository, status: "failed", error: message });
        return reply(message);
      }
    },
  });
}
