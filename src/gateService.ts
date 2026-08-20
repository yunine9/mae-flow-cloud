/**
 * tool_requested 的同步裁决点(详设 §4/D3)。
 *
 * 在进程内集成里,拦截通过 pi 的 tool_call 扩展钩子实现:
 * 钩子返回 {block, reason} → reason 成为模型看到的错误工具结果,
 * 与旧插件 exit 2 + stderr 打回文案同构。
 *
 * 深层契约(gate-edit/gate-bash 的证据链)是内核的领地,经 contract
 * 端口注入——接线形态是调用容器内的内核 CLI(python mae-flow.py gate),
 * 不在 TS 里复刻规则。fail-open 语义保留:门禁自身故障=放行+留痕。
 */

import type { SemanticEvent } from "./semanticEvents.ts";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type GateAction = "allow" | "deny" | "human" | "agent";

export interface GateDecision {
  action: GateAction;
  reason?: string;
}

export const ALLOW: GateDecision = { action: "allow" };

export type GateContract = (
  tool: string,
  value: string,
  event: SemanticEvent,
) => GateDecision | undefined;

export interface GateServiceOptions {
  moonlight?: boolean;
  contract?: GateContract;
  /** 任务代码工作区；配置后文件工具在任何内核状态下都不得越界。 */
  workspace?: string;
  log?: (message: string) => void;
}

export class GateService {
  private readonly moonlight: boolean;
  private readonly contract?: GateContract;
  private readonly workspace?: string;
  private readonly log: (message: string) => void;

  constructor(options: GateServiceOptions = {}) {
    this.moonlight = Boolean(options.moonlight);
    this.contract = options.contract;
    this.workspace = options.workspace
      ? realpathSync(resolve(options.workspace))
      : undefined;
    this.log = options.log ?? (() => {});
  }

  decide(event: SemanticEvent): GateDecision {
    try {
      return this.route(event);
    } catch (error) {
      // fail-open:门禁不许因为自己坏了卡死交付。
      this.log(`gate fail-open: ${String(error)}`);
      return ALLOW;
    }
  }

  private route(event: SemanticEvent): GateDecision {
    const payload = event.payload as Record<string, any>;
    const tool = String(payload.name ?? "");
    const input = (payload.input ?? {}) as Record<string, any>;
    if (tool === "AskUserQuestion") {
      if (this.moonlight) {
        return {
          action: "deny",
          reason: "月光宝盒模式下不提问;按既定决定继续,待办已记录。",
        };
      }
      // D4:永不真实执行,转 Web 待办;决定以工具结果按 call_id 回注。
      return { action: "human" };
    }
    if (tool === "Task" || tool === "Agent") return { action: "agent" };
    if (
      tool === "Read" || tool === "Edit" || tool === "Write"
      || tool === "MultiEdit"
    ) {
      // Pi 的内建文件工具使用 `path`;旧宿主/Claude Hook 使用
      // `file_path`. 真实执行字段必须优先,否则 Pi 的写入会以空值绕过
      // 注入契约。仓库边界由知道任务 workspace 的内核 pretool 统一裁决。
      const paths = [input.path, input.file_path]
        .filter((value, index, values) =>
          typeof value === "string" && value
          && values.indexOf(value) === index) as string[];
      const escaped = this.workspace
        ? paths.find((path) => !this.insideWorkspace(path))
        : undefined;
      if (escaped) {
        return {
          action: "deny",
          reason: `文件工具只能访问当前任务仓库，已阻止越界路径: ${escaped}`,
        };
      }
      return this.deep(tool, paths[0] ?? "", event);
    }
    if (tool === "Bash") {
      return this.deep(tool, String(input.command ?? ""), event);
    }
    return ALLOW;
  }

  private deep(tool: string, value: string, event: SemanticEvent): GateDecision {
    if (!this.contract || !value) return ALLOW;
    return this.contract(tool, value, event) ?? ALLOW;
  }

  private insideWorkspace(value: string): boolean {
    if (!this.workspace || !value || value.includes("\0")) return false;
    if (/^[A-Za-z]:[^\\/]/.test(value)) return false;
    // POSIX 上不能把 Windows 绝对/盘符相对路径当成带冒号的普通文件名。
    if (process.platform !== "win32" && /^(?:[A-Za-z]:|[\\/]{2})/.test(value)) {
      return false;
    }
    const normalized = sep === "/" ? value.replaceAll("\\", "/") : value;
    const target = resolve(this.workspace, normalized);

    // 目标可以尚不存在；解析最近的已存在祖先，阻止仓内软链跳到仓外。
    let ancestor = target;
    const missing: string[] = [];
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
    try {
      return this.descendsFromWorkspace(
        resolve(realpathSync(ancestor), ...missing.reverse()),
      );
    } catch {
      return false;
    }
  }

  private descendsFromWorkspace(target: string): boolean {
    if (!this.workspace) return false;
    const rel = relative(this.workspace, target);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".."
      && !isAbsolute(rel));
  }
}
