/**
 * 【原型·随时可扔】问题概览按特性分类原型的样本现场。
 *
 * 生成 .prototype-issue-fixtures 数据目录(auth + 跨特性分布的问题
 * 会话),配合样本服务与 web dev 做三个 ?variant= 变体的人工验收:
 *
 *   npx tsx scripts/prototype-issue-overview-fixtures.ts
 *   MAE_FLOW_UI_FIXTURE_MODE=1 npx tsx src/serve.ts \
 *     --data .prototype-issue-fixtures --port 8839
 *   cd web && npx vite --config vite.prototype.config.ts --port 5180
 *
 * 纪律:只种 waiting_user/idle/suspended/failed/archived/canceled 等
 * 不会被运行时续跑的状态,避免样本服务拾起会话真的起 Agent。
 * 正式 UI 样本仍走 npm run ui:fixtures,本脚本与它互不影响。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAuth } from "../src/auth.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
const dataDir = resolve(repositoryRoot, ".prototype-issue-fixtures");
if (dataDir === repositoryRoot || !dataDir.startsWith(repositoryRoot + sep)) {
  throw new Error("样本目录必须是仓库内独立子目录");
}

if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(join(dataDir, "issues"), { recursive: true, mode: 0o700 });

const auth = new LocalAuth(join(dataDir, "auth.json"));
auth.bootstrapAdmin("admin", "mae-flow-demo");
auth.createUser("dev", "mae-flow-demo", "developer", "林知远");
auth.createUser("reviewer", "mae-flow-demo", "developer", "周谨");

const now = Date.now();
const iso = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();

interface SeedIssue {
  id: string;
  module: string;
  moduleId: string;
  title: string;
  status: "waiting_user" | "idle" | "suspended" | "failed" | "archived" | "canceled";
  stage: string;
  account: string;
  ticket?: string;
  minutesAgo: number;
  conclusion?: { kind: "non_issue" | "delivered" | "issue"; summary: string };
}

/** 五个特性 × 多状态的样本分布;一个无模块会话验「未分类」兜底。 */
const seeds: SeedIssue[] = [
  { id: "issue-proto-01", module: "无线特性-漫游切换", moduleId: "proto-roam", title: "终端跨 AP 漫游后偶发掉线,重连需 30s", status: "waiting_user", stage: "analyze", account: "dev", ticket: "DTS-2026-91801", minutesAgo: 35 },
  { id: "issue-proto-02", module: "无线特性-漫游切换", moduleId: "proto-roam", title: "漫游切换期间语音报文抖动超标", status: "archived", stage: "conclude", account: "reviewer", ticket: "DTS-2026-91755", minutesAgo: 60 * 26, conclusion: { kind: "delivered", summary: "切换阈值配置缺陷,已提交修复并合入。" } },
  { id: "issue-proto-03", module: "无线特性-漫游切换", moduleId: "proto-roam", title: "双频终端漫游后 5G 频段不回连", status: "failed", stage: "mr_green", account: "dev", ticket: "DTS-2026-91702", minutesAgo: 90 },
  { id: "issue-proto-04", module: "无线特性-射频校准", moduleId: "proto-rf", title: "高低温箱内射频校准漂移超规格", status: "waiting_user", stage: "fix", account: "dev", ticket: "DTS-2026-91688", minutesAgo: 120 },
  { id: "issue-proto-05", module: "无线特性-射频校准", moduleId: "proto-rf", title: "校准后功率档位与标称值偏差 2dB", status: "idle", stage: "fix", account: "reviewer", ticket: "DTS-2026-91640", minutesAgo: 50 },
  { id: "issue-proto-06", module: "无线特性-射频校准", moduleId: "proto-rf", title: "批量产线校准良率下降,疑似温补表版本", status: "archived", stage: "conclude", account: "dev", ticket: "DTS-2026-91511", minutesAgo: 60 * 50, conclusion: { kind: "non_issue", summary: "产线夹具老化导致,非产品问题。" } },
  { id: "issue-proto-07", module: "语音特性-降噪", moduleId: "proto-nr", title: "强风噪场景下行通话对方听到断续", status: "waiting_user", stage: "dts_info", account: "reviewer", ticket: "DTS-2026-91822", minutesAgo: 15 },
  { id: "issue-proto-08", module: "语音特性-降噪", moduleId: "proto-nr", title: "蓝牙耳机端降噪等级切换有爆音", status: "archived", stage: "conclude", account: "dev", ticket: "DTS-2026-91402", minutesAgo: 60 * 80, conclusion: { kind: "delivered", summary: "增益爬坡曲线修复,MR 已合入。" } },
  { id: "issue-proto-09", module: "语音特性-降噪", moduleId: "proto-nr", title: "会议室场景多人说话时降噪过度", status: "archived", stage: "conclude", account: "reviewer", ticket: "DTS-2026-91388", minutesAgo: 60 * 96, conclusion: { kind: "issue", summary: "确认为算法局限,转需求单跟踪。" } },
  { id: "issue-proto-10", module: "安全特性-加密启动", moduleId: "proto-sec", title: "更换闪存片后加密启动校验失败", status: "failed", stage: "analyze", account: "dev", ticket: "DTS-2026-91800", minutesAgo: 25 },
  { id: "issue-proto-11", module: "安全特性-加密启动", moduleId: "proto-sec", title: "安全启动证书链过期提示误导运维", status: "suspended", stage: "conclude", account: "reviewer", minutesAgo: 60 * 8 },
  { id: "issue-proto-12", module: "运维特性-日志回传", moduleId: "proto-log", title: "日志回传在弱网下重复上传同一分片", status: "waiting_user", stage: "fix", account: "dev", ticket: "DTS-2026-91790", minutesAgo: 45 },
  { id: "issue-proto-13", module: "运维特性-日志回传", moduleId: "proto-log", title: "日志打包偶发超过平台单包上限", status: "archived", stage: "conclude", account: "dev", ticket: "DTS-2026-91666", minutesAgo: 60 * 40, conclusion: { kind: "delivered", summary: "分片上限自适应修复。" } },
  { id: "issue-proto-14", module: "", moduleId: "", title: "后台页面导出报表乱码(待认领模块)", status: "idle", stage: "prep_repo", account: "reviewer", minutesAgo: 200 },
  { id: "issue-proto-15", module: "无线特性-漫游切换", moduleId: "proto-roam", title: "误登记:现场无法复现,登记后撤回", status: "canceled", stage: "dts_info", account: "dev", ticket: "DTS-2026-91599", minutesAgo: 60 * 60 },
];

