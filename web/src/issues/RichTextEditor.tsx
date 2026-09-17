/**
 * 登记描述 Quill 富文本编辑器(#271 修订版,2026-09-17 拍板):工具栏
 * 输入形态,dts-auto 同款;存储世界不变——对外仍是 markdown 契约
 * (value/onChange),内部进出各一次 md↔HTML 转换(mdHtml.ts),图片
 * 依旧落暂存体系(issue-images/ 相对引用),不学 base64 内联(description
 * 每回合全量进 AI 上下文,base64 会把上下文撑爆)。
 *
 * 粘贴拦截随行(#276):data:/http(s) 外链/file:/// 三路转存逻辑原样
 * 搬入——剪贴板里有字节(data:/位图)时本地转存,没字节的外链走后端
 * 代理(DTS 域经网关同源凭据)。回退:改 descriptionEditorChoice.ts
 * 常量重新构建即切回 milkdown,存储零迁移。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Quill from "quill";
import "quill/dist/quill.snow.css";
import { Loader2 } from "lucide-react";
import { issueImageUrl } from "../api";
import { proxyIssueImage } from "../api";
import {
  markdownToEditorHtml, editorHtmlToMarkdown,
} from "./mdHtml";
import {
  pasteImageFile, classifyExternalImageSrc, isHostedImageSrc,
  transferFailHint,
} from "./useIssueImagePaste";
import { cn } from "cn";

/** 编辑器 src(预览 URL 或相对引用)→ 存储引用。 */
function srcToRef(src: string): string {
  if (src.startsWith("issue-images/")) return src;
  try {
    const url = new URL(src, globalThis.location?.origin ?? "http://x");
    const path = url.searchParams.get("path");
    if (path?.startsWith("issue-images/")) return path;
  } catch { /* 相对引用等非法 URL 原样 */ }
  return src;
}

/** 存储引用 → 编辑器 src;非托管引用原样。 */
function refToSrc(src: string): string {
  return src.startsWith("issue-images/") ? issueImageUrl(src) : src;
}

