/**
 * 最小需求材料包：任意位置至少一份 Markdown，并可引用包内位图。
 *
 * ZIP 只在任务入口解包；进入任务后，Markdown 与图片都变成普通工作区
 * 文件，现有 Markdown 渲染器和 InspectImage 无需理解 ZIP。解析器只支持
 * ZIP 的 store/deflate 两种标准压缩方式，并完整防住越界路径、软链接、
 * 加密包与解压炸弹。
 */
import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { extname, join, posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { RequirementDocumentMeta } from "./requirementDocument.ts";

export const REQUIREMENT_BUNDLE_MAX_BYTES = 30 * 1024 * 1024;
export const REQUIREMENT_BUNDLE_MAX_FILES = 100;
export const REQUIREMENT_BUNDLE_ASSET_ROOT = ".mae-flow-work/requirement-assets";

export type RequirementImageMime =
  | "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface RequirementAssetMeta {
  path: string;
  source_path: string;
  mime_type: RequirementImageMime;
  bytes: number;
  digest: string;
}

export interface RequirementAsset extends RequirementAssetMeta {
  content: Buffer;
}

export interface ParsedRequirementBundle {
  bundle_name: string;
  requirement: string;
  document_name: string;
  assets: RequirementAsset[];
}

export class RequirementBundleError extends Error {}

const IMAGE_TYPES: Record<string, {
  mime: RequirementImageMime;
  extension: string;
  matches: (data: Buffer) => boolean;
}> = {
  ".png": {
    mime: "image/png", extension: ".png",
    matches: (data) => data.length >= 8
      && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  ".jpg": {
    mime: "image/jpeg", extension: ".jpg",
    matches: (data) => data.length >= 3
      && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  },
  ".jpeg": {
    mime: "image/jpeg", extension: ".jpg",
    matches: (data) => data.length >= 3
      && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  },
  ".webp": {
    mime: "image/webp", extension: ".webp",
    matches: (data) => data.length >= 12
      && data.subarray(0, 4).toString("ascii") === "RIFF"
      && data.subarray(8, 12).toString("ascii") === "WEBP",
  },
  ".gif": {
    mime: "image/gif", extension: ".gif",
    matches: (data) => data.length >= 6
      && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")),
  },
};

function safeZipPath(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\")
      || raw.startsWith("/") || /^[a-z]:/i.test(raw)) {
    throw new RequirementBundleError(`材料包包含不安全路径：${raw || "（空）"}`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === ".." || part === "." || !part)) {
    if (raw.endsWith("/") && parts.at(-1) === "") parts.pop();
    if (parts.some((part) => part === ".." || part === "." || !part)) {
      throw new RequirementBundleError(`材料包包含越界路径：${raw}`);
    }
  }
  return parts.join("/");
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequirementBundleError(`${label} 不是有效的 UTF-8 文本`);
  }
}

function findEndRecord(zip: Buffer): number {
  const floor = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= floor; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new RequirementBundleError("不是有效的 ZIP 文件");
}

function unzip(zip: Buffer): Map<string, Buffer> {
  if (zip.length > REQUIREMENT_BUNDLE_MAX_BYTES) {
    throw new RequirementBundleError("需求材料包不能超过 30 MB");
  }
  const end = findEndRecord(zip);
  const disk = zip.readUInt16LE(end + 4);
  const directoryDisk = zip.readUInt16LE(end + 6);
  const entries = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0) {
    throw new RequirementBundleError("不支持分卷 ZIP 材料包");
  }
  if (entries < 1 || entries > REQUIREMENT_BUNDLE_MAX_FILES) {
    throw new RequirementBundleError(`材料包文件数必须在 1～${REQUIREMENT_BUNDLE_MAX_FILES} 之间`);
  }
  if (directoryOffset + directorySize > end) {
    throw new RequirementBundleError("ZIP 目录损坏或不完整");
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new RequirementBundleError("ZIP 文件目录损坏");
    }
    const madeBy = zip.readUInt16LE(cursor + 4);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedBytes = zip.readUInt32LE(cursor + 20);
    const expandedBytes = zip.readUInt32LE(cursor + 24);
    const nameBytes = zip.readUInt16LE(cursor + 28);
    const extraBytes = zip.readUInt16LE(cursor + 30);
    const commentBytes = zip.readUInt16LE(cursor + 32);
    const externalAttributes = zip.readUInt32LE(cursor + 38);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameBytes);
    const name = safeZipPath(decodeUtf8(rawName, "ZIP 文件名"));
    cursor += 46 + nameBytes + extraBytes + commentBytes;
    if (flags & 1) throw new RequirementBundleError("不支持加密 ZIP 材料包");
    const unixMode = (madeBy >> 8) === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new RequirementBundleError(`材料包不能包含软链接：${name}`);
    }
    if (name.endsWith("/")) continue;
    if (method !== 0 && method !== 8) {
      throw new RequirementBundleError(`ZIP 使用了不支持的压缩方式：${name}`);
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new RequirementBundleError(`ZIP 文件记录损坏：${name}`);
    }
    const localNameBytes = zip.readUInt16LE(localOffset + 26);
    const localExtraBytes = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    if (dataOffset + compressedBytes > zip.length) {
      throw new RequirementBundleError(`ZIP 文件内容不完整：${name}`);
    }
    let content: Buffer;
    try {
      const source = zip.subarray(dataOffset, dataOffset + compressedBytes);
      content = method === 0 ? Buffer.from(source) : inflateRawSync(source, {
        maxOutputLength: REQUIREMENT_BUNDLE_MAX_BYTES,
      });
    } catch {
      throw new RequirementBundleError(`ZIP 文件解压失败：${name}`);
    }
    if (content.length !== expandedBytes) {
      throw new RequirementBundleError(`ZIP 文件大小校验失败：${name}`);
    }
    total += content.length;
    if (total > REQUIREMENT_BUNDLE_MAX_BYTES) {
      throw new RequirementBundleError("材料包解压后不能超过 30 MB");
    }
    if (files.has(name)) throw new RequirementBundleError(`材料包包含重名文件：${name}`);
    files.set(name, content);
  }
  return files;
}

