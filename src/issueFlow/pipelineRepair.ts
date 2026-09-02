/**
 * 问题流流水线红灯修复的公共件(从需求侧同名能力收窄移植):
 * - mirrorPipelineArtifacts: 平台 /pipeline/artifacts 的失败产物全文
 *   镜像到会话工作区 pipeline/,AI 用 Bash 读全文而不是 1500 字摘要。
 * - repairBudget: 修复轮预算(与需求侧同一管理页旋钮 repair_rounds,
 *   同一缺省 20;0=关掉自动修复,红灯留痕请人工)。
 *
 * 只放与 TaskService 无关的纯机械;分诊/派单不出这条线——问题流的
 * 修复会话就是会话自己(容器在场),平台回合即派单。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 修复轮预算:管理页旋钮现读,缺席用需求侧同款缺省 20。 */
export function repairBudget(
  settings?: { runtime?(): { repair_rounds?: number } },
): number {
  const value = settings?.runtime?.().repair_rounds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value) : 20;
}

/**
 * 拉取并镜像流水线失败产物(与需求侧 taskService.mirrorPipelineArtifacts
 * 同一平台端点、同一语义):
 * - 端点是 MR-first:第四参要完整 MR URL(status 主路用的 iid 在这里
 *   不被 artifacts 编排器消费);
 * - 每次镜像先清空目录:上一轮的旧 SHA 日志若还躺着,修复会话会按
 *   错误现场继续改代码;
 * - 查询失败/无产物不抛——镜像只是取证的增强,红灯主链路(账本+回合)
 *   不因它中断,调用方按返回清单决定给 AI 的指引文案。
 */
export async function mirrorPipelineArtifacts(input: {
  platformUrl: string;
  sha: string;
  /** 仓地址(明文,端点侧自行编码)。 */
  repo: string;
  mrUrl?: string;
  /** 会话工作区下的落点目录(不存在则创建)。 */
  dir: string;
  /** 平台身份头(与 pipelineClient 同源凭据通道)。 */
  headers?: Record<string, string>;
}): Promise<string[]> {
  const repo = encodeURIComponent(input.repo);
  const url = `${input.platformUrl}/pipeline/artifacts?sha=${input.sha}`
    + `&repo=${repo}`
    + (input.mrUrl ? `&mr=${encodeURIComponent(input.mrUrl)}` : "");
  let files: Array<{ name: string; text: string }>;
  try {
    const response = await fetch(url, { headers: input.headers });
    if (response.status === 404) return [];
    if (!response.ok) return [];
    const body = await response.json() as { files?: unknown };
    files = (Array.isArray(body.files) ? body.files : [])
      .filter((file: any): file is { name: string; text: string } =>
        typeof file?.name === "string"
        && file.name === file.name.trim() && file.name !== ""
        && file.name === file.name.split("/").pop()
        && typeof file?.text === "string");
  } catch {
    return [];
  }
  mkdirSync(input.dir, { recursive: true });
  for (const entry of readdirSync(input.dir)) {
    rmSync(join(input.dir, entry), { recursive: true, force: true });
  }
  const written: string[] = [];
  for (const file of files) {
    if (!file.text) continue;
    writeFileSync(join(input.dir, file.name), file.text);
    written.push(file.name);
  }
  return written;
}
