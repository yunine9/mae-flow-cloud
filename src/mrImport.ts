import { pipelineHeaders, type PipelineCredential } from "./pipelineClient.ts";
import { parseRepairMr, type RepairMr } from "./mrImportTypes.ts";
export { normalizeRepairMrUrl, parseRepairMr, type RepairMr } from "./mrImportTypes.ts";

export async function readRepairMr(options: { platformUrl: string; url: string; credential?: PipelineCredential; signal?: AbortSignal }): Promise<RepairMr> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await fetch(`${options.platformUrl.replace(/\/+$/, "")}/mr/detail?mr_url=${encodeURIComponent(options.url)}`, {
    headers: pipelineHeaders(options.credential), signal,
  });
  if (!response.ok) throw new Error(response.status === 404
    ? "交付平台尚未支持 MR 详情查询，请联系管理员更新配置"
    : `读取 MR 详情失败（HTTP ${response.status}），请核对个人 Git 令牌与 MR 权限`);
  return parseRepairMr(await response.json(), options.url);
}
