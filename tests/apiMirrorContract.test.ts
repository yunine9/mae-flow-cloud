/**
 * 服务端任务摘要与前端镜像逐字段对账(静态,不起服务)。
 *
 * 为什么要有:前端"不推断状态,一切文案来自任务 API 镜像",镜像就是
 * web/src/api.ts 里手抄的一份 TaskSummary。服务端加字段、镜像忘了补,页面
 * 读到 undefined 静默失效(4c149aa 补 feedback 镜像、本轮补 stall_class,
 * 都是事后发现)。问题流那边 176b0e0 已经有"服务端真实投影与 api.ts 镜像
 * 逐字段对账",需求任务这边没有——本文件补上:服务端 TaskSummary 的每个
 * 字段(含内联对象的子字段)都必须在镜像里有同名字段。
 *
 * 只查"服务端有、镜像没有";镜像多出来的字段另有前端契约管。类型是否一致
 * 不在此查(两边类型写法不同,机械比对噪声大),名字对上是最低要求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function interfaceFields(file: string, name: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"), ts.ScriptTarget.Latest, true);
  // 同文件里的具名 interface / 对象字面量别名:属性引用到它们时也要下钻
  // (镜像把 prepush_runtime 抽成了 PrepushRuntime 接口,不下钻就是假阳性)。
  const named = new Map<string, ts.NodeArray<ts.TypeElement>>();
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) named.set(node.name.text, node.members);
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) named.set(node.name.text, node.type.members);
  });
  const fields = new Set<string>();
  const membersOf = (type: ts.TypeNode | undefined, seen: Set<string>): ts.NodeArray<ts.TypeElement> | undefined => {
    if (!type) return undefined;
    if (ts.isTypeLiteralNode(type)) return type.members;
    if (ts.isArrayTypeNode(type)) return membersOf(type.elementType, seen);
    if (ts.isParenthesizedTypeNode(type)) return membersOf(type.type, seen);
    if (ts.isUnionTypeNode(type)) {
      for (const part of type.types) { const found = membersOf(part, seen); if (found) return found; }
      return undefined;
    }
    if (ts.isTypeReferenceNode(type)) {
      const ref = type.typeName.getText(source);
      if ((ref === "Array" || ref === "ReadonlyArray") && type.typeArguments?.[0]) return membersOf(type.typeArguments[0], seen);
      if (named.has(ref) && !seen.has(ref)) { seen.add(ref); return named.get(ref); }
    }
    return undefined;
  };
  const collect = (members: ts.NodeArray<ts.TypeElement>, prefix: string, seen: Set<string>) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const key = prefix + (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source));
      fields.add(key);
      const nested = membersOf(member.type, new Set(seen));
      if (nested) collect(nested, `${key}.`, new Set([...seen, key]));
    }
  };
  assert.ok(named.has(name), `${file} 里找不到 interface ${name}`);
  collect(named.get(name)!, "", new Set([name]));
  return fields;
}

/** 服务端有、镜像刻意不镜像的字段:每一条都要写清为什么前端不需要。 */
const NOT_MIRRORED = new Set<string>([
  "ui_fixture",                       // 只在 UI 场景库冻结状态时写,正式任务永远没有
  "workspace",                        // 服务端现场绝对路径,页面不该拿到宿主路径
  "origin",                           // 小鲁班手机审批卡的来源域,网页不用
  "delivery_scope_exemptions",        // 主责任人放行过的越界文件,服务端复判用
  "repository_supplement_resolved",   // 仓库补充信息已解析的内部标记
  "delivery.mr_id",                   // 平台内部编号;页面用 mr_url
  "delivery.source_branch",           // 分支对是门禁查询与冲突修复的参数
  "delivery.target_branch",
  "delivery.checks",                  // 逐项流水线结果由内核裁决;页面看 pipeline 汇总
  "delivery.git_push",                // 推送收据:内核比对三方 SHA 用
  "delivery.foreign_commits",         // 派给修复 Agent 的"别回滚"清单
  "delivery.last_reviewed_head",      // 复检卡的锚点,服务端算复检范围用
  "delivery.sha",                     // 验证过的提交,页面看 mr_url / pipeline
  "delivery.attested",                // 内核 quality.pipeline 的镜像,服务端门禁用
  "delivery.verify_deadline",         // 自愈预算到期时刻,重启对表用
  "delivery.evidence_gap.failure_log", // 原始日志走材料接口,不塞进摘要
  "delivery.evidence_gap.retry_deadline",
  "delivery.evidence_gap.human_evidence",
  "delivery.evidence_gap.human_dimensions",
  "delivery.loop.workspace_review_pending", // 修复环内部刹车锚与派单指纹
  "delivery.loop.last_sha",
  "delivery.loop.review_ids",
  "delivery.loop.replied_ids",
  "delivery.loop.workspace_review_receipt_retry_for",
  "delivery.loop.feedback_receipt_retry_for",
  "delivery.review_processing_dispatched_for",
  "requirement_graph.review_snapshot",        // 拆分方案确认时封存的指纹(sha256/waiting_id),防篡改核对用
  "requirement_graph.reviewed_plan_revisions", // 已检视过的方案版本号,服务端判"要不要再举卡"
]);

test("任务摘要:服务端 TaskSummary 的每个字段都在 api.ts 镜像里", () => {
  const server = interfaceFields("src/taskService.ts", "TaskSummary");
  const mirror = interfaceFields("web/src/api.ts", "TaskSummary");
  const missing = [...server].filter((field) => !mirror.has(field) && !NOT_MIRRORED.has(field)
    // 父字段已豁免的,子字段一并豁免
    && ![...NOT_MIRRORED].some((allowed) => field.startsWith(`${allowed}.`)));
  assert.deepEqual(missing, [],
    `服务端有而前端镜像没有的字段(补进 web/src/api.ts,或写明理由加进 NOT_MIRRORED): ${missing.join(", ")}`);
  const stale = [...NOT_MIRRORED].filter((field) => !server.has(field));
  assert.deepEqual(stale, [], `豁免表里有服务端已经不存在的字段: ${stale.join(", ")}`);
});
