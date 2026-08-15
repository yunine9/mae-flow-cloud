/**
 * 剧本化假模型——真 Pi 会话的无 LLM 对拍电源(详设 §8/主 spec §15.3)。
 *
 * 实现 Anthropic Messages 的最小服务端(流式 SSE 与非流式),
 * 按对话里已出现的 tool_result 数量决定走到剧本第几幕。
 * 生产接 GLM-5.1 时只是把 models.json 的 baseUrl 换成真网关,剧本退场。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Scene {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
}

type Block = Record<string, unknown>;

function countToolResults(messages: Array<Record<string, any>>): number {
  let count = 0;
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && block.type === "tool_result") count += 1;
    }
  }
  return count;
}

function sceneBlocks(scene: Scene, index: number): Block[] {
  const blocks: Block[] = [];
  if (scene.text) blocks.push({ type: "text", text: scene.text });
  if (scene.tool) {
    blocks.push({
      type: "tool_use",
      id: `scripted-${index}`,
      name: scene.tool.name,
      input: scene.tool.input ?? {},
    });
  }
  return blocks;
}

export class ScriptedModelServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private server?: Server;

  constructor(
    readonly script: Scene[],
    readonly modelId = "scripted-v1",
    /** linear=剧本跨会话顺演(每个请求推进一幕)。默认按当前对话深度
     * 选幕——那是单会话剧本的形状,新会话会从第 0 幕重演;修复环这类
     * "多会话接力"的剧本必须顺演,不然第二个会话拿到的是第一幕
     * (实测:修复会话跑去 checkout -b,报 branch already exists)。 */
    readonly options: { linear?: boolean } = {},
  ) {}

  get baseUrl(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** 写进任务 agent 目录的 models.json 内容;生产换 GLM 只改这里。 */
  modelsJson(provider = "maeflow"): Record<string, unknown> {
    return {
      providers: {
        [provider]: {
          baseUrl: this.baseUrl,
          api: "anthropic-messages",
          apiKey: "scripted",
          models: [{ id: this.modelId }],
        },
      },
    };
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        let body: Record<string, any>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          response.writeHead(400).end();
          return;
        }
        this.requests.push(body);
        const index = Math.min(
          this.options.linear
            ? this.requests.length - 1
            : countToolResults(body.messages),
          this.script.length - 1);
        const scene = this.script[index];
        const blocks = sceneBlocks(scene, index);
        const stopReason = scene.tool ? "tool_use" : "end_turn";
        if (body.stream) this.stream(response, blocks, stopReason);
        else this.plain(response, blocks, stopReason);
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private plain(
    response: import("node:http").ServerResponse,
    blocks: Block[],
    stopReason: string,
  ): void {
    const body = JSON.stringify({
      id: "msg-scripted",
      type: "message",
      role: "assistant",
      model: this.modelId,
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(body);
  }

  private stream(
    response: import("node:http").ServerResponse,
    blocks: Block[],
    stopReason: string,
  ): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const emit = (name: string, data: unknown) => {
      response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit("message_start", {
      type: "message_start",
      message: {
        id: "msg-scripted", type: "message", role: "assistant",
        model: this.modelId, content: [], stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        emit("content_block_start", {
          type: "content_block_start", index,
          content_block: { type: "text", text: "" },
        });
        emit("content_block_delta", {
          type: "content_block_delta", index,
          delta: { type: "text_delta", text: block.text },
        });
      } else {
        emit("content_block_start", {
          type: "content_block_start", index,
          content_block: {
            type: "tool_use", id: block.id, name: block.name, input: {},
          },
        });
        emit("content_block_delta", {
          type: "content_block_delta", index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        });
      }
      emit("content_block_stop", { type: "content_block_stop", index });
    });
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    emit("message_stop", { type: "message_stop" });
    response.end();
  }
}
