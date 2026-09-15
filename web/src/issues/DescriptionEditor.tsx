import { useEffect, useRef, useState } from "react";
/**
 * 登记描述所见即所得编辑器(#184 票2):milkdown(ProseMirror 内核)
 * 的命令式封装——单面渲染,输入即所见,截图粘贴/拖拽后原地显示缩略。
 *
 * 边界(可整体替换的契约):对外只有三个口——markdown 值、onChange、
 * 图片上传钩子(上传后返回 issue-images/ 相对引用,插入光标位置)。
 * 存储世界(相对引用)与浏览器世界(预览 URL)的映射在 issueImageRef
 * 收敛:进入编辑器前 ref→URL,序列化出场时 URL→ref,description 管线
 * (AI 上下文/登记提交/staging 提取)永远只见相对引用。
 *
 * 待补充令牌(**【待补充】**)就是普通加粗,不做任何编辑器特殊化
 * (#184 拍板:不写编辑器插件,红色只出现在自有渲染面)。
 */
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { replaceAll } from "@milkdown/kit/utils";
import { issueImageUrl } from "../api";
import { displayUrlToRef, refToDisplayUrl } from "./issueImageRef";
import { cn } from "cn";

export function DescriptionEditor({
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
  const editorRef = useRef<Editor | null>(null);
  // 值回路防抖:onChange 出来的序列化文本记为"内部已知",父态回灌时
  // 只有真正外部变更(如润色替换)才 replaceAll,键入不回灌不打断光标。
  const internalRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const [empty, setEmpty] = useState(!value.trim());
  // 灯箱(#184 拍板方案1):编辑区内图片限高成缩略,点击看原图。
  const [zoom, setZoom] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const root = rootRef.current;
    if (!root) return;
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, refToDisplayUrl(value, issueImageUrl));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          const next = displayUrlToRef(markdown);
          internalRef.current = next;
          setEmpty(!next.trim());
          onChangeRef.current(next);
        });
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader: async (files: FileList, schema: any) => {
            const nodes = [];
            for (const file of Array.from(files)) {
              try {
                const ref = await uploadRef.current(file);
                const node = schema.nodes.image?.createAndFill?.({
                  src: issueImageUrl(ref), alt: "截图",
                });
                if (node) nodes.push(node);
              } catch {
                // 上传失败的用户提示归上传钩子所有(它自己 onError);
                // 这里只跳过该图,不让单图失败中断整批插入。
              }
            }
            return nodes;
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(upload);
    void editor.create()
      .then(() => {
        if (disposed) {
          void editor.destroy();
          return;
        }
        editorRef.current = editor;
      })
      .catch((reason) => {
        errorRef.current?.(`编辑器初始化失败:${
          String(reason instanceof Error ? reason.message : reason)}`);
      });
    return () => {
      disposed = true;
      editorRef.current = null;
      void editor.destroy().catch(() => undefined);
    };
    // 初始化只跑一次:后续值变更走 replaceAll 回路,不重建编辑器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变更(润色替换回填):整体重排;内部键入不回灌。
  useEffect(() => {
    if (value === internalRef.current) return;
    internalRef.current = value;
    setEmpty(!value.trim());
    const editor = editorRef.current;
    editor?.action(replaceAll(refToDisplayUrl(value, issueImageUrl)));
  }, [value]);

  // #231 换装:.issue-desc-editor 家族(style.css)退役,壳/占位/灯箱与
  // ProseMirror 生成内容(节点由编辑器内部建树,类挂不上去)一律用
  // [&_*] 任意变体直译配方——与 #230 润色预览的 [&_img]:max-h-[200px]
  // 同一做法。
  // 空态默认高度是表单的体感(2026-09-15 走查):描述是登记表单里预期
  // 最长的字段,空态给 min-h-40(约 6 行),与标题等单行字段拉开层次;
  // 输入后随内容自然长高,不封顶。
  return <div className={cn(
    "relative [&_.ProseMirror]:min-h-40[&_.ProseMirror]:rounded-lg [&_.ProseMirror]:border [&_.ProseMirror]:border-line [&_.ProseMirror]:bg-(--surface-muted) [&_.ProseMirror]:px-2.5 [&_.ProseMirror]:py-2 [&_.ProseMirror]:text-base [&_.ProseMirror]:leading-[1.65] [&_.ProseMirror]:text-text-strong [&_.ProseMirror]:outline-none [overflow-wrap:anywhere] focus-within:[&_.ProseMirror]:border-(--accent)",
    "[&_p]:mb-2 [&_:last-child]:mb-0 [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-2 [&_h1]:mt-2.5 [&_h2]:mt-2.5 [&_h3]:mt-2.5 [&_h1]:leading-snug [&_h2]:leading-snug [&_h3]:leading-snug",
    "[&_ul]:mb-2 [&_ol]:mb-2 [&_ul]:pl-6 [&_ol]:pl-6 [&_ul]:list-disc [&_ol]:list-decimal",
    "[&_img]:max-h-[200px] [&_img]:max-w-full [&_img]:h-auto [&_img]:w-auto [&_img]:cursor-zoom-in [&_img]:rounded-md [&_img]:border [&_img]:border-line",
    "[&_blockquote]:mb-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
    "[&_code]:rounded-sm [&_code]:bg-surface-3 [&_code]:font-mono [&_code]:text-[.88em]",
    "[&_pre]:mb-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-surface-2 [&_pre]:p-2.5 [&_pre]:text-[.86em] [&_pre]:leading-[1.6] [&_pre_code]:bg-transparent [&_pre_code]:p-0",
    "[&_table]:mb-2 [&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:border-line [&_td]:border-line [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:text-left [&_td]:text-left",
    "[&_a]:text-primary")}>
    <div ref={rootRef}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.tagName === "IMG") {
          setZoom(target.getAttribute("src"));
        }
      }}>
    </div>
    {empty && placeholderText
      && <span className="pointer-events-none absolute left-[11px] top-[9px] text-sm text-faint" aria-hidden="true">
        {placeholderText}
      </span>}
    {zoom && <div role="dialog" aria-label="截图原图" aria-modal="true"
      className="fixed inset-0 z-[80] flex cursor-zoom-out items-center justify-center bg-black/70 [&_img]:max-h-[92vh] [&_img]:max-w-[min(1200px,94vw)] [&_img]:rounded-lg [&_img]:bg-surface"
      onClick={() => setZoom(null)}>
      <img src={zoom} alt="截图原图" />
    </div>}
  </div>;
}
