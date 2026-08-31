/**
 * 会话过程文档(材料页签"过程文档"子视图的数据面)。
 *
 * 形态对齐需求侧 artifacts.ts(多文档多页签),边界纪律同款:
 * - **白名单即边界**。能读的只有本模块自己扫出来的文件:name 先在
 *   集合里核对,再按集合里的名字读,绝不拿用户输入拼路径(路径穿越
 *   不是 404 的一种,是攻击)。
 * - **fail-open**。目录不可读、文件半路消失,都只让那一项缺席,返回
 *   空清单或 undefined——材料生成失败不拖垮会话页。
 * - 只扫会话根目录顶层的 .md:repo/ 是代码仓、skills/ 是平台物化的
 *   技能、local-logs/ 是日志,都不是过程文档;Agent 的落笔点就是
 *   会话根(与 issue-analysis.md 同层)。
 *
 * 过程问答也归这里:从 events.jsonl 投影出"人读的对话"(问答卡/用户
 * 决策/用户输入/检视意见,口径见 ADR-0008),现场页签管原始事件直播,
 * 这里管复盘阅读,两不替代。
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";

/** 分析报告:prompt 契约与 submit_analysis 门票的既定落点,过程文档
 * 里的固定首页。文件名是行为契约的一部分(技能/闸门/转正都认它),
 * 改名等于改协议——"分析报告"只是页签显示名。 */
export const ANALYSIS_DOC_NAME = "issue-analysis.md";

const DOC_MAX_BYTES = 512 * 1024;
const DOC_TRUNCATED_NOTE =
  "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见会话工作区文件)";

export interface IssueDocMeta {
  /** 稳定标识(会话根内的文件名),也是读取接口的取值。 */
  name: string;
  /** 给人看的短名:分析报告翻译,其余原样。 */
  label: string;
  bytes: number;
  modified_at: string;
}

/** 会话根目录顶层 .md 清单。分析报告固定首位,其余最近修改在前
 * (那是客观信号,不是判断)。fail-open:目录不可读给空清单。 */
export function listSessionDocuments(root: string): IssueDocMeta[] {
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const docs: IssueDocMeta[] = [];
  for (const name of names) {
    try {
      const info = statSync(join(root, name));
      if (!info.isFile()) continue;
      docs.push({
        name,
        label: name === ANALYSIS_DOC_NAME ? "分析报告" : name,
        bytes: info.size,
        modified_at: info.mtime.toISOString(),
      });
    } catch {
      // 文件在扫描途中消失:跳过这一项,别的照列。
    }
  }
  return docs.sort((left, right) => {
    if (left.name === ANALYSIS_DOC_NAME) return -1;
    if (right.name === ANALYSIS_DOC_NAME) return 1;
    return right.modified_at.localeCompare(left.modified_at);
  });
}

export interface IssueDocContent {
  meta: IssueDocMeta;
  content: string;
  /** 触顶截断时为 true:页面要如实告诉用户"这不是全文"。 */
  truncated: boolean;
}

/** 读一份过程文档。name 必须出现在清单里(零路径拼接),读取前再核对
 * 解析路径仍在会话现场之下(双保险)。缺失返回 undefined,调用方给人
 * 话空态,不抛错。 */