function decodeBase64(value: unknown): Buffer {
  const encoded = String(value ?? "").trim();
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded.replace(/\s/g, ""))) {
    throw new RequirementBundleError("ZIP 内容不是有效的 Base64 数据");
  }
  return Buffer.from(encoded.replace(/\s/g, ""), "base64");
}

export function parseRequirementBundle(
  bundleName: unknown,
  contentBase64: unknown,
): ParsedRequirementBundle {
  const name = String(bundleName ?? "").trim();
  if (!name.toLowerCase().endsWith(".zip") || name.length > 160 || /[/\\\0]/.test(name)) {
    throw new RequirementBundleError("需求材料包必须是文件名不超过 160 个字符的 .zip 文件");
  }
  const files = unzip(decodeBase64(contentBase64));
  const markdownFiles = [...files.keys()]
    .filter((path) => path.toLowerCase().endsWith(".md"))
    .sort((left, right) => {
      const depth = (value: string) => value.split("/").length;
      return depth(left) - depth(right) || left.localeCompare(right, "zh-CN");
    });
  const documentName = markdownFiles[0];
  if (!documentName) {
    throw new RequirementBundleError("ZIP 中至少需要一份 .md 需求文档");
  }
  let requirement = decodeUtf8(files.get(documentName)!, documentName);
  if (!requirement.trim()) {
    throw new RequirementBundleError(`${documentName} 没有可用正文`);
  }

  const assets = new Map<string, RequirementAsset>();
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  requirement = requirement.replace(imagePattern, (whole, alt: string, target: string) => {
    let decodedTarget: string;
    try { decodedTarget = decodeURIComponent(target); } catch { decodedTarget = target; }
    if (/^(?:https?|data|file):/i.test(decodedTarget) || decodedTarget.startsWith("#")) {
      throw new RequirementBundleError(`图片必须是 ZIP 内的本地文件：${target}`);
    }
    const sourcePath = safeZipPath(posix.normalize(posix.join(
      posix.dirname(documentName), decodedTarget.replace(/^\.\//, ""))));
    const content = files.get(sourcePath);
    if (!content) throw new RequirementBundleError(`Markdown 引用的图片不存在：${target}`);
    const type = IMAGE_TYPES[extname(sourcePath).toLowerCase()];
    if (!type || !type.matches(content)) {
      throw new RequirementBundleError(`图片格式不支持或内容与扩展名不符：${sourcePath}`);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    const path = `${REQUIREMENT_BUNDLE_ASSET_ROOT}/${digest.slice(0, 24)}${type.extension}`;
    if (!assets.has(path)) {
      assets.set(path, {
        path, source_path: sourcePath, mime_type: type.mime,
        bytes: content.length, digest, content,
      });
    }
    return `![${alt}](${path})`;
  });
  return {
    bundle_name: name,
    requirement,
    document_name: documentName,
    assets: [...assets.values()],
  };
}

function writeNoFollow(path: string, content: Buffer): void {
  const descriptor = openSync(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
      | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, content); } finally { closeSync(descriptor); }
}

export function storeRequirementAssets(workspace: string, assets: RequirementAsset[]): void {
  let directory = workspace;
  for (const segment of [".mae-flow-work", "requirement-assets"]) {
    directory = join(directory, segment);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RequirementBundleError("需求图片目录不是安全的普通目录");
    }
  }
  for (const asset of assets) writeNoFollow(join(workspace, asset.path), asset.content);
}

export function loadRequirementAssets(
  workspace: string,
  meta: RequirementDocumentMeta | undefined,
): RequirementAsset[] {
  return (meta?.assets ?? []).map((asset) => {
    const content = readFileSync(join(workspace, asset.path));
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== asset.digest || content.length !== asset.bytes) {
      throw new RequirementBundleError(`需求图片已损坏：${asset.source_path}`);
    }
    return { ...asset, content };
  });
}

export function materializeRequirementAssets(
  taskWorkspace: string,
  runtimeWorkspace: string,
  meta: RequirementDocumentMeta | undefined,
): void {
  storeRequirementAssets(runtimeWorkspace, loadRequirementAssets(taskWorkspace, meta));
}

export function readRequirementAsset(
  workspace: string,
  meta: RequirementDocumentMeta | undefined,
  requestedPath: string,
): { meta: RequirementAssetMeta; content: Buffer } | undefined {
  const asset = meta?.assets?.find((item) => item.path === requestedPath);
  if (!asset) return undefined;
  const content = readFileSync(join(workspace, asset.path));
  return { meta: asset, content };
}