// 种子里不该出现运行态:running/queued 会被样本服务续跑拾起。
for (const seed of seeds) {
  if (!["waiting_user", "idle", "suspended", "failed", "archived", "canceled"]
    .includes(seed.status)) {
    throw new Error(`种子 ${seed.id} 状态 ${String(seed.status)} 会被运行时续跑,换掉`);
  }
}

for (const seed of seeds) {
  const root = join(dataDir, "issues", seed.id);
  mkdirSync(root, { recursive: true });
  const state = {
    id: seed.id,
    account: seed.account,
    reporter: "admin",
    created_at: iso(seed.minutesAgo + 30),
    updated_at: iso(seed.minutesAgo),
    title: seed.title,
    description: "按特性分类原型的样本会话。",
    source: seed.ticket ? "dts" : "manual",
    ...(seed.ticket ? { ticket: seed.ticket } : {}),
    repo_url: "https://git.example.com/proto/device-firmware.git",
    repo_urls: ["https://git.example.com/proto/device-firmware.git"],
    ...(seed.module ? { module: seed.module, module_id: seed.moduleId } : {}),
    status: seed.status,
    stage: seed.stage,
    stage_note: "原型样本现场",
    stage_at: iso(seed.minutesAgo),
    round: 1,
    ...(seed.conclusion
      ? { conclusion: { ...seed.conclusion, at: iso(seed.minutesAgo) } }
      : {}),
  };
  writeFileSync(join(root, "issue.json"), JSON.stringify(state, null, 2),
    { mode: 0o600 });
}

console.log(`[prototype-fixtures] 样本现场就绪:${dataDir}`);
console.log("[prototype-fixtures] 登录 admin / mae-flow-demo;下一步启动 8839 样本服务与 web 原型 dev。");
