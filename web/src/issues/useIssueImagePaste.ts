/**
 * 会话侧截图粘贴(2026-09-10 验证闸配套,与登记页同款红线):粘贴图片
 * → 上传落 staging(POST /issues/issue-image,content-addressed)→ 在
 * 光标处插入 ![截图](issue-images/<hash>.<ext>) 引用。图片本体不进
 * 消息文本,进的只有工作区相对路径——服务端在消息入口把引用从 staging
 * 提升到会话工作区,AI 侧 inspect_image 按该路径识图。
 */

import { useCallback, useState } from "react";
import { uploadIssueImage } from "../api.ts";

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

/** 截图粘贴钩子:onPaste 挂到 textarea;命中图片即上传并把 markdown
 * 交给调用方的 insert(受控文本由调用方持有)。uploading 供占位提示。 */
export function useIssueImagePaste(onError?: (message: string) => void) {
  const [uploading, setUploading] = useState(false);

  const onPaste = useCallback((
    event: { clipboardData?: { items?: Iterable<{ type: string; getAsFile(): File | null }> ; preventDefault(): void } },
    insert: (markdown: string) => void,
  ) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      setUploading(true);
      uploadIssueImage(file).then((result) => {
        insert(`![截图](${result.path})`);
      }).catch((reason) => {
        onError?.(`图片上传失败:${String(reason instanceof Error ? reason.message : reason)}`);
      }).finally(() => setUploading(false));
      return;
    }
  }, [onError]);

  return { uploading, onPaste };
}
