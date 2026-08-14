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
  log?: (message: string) => void;
}

export class GateService {
  private readonly moonlight: boolean;
  private readonly contract?: GateContract;
  private readonly log: (message: string) => void;

  constructor(options: GateServiceOptions = {}) {
    this.moonlight = Boolean(options.moonlight);
    this.contract = options.contract;
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
    if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
      return this.deep(tool, String(input.file_path ?? ""), event);
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
}
