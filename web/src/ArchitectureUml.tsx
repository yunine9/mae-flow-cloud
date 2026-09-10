import { useEffect, useRef, useState } from "react";

/** 服务端 SVG 仅作为图片显示；全屏被浏览器拒绝时仍可在页面内演示。 */
export function ArchitectureUml({ svg, title, syntaxError, onOpenStory }: {
  svg: string; title: string; syntaxError?: boolean; onOpenStory(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [presenting, setPresenting] = useState(false);
  const [zoom, setZoom] = useState<number>();
  const exit = () => {
    setPresenting(false);
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
  };
  useEffect(() => {
    const element = root.current;
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") exit(); };
    const onFullscreen = () => { if (!document.fullscreenElement) setPresenting(false); };
    document.addEventListener("keydown", onEscape);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  const enter = () => {
    setPresenting(true);
    void root.current?.requestFullscreen?.().catch(() => { /* 保留页面内全屏。 */ });
  };
  const src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  return <div ref={root} className={`architecture-uml${presenting ? " is-presenting ui-viewport-layer" : ""}`}>
    <div className="architecture-uml-toolbar">
      <strong>{title}</strong>
      <div role="group" aria-label="图片浏览">
        <button type="button" aria-label="缩小图片" onClick={() => setZoom((value) => Math.max(25, (value ?? 100) - 25))}>−</button>
        <button type="button" onClick={() => setZoom(undefined)}>适应画布</button>
        <button type="button" aria-label="放大图片" onClick={() => setZoom((value) => Math.min(300, (value ?? 100) + 25))}>＋</button>
        <button type="button" onClick={presenting ? exit : enter}>{presenting ? "退出全屏" : "演示 ⛶"}</button>
      </div>
    </div>
    {syntaxError && <p role="status">图源有语法错误，下面显示出错位置。<button type="button" onClick={onOpenStory}>查看 Story / 提意见 ↗</button></p>}
    <div className="architecture-uml-canvas" role="region" aria-label={`${title}，可滚动查看`} tabIndex={0}>
      <img src={src} alt={syntaxError ? `${title}：语法错误提示` : title}
        style={zoom ? { width: `${zoom}%`, maxWidth: "none", maxHeight: "none" } : undefined} />
    </div>
  </div>;
}