export function RichTextEditor({
  value,
  onChange,
  onUploadImage,
  onError,
  placeholderText,
}: {
  /** markdown(存储世界,相对引用)。 */
  value: string;
  /** 内容变更(已映射回相对引用,可直接进 description)。 */
  onChange: (next: string) => void;
  /** 图片上传:落 staging,返回 issue-images/ 相对引用。上传失败由
   * 钩子自行向用户报告(编辑器只跳过该图,不代发第二遍)。 */
  onUploadImage: (file: File) => Promise<string>;
  /** 仅编辑器初始化失败时上报(上传路径不走这里)。 */
  onError?: (message: string) => void;
  placeholderText?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const quillRef = useRef<Quill | null>(null);
  // 值回路防抖:onChange 出来的 markdown 记为"内部已知",父态回灌时
  // 只有真正外部变更(如草稿回读/提交后重置)才整体覆盖,键入不回灌。
  const internalRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  // 上传进行态浮层:与旧编辑器同款契约(截图上传中…),位图/data:/
  // 外链代理三条上传路共用计数。
  const [pendingUploads, setPendingUploads] = useState(0);
  const trackPending = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      setPendingUploads((count) => count + 1);
      try {
        return await run();
      } finally {
        setPendingUploads((count) => Math.max(0, count - 1));
      }
    }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || quillRef.current) return;
    const quill = new Quill(root, {
      theme: "snow",
      placeholder: placeholderText,
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ["bold", "italic", "code", "blockquote", "code-block"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["link", "clean"],
        ],
      },
    });
    quillRef.current = quill;
    quill.root.innerHTML = markdownToEditorHtml(value, refToSrc);
    quill.on("text-change", () => {
      const next = editorHtmlToMarkdown(
        quill.getSemanticHTML(), srcToRef);
      if (next === internalRef.current) return;
      internalRef.current = next;
      onChangeRef.current(next);
    });
    return () => {
      quillRef.current = null;
      quill.off("text-change");
    };
    // 初始化只跑一次;后续值变更走下方回路。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变更:整体重排;内部键入不回灌。
  useEffect(() => {
    if (value === internalRef.current) return;
    internalRef.current = value;
    const quill = quillRef.current;
    if (quill) quill.root.innerHTML = markdownToEditorHtml(value, refToSrc);
  }, [value]);

  // 外部图片粘贴/拖拽转存(#276 随行):剪贴板无位图文件、text/html
  // 带 <img> 时按 src 协议三路转存;有位图文件(截图/右键复制图像)
  // 时直接上传。插入的永远是 issue-images/ 相对引用的预览 URL。
  useEffect(() => {
    const root = quillRef.current?.root;
    if (!root) return;
    const uploadAndInsert = async (file: File, index: number) => {
      try {
        const ref = await trackPending(() => uploadRef.current(file));
        quillRef.current?.insertEmbed(index, "image", issueImageUrl(ref));
      } catch {
        // 上传失败的用户提示归上传钩子所有(它自己 onError);这里只跳过。
      }
    };
    const transferAndPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const files: File[] = [];
      for (const item of Array.from(data.items)) {
        if (item.type.startsWith("image/") && item.getAsFile()) {
          files.push(item.getAsFile()!);
        }
      }
      if (files.length) {
        event.preventDefault();
        event.stopPropagation();
        const index = quillRef.current?.getSelection(true)?.index
          ?? quillRef.current?.getLength() ?? 0;
        void (async () => {
          for (const file of files) await uploadAndInsert(file, index);
        })();
        return;
      }
      const html = data.getData("text/html") ?? "";
      if (!html) return;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const pending = Array.from(doc.querySelectorAll("img"))
        .map((img) => ({ img, src: img.getAttribute("src") ?? "" }))
        .filter(({ src }) => !isHostedImageSrc(src));
      if (!pending.length) return;
      // 拦截必须在同步阶段:先按住默认粘贴,再异步逐张转存。
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        let failed = 0;
        for (const { img, src } of pending) {
          const kind = classifyExternalImageSrc(src);
          if (kind === "data") {
            let blob: Blob;
            try {
              blob = await (await fetch(src)).blob();
            } catch {
              img.remove();
              failed += 1;
              continue;
            }
            try {
              const ref = await trackPending(() =>
                uploadRef.current(pasteImageFile(blob)));
              img.setAttribute("src", issueImageUrl(ref));
            } catch {
              img.remove();
            }
          } else if (kind === "external") {
            try {
              const result = await trackPending(() => proxyIssueImage(src));
              img.setAttribute("src", issueImageUrl(result.path));
            } catch {
              img.remove();
              failed += 1;
            }
          } else {
            img.remove();
            failed += 1;
          }
        }
        quillRef.current?.clipboard.dangerouslyPasteHTML(doc.body.innerHTML);
        if (failed > 0) errorRef.current?.(transferFailHint(failed));
      })();
    };
    root.addEventListener("paste", transferAndPaste, true);
    return () => root.removeEventListener("paste", transferAndPaste, true);
  }, [trackPending]);

  return <div className={cn(
    "relative [&_.ql-toolbar]:rounded-lg [&_.ql-toolbar]:border-line",
    "[&_.ql-container]:rounded-b-lg [&_.ql-container]:border [&_.ql-container]:border-line",
    "[&_.ql-editor]:min-h-[500px] [&_.ql-editor]:max-h-[70vh] [&_.ql-editor]:overflow-y-auto",
    "[&_.ql-editor]:text-base [&_.ql-editor]:leading-[1.65] [&_.ql-editor.ql-empty::before]:text-faint")}>
    <div ref={rootRef} />
    {pendingUploads > 0 && <span role="status"
      className="absolute right-2 top-12 z-10 flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />截图上传中…
    </span>}
  </div>;
}