export function readSessionDocument(
  root: string,
  name: string,
): IssueDocContent | undefined {
  const wanted = String(name ?? "").trim();
  if (!wanted || wanted !== basename(wanted)) return undefined;
  const meta = listSessionDocuments(root).find((doc) => doc.name === wanted);
  if (!meta) return undefined;
  const path = join(root, wanted);
  const boundary = resolve(root);
  if (!resolve(path).startsWith(boundary + sep)) return undefined;
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    if (info.size <= DOC_MAX_BYTES) {
      return { meta, content: readFileSync(path, "utf-8"), truncated: false };
    }
    // 超长读前段:过程文档是"读文章",与日志排障读尾不同;按字节切会
    // 把 UTF-8 多字节字符切一半,末尾替换符直接抹掉——宁可少一个字。
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(DOC_MAX_BYTES);
      const read = readSync(handle, buffer, 0, DOC_MAX_BYTES, 0);
      const content = buffer.subarray(0, read).toString("utf-8")
        .replace(/\uFFFD+$/, "");
      return { meta, content: content + DOC_TRUNCATED_NOTE, truncated: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

// ---- 过程问答(事件账本 → 人读对话) ----

export interface IssueDialogueQuestion {
  question: string;
  options: string[];
}

/** 口径见 ADR-0008:复盘投影只留问答与用户输入——问答卡、用户决策
 * (卡答与闸答)、用户主动插话/续聊、检视意见;agent 的过程性发言
 * 不进。只追加、不回写。 */
export type IssueDialogueTurn =
  | { kind: "user"; ts: string; text: string; via?: string }
  | { kind: "card"; ts: string; questions: IssueDialogueQuestion[] }
  | { kind: "decision"; ts: string; decision: string; notes?: string;
      /** 平台闸决策随事件落账的问句快照(闸答完即从 issue.json 消失,
       * 历史闸的"问"半边只能随事件走);Agent 卡的问在前一张卡里。 */
      questions?: IssueDialogueQuestion[] }
  | { kind: "review"; ts: string; count: number; text: string };

/** 投影上限:对话是复盘阅读面,不是全量账本;触顶保留最新,如实标注。 */
const DIALOGUE_MAX_TURNS = 500;

/** 事件账本里的问答类事件 → 对话回合(ADR-0008 口径)。AskUserQuestion
 * 的 tool_requested 出"问答卡";human_decision 出"用户决策",平台闸的
 * 作答由 resolveGate 补记(带问句快照,闸卡问答对不缺半边);检视提交
 * 出"检视回合"。agent 发言与未知事件一律跳过:投影是旁路,不是第二
 * 本账。 */
export function projectDialogue(root: string): {
  turns: IssueDialogueTurn[];
  truncated: boolean;
} {
  const path = join(root, "events.jsonl");
  if (!existsSync(path)) return { turns: [], truncated: false };
  const turns: IssueDialogueTurn[] = [];
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let event: { kind?: unknown; ts?: unknown; payload?: unknown };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const ts = String(event.ts ?? "");
      switch (event.kind) {
        case "user_message":
          turns.push({
            kind: "user",
            ts,
            text: String(payload.text ?? ""),
            ...(payload.via === "interrupt" ? { via: "interrupt" } : {}),
          });
          break;
        case "tool_requested":
          if (String(payload.name ?? "") !== "AskUserQuestion") break;
          turns.push({ kind: "card", ts, questions: cardQuestions(payload.input) });
          break;
        case "human_decision": {
          const gate = payload.gate as { questions?: unknown } | undefined;
          const questions = cardQuestions(gate);
          turns.push({
            kind: "decision",
            ts,
            decision: String(payload.decision ?? ""),
            ...(payload.notes ? { notes: String(payload.notes) } : {}),
            ...(questions.length ? { questions } : {}),
          });
          break;
        }
        case "review_submitted":
          turns.push({
            kind: "review",
            ts,
            count: Number(payload.count ?? 0),
            text: String(payload.text ?? ""),
          });
          break;
        default:
          break;
      }
    }
  } catch {
    // 读不动(半行/权限):给已解析的部分,不拖垮页面。
  }
  const truncated = turns.length > DIALOGUE_MAX_TURNS;
  return {
    turns: truncated ? turns.slice(-DIALOGUE_MAX_TURNS) : turns,
    truncated,
  };
}

/** 问答卡的入参 → 问题清单(形状读不出来当没有;选项兼容字符串与
 * {code,label} 两种现场——码是投影层的事,人看文案)。平台闸的问句
 * 快照同走此路,一个形状。 */
function cardQuestions(input: unknown): IssueDialogueQuestion[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((item) => {
    const record = (item ?? {}) as { question?: unknown; options?: unknown };
    const options = Array.isArray(record.options)
      ? record.options
        .map((option) => typeof option === "string"
          ? option
          : String((option as { label?: unknown })?.label ?? ""))
        .filter(Boolean)
      : [];
    return { question: String(record.question ?? ""), options };
  });
}
