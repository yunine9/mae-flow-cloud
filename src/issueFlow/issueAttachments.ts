/**
 * 登记附件上传落盘与工作区同步:手工登记(无单)时随现象描述上传的
 * 日志、压缩包等文件。
 *
 * 与 issueImages.ts(现象描述内嵌截图)同款架构红线:附件本体绝不进
 * 主模型上下文,进上下文的只有描述文本里的工作区相对路径引用;AI 拿
 * 路径自行读文件,压缩包用 bash 解。
 *
 * 数据流:
 *   前端选文件/粘贴/拖拽 → POST /issues/issue-attachment?name=<原始文件名>
 *     (raw binary 流式落 staging:边写边算哈希,超上限中途掐断,不整包
 *     进内存)→ <dataDir>/issue-attachment-staging/<sha256前16>.<ext>
 *     → 返回 path = "attachments/<hash>.<ext>"
 *     → textarea 光标处插入纯文本路径引用
 *   提交登记 → create() 调 syncIssueAttachmentsToWorkspace
 *     → 从 staging 复制到 <issue-root>/attachments/<hash>.<ext>
 *     → description 不改写(保持工作区相对路径,AI 直接读)
 *
 * staging 全局共享(content-addressed,哈希去重);无主文件不做 GC
 * (与截图 staging 同现状,已知欠账)。工作区副本按会话隔离。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/** 单个附件上限(日志/压缩包常见体积;上传是流式的,超限中途掐断,
 * 服务端不为它付整包内存)。 */
export const ISSUE_ATTACHMENT_MAX_BYTES = 500 * 1024 * 1024;

/** staging 目录名(全局共享,content-addressed)。 */
const STAGING_DIR = "issue-attachment-staging";

/** description 里引用的工作区相对目录名。 */
export const ISSUE_ATTACHMENT_DIR = "attachments";

/** 原始文件名 → 落盘扩展名:取最后一个点后的字母数字段(≤12 位)小写
 * 保留(.tar.gz 只留 gz,可读性够用);没有或不像就退 bin。扩展名只为
 * 人眼可读,AI 按内容读文件,不靠它判定类型。 */
export function attachmentExtension(filename: string | undefined): string {
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : "bin";
}

/**
 * 把上传请求体流式落 staging,返回工作区相对路径引用(进 description)。
 * content-addressed:同内容只存一份(哈希同名,已存在就丢弃本次落盘)。
 * 超上限中途拒绝并掐断请求,staging 不留残件。
 */
export async function stageIssueAttachmentStream(
  request: IncomingMessage,
  input: { dataDir: string; filename?: string; maxBytes?: number },
): Promise<{ path: string; bytes: number }> {
  const maxBytes = input.maxBytes ?? ISSUE_ATTACHMENT_MAX_BYTES;
  const ext = attachmentExtension(input.filename);
  const dir = join(input.dataDir, STAGING_DIR);
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const tmp = join(dir,
    `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const sink = createWriteStream(tmp);
  const countAndHash = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // 先掐请求源再拒绝:超限的大包体续传没有意义,流尽早停。
        request.destroy();
        callback(new Error(
          `附件超过 ${Math.round(ISSUE_ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB 上限`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(request, countAndHash, sink);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已清理即达目的 */ }
    throw error;
  }
  const filename = `${hash.digest("hex").slice(0, 16)}.${ext}`;
  const target = join(dir, filename);
  try {
    if (existsSync(target)) unlinkSync(tmp);
    else renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已清理即达目的 */ }
    throw error;
  }
  return { path: `${ISSUE_ATTACHMENT_DIR}/${filename}`, bytes };
}

/** 校验引用形态:必须是 attachments/<hex16>.<ext>,不含分隔符或 ..
 * 段(路径穿越拒之门外)。返回 { hash, ext } 或 undefined。 */
function parseIssueAttachmentPath(path: string): { hash: string; ext: string } | undefined {
  const match = new RegExp(
    `^${ISSUE_ATTACHMENT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    + `/([0-9a-f]{16})\\.([a-z0-9]{1,12})$`, "i")
    .exec(path);
  if (!match) return undefined;
  return { hash: match[1], ext: match[2].toLowerCase() };
}

/** description 里所有 attachments/<hash>.<ext> 引用(去重,按出现序)。 */
export function extractIssueAttachmentPaths(description: string | undefined): string[] {
  if (!description) return [];
  const pattern = new RegExp(
    `${ISSUE_ATTACHMENT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    + `/[0-9a-f]{16}\\.[a-z0-9]{1,12}`, "gi");
  const paths: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(description)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      paths.push(match[0]);
    }
  }
  return paths;
}

/**
 * 登记 create() 时调用:把 description 引用的附件从 staging 复制到
 * 会话工作区 attachments/ 目录。description 不改写——引用已是工作区
 * 相对路径,AI 直接读文件。
 *
 * fail-open:单个附件复制失败只跳过(可能 staging 已被清理),不阻断
 * 登记;调用方记日志。
 */
export function syncIssueAttachmentsToWorkspace(input: {
  description: string;
  dataDir: string;
  workspace: string;
  log?: (message: string) => void;
}): { copied: number; missing: number } {
  const paths = extractIssueAttachmentPaths(input.description);
  if (!paths.length) return { copied: 0, missing: 0 };

  const workspaceRoot = resolve(input.workspace);
  const targetDir = resolve(join(workspaceRoot, ISSUE_ATTACHMENT_DIR));
  if (!targetDir.startsWith(workspaceRoot + sep)) {
    // 越界保护:理论上不会触发(parseIssueAttachmentPath 已限定形态)。
    input.log?.(`[attachments] 目标目录越出工作区,跳过 ${paths.length} 个`);
    return { copied: 0, missing: paths.length };
  }
  mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let missing = 0;
  for (const path of paths) {
    const parsed = parseIssueAttachmentPath(path);
    if (!parsed) { missing += 1; continue; }
    const filename = `${parsed.hash}.${parsed.ext}`;
    const source = join(input.dataDir, STAGING_DIR, filename);
    const target = join(targetDir, filename);
    if (!existsSync(source)) {
      missing += 1;
      input.log?.(`[attachments] staging 缺失: ${path}`);
      continue;
    }
    if (!existsSync(target)) copyFileSync(source, target);
    copied += 1;
  }
  input.log?.(`[attachments] 同步 ${copied} 个到工作区,缺失 ${missing}`);
  return { copied, missing };
}
