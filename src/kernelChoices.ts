/**
 * 内核的交付方式选项——**问内核要,不在 TS 侧另抄一份**。
 *
 * 踩过的坑(2026-08-18 内网实战):下单表单曾自造一套"快速/慢速"车道,
 * 而内核 `workflow_select` 步的真实选项是
 * full/hotfix/tweak/review → 完整开发 / 已定位问题修复 / 局部修改 /
 * 处理评审意见。两套话对不上,于是"下单已选"永远匹配不上内核举的卡,
 * 用户在页面上被再问一遍交付方式——他明明在下单时就答过了。
 *
 * 这正是红线"连阶段→步骤的映射都不许在 TS 侧再抄一份"的实例:分类是
 * 内核的领地。取法优先走**明面上的契约** `mae-flow.py steps --json`
 * (为此在内核里加的宿主口,判定与分类仍归内核);拿不到才退回直接读
 * `flow/flow.json`——那是扒内脏,布局一改就哑,只当兜底。两条都不成
 * (快照残缺/python 不在)就回空数组,调用方退回"不预选",fail-open
 * 到人工,绝不猜一套选项出来。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 一个交付方式:key 是内核的 choice(full/hotfix/…),label 是给人看的,
 * 也正是回传给内核的**选项原文**(done --choice 按它对账)。
 * steps/acks 是给人掂量快慢用的(这条链多少步、要拍板几次)——数字由
 * 内核 steps --json 按 flow 现算,不是前端手写一份会过期的说明;兜底
 * 路径(直接读 flow.json)算不出链就缺席,表单只显示名字。 */
export interface WorkflowChoice {
  key: string;
  label: string;
  steps?: number;
  acks?: number;
}

/** 目录里还带着"能不能给新单选"这一位。下单表单要的是能选的那批,
 * 修复环要的恰恰是**不给新单选**的那个(review)——所以缓存存全量,
 * 各取所需,不必为此再问内核第二遍。 */
interface WorkflowEntry extends WorkflowChoice {
  forNewOrders: boolean;
}

const cache = new Map<string, WorkflowEntry[]>();

/** 首选:问内核要机读目录。python 不在/命令老(旧快照没有 --json)都
 * 只是拿不到,不是错误——静静退回兜底。 */
function fromKernelCommand(kernelRoot: string): WorkflowEntry[] {
  const script = join(kernelRoot, "scripts", "mae-flow.py");
  if (!existsSync(script)) return [];
  const stdout = execFileSync("python3", [script, "steps", "--json"], {
    encoding: "utf-8",
    timeout: 15_000,      // 旁路取值也不许无限等待(红线)
    stdio: ["ignore", "pipe", "ignore"],
  });
  const catalog = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  return ((catalog.workflows ?? []) as Array<Record<string, any>>)
    .map((item) => {
      const chain = (item.steps ?? []) as Array<{ user_ack?: boolean }>;
      return {
        key: String(item.key ?? ""),
        // answers[0] 是内核对账用的原文;没有就退回展示名
        label: String(item.answers?.[0] ?? item.label ?? ""),
        forNewOrders: item.for_new_orders !== false,
        ...(chain.length ? {
          steps: chain.length,
          acks: chain.filter((step) => step.user_ack).length,
        } : {}),
      };
    })
    .filter((item) => item.key && item.label);
}

/** 兜底:直接读 flow.json。够用但耦合内核文件布局,能问就别读。 */
function fromFlowJson(kernelRoot: string): WorkflowEntry[] {
  const path = join(kernelRoot, "flow", "flow.json");
  if (!existsSync(path)) return [];
  const flow = JSON.parse(readFileSync(path, "utf-8"));
  const step = flow?.steps?.workflow_select ?? {};
  const answers = (step.choice_answers ?? {}) as Record<string, string[]>;
  // 字段缺席(老 flow)=全部可给新单选。
  const newOrder = Array.isArray(step.new_order_choices)
    ? new Set((step.new_order_choices as unknown[]).map(String))
    : undefined;
  return ((step.choices ?? []) as unknown[])
    .map((key) => ({
      key: String(key),
      label: answers[String(key)]?.[0],
      forNewOrders: !newOrder || newOrder.has(String(key)),
    }))
    .filter((item): item is WorkflowEntry => !!item.label);
}

function allWorkflows(kernelRoot: string | undefined): WorkflowEntry[] {
  if (!kernelRoot) return [];
  const cached = cache.get(kernelRoot);
  if (cached) return cached;
  let entries: WorkflowEntry[] = [];
  for (const read of [fromKernelCommand, fromFlowJson]) {
    try {
      entries = read(kernelRoot);
    } catch {
      entries = [];   // 读不动=不预选,不猜
    }
    if (entries.length) break;
  }
  cache.set(kernelRoot, entries);
  return entries;
}

/** 下单表单能列的交付方式:只有新单可选的那批。review 仅限已交付单
 * (内核目录的 for_new_orders,来源是 flow.json 的 new_order_choices)
 * ——新单选它跳过设计与定稿还不碰规格,必错;检视意见由修复环自动走。 */
export function workflowChoices(kernelRoot: string | undefined): WorkflowChoice[] {
  return allWorkflows(kernelRoot)
    .filter((item) => item.forNewOrders)
    .map(({ forNewOrders: _drop, ...choice }) => choice);
}

/** 某个交付方式回传给内核的**选项原文**;问不到内核就回空串。
 * 修复环要拿它写下单事实,而 workflowChoices 按设计把 review 滤掉了。
 * 别在调用方写死"处理评审意见"——那正是本文件开头那条教训。 */
export function workflowLabel(
  kernelRoot: string | undefined,
  key: string,
): string {
  return allWorkflows(kernelRoot).find((item) => item.key === key)?.label ?? "";
}
