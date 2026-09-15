/**
 * 会话侧截图粘贴(2026-09-10 验证闸配套,与登记页同款红线):粘贴图片
 * → 上传落 staging(POST /issues/issue-image,content-addressed)→ 在
 * 光标处插入 ![截图](issue-images/<hash>.<ext>) 引用。图片本体不进
 * 消息文本,进的只有工作区相对路径——服务端在消息入口把引用从 staging
 * 提升到会话工作区,AI 侧 inspect_image 按该路径识图。
 *
 * 剪贴板两类来源待遇不同:截图软件放真实位图,paste 事件里有 image/*
 * 文件;网页右键「复制图像」Chromium 只交出 <img src> 引用(text/html)
 * 不给字节——桌面壳(如 ZCode)能直粘是因为读的是系统剪贴板,网页沙箱
 * 拿不到。兜底走异步 Clipboard API(navigator.clipboard.read,Chromium
 * 会把该位图重编码为 png 交还);被拒或非安全上下文(需 https/localhost)
 * 读不到时提示改用截图。
 */

import { useCallback, useState } from "react";
import { uploadIssueImage } from "../api";

/** 在 textarea 光标处插入 markdown(无 ref 时追加到末尾),返回
 * 下一段文本与光标落点——受控组件拿 next 设值,ref 存在时再摆焦点。 */
export function insertMarkdownAtCursor(
  textarea: HTMLTextAreaElement | null,
  current: string,
  markdown: string,
): { next: string; caret: number } {
  const start = textarea?.selectionStart ?? current.length;
  const end = textarea?.selectionEnd ?? current.length;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const needPrefix = before.length > 0 && !before.endsWith("\n");
  const needSuffix = after.length > 0 && !after.startsWith("\n");
  const insert = `${needPrefix ? "\n" : ""}${markdown}${needSuffix ? "\n" : ""}`;
  return { next: before + insert + after, caret: (before + insert).length };
}

/** 网页「复制图像」的 text/html 只有一个 <img> 且无正文文字时视为纯图
 * 粘贴;带文字的富文本混排不算,避免把普通复制误拦成图片上传。 */
function htmlIsImageOnly(html: string): boolean {
  if (!/<img[\s>]/i.test(html)) return false;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return body.querySelector("img") !== null && (body.textContent ?? "").trim() === "";
}

/** 异步 Clipboard API 兜底:浏览器在系统剪贴板里其实放了位图,只是 paste
 * 事件不交给网页;clipboard.read 拿得到。无该 API 或被拒则回 null。 */
async function readClipboardImageFile(): Promise<File | null> {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    return new File([blob], `paste.${type.split("/")[1] || "png"}`, { type });
  }
  return null;
}

const FALLBACK_HINT =
  "读不到网页复制图片的原图字节:剪贴板读取被拒或当前环境不支持(需 https/localhost),可改用截图后粘贴";

/** 截图粘贴钩子:onPaste 挂到 textarea;命中图片即上传并把 markdown
 * 交给调用方的 insert(受控文本由调用方持有)。uploading 供占位提示。 */
export function useIssueImagePaste(onError?: (message: string) => void) {
  const [uploading, setUploading] = useState(false);

  const onPaste = useCallback((
    event: { clipboardData?: { items?: Iterable<{ type: string; getAsFile(): File | null }>; getData?(type: string): string } ; preventDefault(): void },
    insert: (markdown: string) => void,
  ) => {
    const upload = (file: File) => {
      setUploading(true);
      uploadIssueImage(file).then((result) => {
        insert(`![截图](${result.path})`);
      }).catch((reason) => {
        onError?.(`图片上传失败:${String(reason instanceof Error ? reason.message : reason)}`);
      }).finally(() => setUploading(false));
    };

    const items = event.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        upload(file);
        return;
      }
    }

    // 网页右键「复制图像」兜底:拦下默认粘贴(否则只有 URL 文字进框),
    // 用异步 Clipboard API 取回位图再走同一条上传通道。
    const html = event.clipboardData?.getData?.("text/html") ?? "";
    if (!htmlIsImageOnly(html)) return;
    event.preventDefault();
    readClipboardImageFile().then((file) => {
      if (file) {
        upload(file);
        return;
      }
      onError?.(FALLBACK_HINT);
    }).catch(() => {
      onError?.(FALLBACK_HINT);
    });
  }, [onError]);

  return { uploading, onPaste };
}
