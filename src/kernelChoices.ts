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
 * 也正是回传给内核的**选项原文**(done --choice 按它对账)。 */
export interface WorkflowChoice {
  key: string;
  label: string;
}

const cache = new Map<string, WorkflowChoice[]>();

/** 首选:问内核要机读目录。python 不在/命令老(旧快照没有 --json)都
 * 只是拿不到,不是错误——静静退回兜底。 */
function fromKernelCommand(kernelRoot: string): WorkflowChoice[] {
  const script = join(kernelRoot, "scripts", "mae-flow.py");
  if (!existsSync(script)) return [];
  const stdout = execFileSync("python3", [script, "steps", "--json"], {
    encoding: "utf-8",
    timeout: 15_000,      // 旁路取值也不许无限等待(红线)
    stdio: ["ignore", "pipe", "ignore"],
  });
  const catalog = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  return ((catalog.workflows ?? []) as Array<Record<string, any>>)
    .map((item) => ({
      key: String(item.key ?? ""),
      // answers[0] 是内核对账用的原文;没有就退回展示名
      label: String(item.answers?.[0] ?? item.label ?? ""),
    }))
    .filter((item) => item.key && item.label);
}

/** 兜底:直接读 flow.json。够用但耦合内核文件布局,能问就别读。 */
function fromFlowJson(kernelRoot: string): WorkflowChoice[] {
  const path = join(kernelRoot, "flow", "flow.json");
  if (!existsSync(path)) return [];
  const flow = JSON.parse(readFileSync(path, "utf-8"));
  const step = flow?.steps?.workflow_select ?? {};
  const answers = (step.choice_answers ?? {}) as Record<string, string[]>;
  return ((step.choices ?? []) as unknown[])
    .map((key) => ({ key: String(key), label: answers[String(key)]?.[0] }))
    .filter((item): item is WorkflowChoice => !!item.label);
}

export function workflowChoices(kernelRoot: string | undefined): WorkflowChoice[] {
  if (!kernelRoot) return [];
  const cached = cache.get(kernelRoot);
  if (cached) return cached;
  let choices: WorkflowChoice[] = [];
  for (const read of [fromKernelCommand, fromFlowJson]) {
    try {
      choices = read(kernelRoot);
    } catch {
      choices = [];   // 读不动=不预选,不猜
    }
    if (choices.length) break;
  }
  cache.set(kernelRoot, choices);
  return choices;
}
