/**
 * 内核宿主:云端合成 Hook 载荷,直接复用旧插件适配器当深层门禁引擎。
 *
 * `mae-flow/hooks/dispatch.py` 本来就是 CLI(stdin 单行 JSON → exit 2 =
 * 拦截/打回,文案在 stdout/stderr)。云端把语义事件合成为 sessionstart /
 * userprompt / pretooluse / posttooluse 载荷喂给它——内核零改动,
 * "机器只拦谎言"的全部契约(状态文件保护、伪证识别、证据登记、
 * 子 Agent 生命周期对账)原样生效。已实测:合成 pretooluse 对
 * `echo hacked > .mae-flow.json` 返回 exit 2 + 打回文案。
 *
 * 所有 dispatch 调用串行化:posttooluse 会写状态文件,与下一条
 * pretooluse 交错就是并发写状态——旧世界由宿主天然串行,这里用
 * promise 链保住同一语义。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { SemanticEvent } from "./semanticEvents.ts";
import type { GateDecision } from "./gateService.ts";

export interface KernelHostOptions {
  /** mae-flow 内核仓根目录 */
  kernelRoot: string;
  /** 任务代码工作区(dispatch 的 cwd,即仓库克隆) */
  workspace: string;
  /** 云端主 transcript 路径(证据契约从这里取工具事实) */
  transcriptPath: string;
  taskId: string;
  python?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

interface DispatchResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class KernelHost {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly options: KernelHostOptions) {}

  /** 任务开工:sessionstart + userprompt(捕获需求原话、铺转发壳),
   * 返回内核自己的开工引导文本——首条 prompt 的组成部分,不由云端复述。 */
  async bootstrap(requirement: string): Promise<string> {
    const started = await this.dispatch("sessionstart", {});
    const prompted = await this.dispatch("userprompt", {
      prompt: requirement,
    });
    return [started.stdout, prompted.stdout]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n");
  }

  /** pretooluse:exit 2 → deny,打回文案原样给模型(exit 2+stderr 同构)。 */
  async preTool(event: SemanticEvent): Promise<GateDecision | undefined> {
    const payload = event.payload as Record<string, any>;
    const result = await this.dispatch("pretooluse", {
      tool_name: payload.name,
      tool_input: payload.input,
      ...this.common(),
    });
    if (result.code === 2) {
      const reason = (result.stdout + "\n" + result.stderr).trim();
      return { action: "deny", reason: reason || "被 mae-flow 门禁打回" };
    }
    return undefined;
  }

  /** posttooluse:证据登记、契约校验、Task 完成对账都走这条。 */
  async postTool(event: SemanticEvent): Promise<void> {
    const payload = event.payload as Record<string, any>;
    await this.dispatch("posttooluse", {
      tool_name: payload.name,
      tool_input: payload.input,
      tool_use_id: payload.call_id,
      tool_response: {
        content: [{ type: "text", text: String(payload.result ?? "") }],
        is_error: Boolean(payload.is_error),
      },
      ...this.common(),
    });
  }

  private common(): Record<string, unknown> {
    return {
      cwd: this.options.workspace,
      session_id: this.options.taskId,
      transcript_path: this.options.transcriptPath,
    };
  }

  private dispatch(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const run = this.chain.then(() => this.spawnDispatch(event, payload));
    // 失败不断链:fail-open 由调用方语义决定,串行化必须继续。
    this.chain = run.catch(() => undefined);
    return run;
  }

  private spawnDispatch(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const { kernelRoot, workspace } = this.options;
    const script = join(kernelRoot, "hooks", "dispatch.py");
    return new Promise((resolve) => {
      const child = spawn(
        this.options.python ?? "python3",
        [script, event],
        { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => {
        // 对齐 dispatch 自己的看门狗精神:超时按 fail-open 放行并留痕。
        this.options.log?.(`dispatch ${event} 超时,按 fail-open 放行`);
        child.kill("SIGKILL");
      }, this.options.timeoutMs ?? 30_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        this.options.log?.(`dispatch ${event} 启动失败: ${String(error)}`);
        resolve({ code: 0, stdout: "", stderr: String(error) });
      });
      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    });
  }
}
