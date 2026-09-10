/**
 * PlantUML 图:服务端用参考实现出 SVG,这里只负责显示。
 *
 * 曾经这里是 1,562 行手搓解析器(时序/类/活动/拓扑各一套),八月以来专修
 * "又不认某个写法"的提交 7 笔。PlantUML 语法面没有正式文法,补不完;
 * 用户 2026-09-06 拍板改用 jar 出图、手搓渲染器删除。
 *
 * 显示用 <img data:svg>:SVG 里不会执行脚本,也不把服务端 SVG 直接注入 DOM。
 * 出不了图(没有 Java、超时)原样显示源码并说明原因;语法错误时显示 PlantUML
 * 自己画的错误图(标出错行),源码折在下面方便对照。
 */
import { useEffect, useRef, useState } from "react";
import { renderPlantUml, type PlantUmlRender } from "./api";

/** 同一份源码在一次页面生命周期里只出一次图(切换材料、滚动都会重挂组件)。 */
const memo = new Map<string, Promise<PlantUmlRender>>();
type FullscreenDocument = {
  fullscreenElement?: unknown;
  addEventListener(type: string, listener: (event: { key?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { key?: string }) => void): void;
  exitFullscreen(): Promise<void>;
};
type FullscreenElement = HTMLElement & { requestFullscreen?: () => Promise<void> };
const fullscreenDocument = () => (globalThis as unknown as { document: FullscreenDocument }).document;

function render(source: string): Promise<PlantUmlRender> {
  let pending = memo.get(source);
  if (!pending) {
    pending = renderPlantUml(source).catch((cause) => {
      memo.delete(source);
      return { error: cause instanceof Error ? cause.message : String(cause) } as PlantUmlRender;
    });
    memo.set(source, pending);
  }
  return pending;
}

export function PlantUml({ source }: { source: string }) {
  const [result, setResult] = useState<PlantUmlRender | undefined>();
  const root = useRef<FullscreenElement>(null);
  const [presenting, setPresenting] = useState(false);
  useEffect(() => {
    let alive = true;
    setResult(undefined);
    void render(source).then((value) => { if (alive) setResult(value); });
    return () => { alive = false; };
  }, [source]);
  useEffect(() => {
    const doc = fullscreenDocument();
    const fullscreenChanged = () => { if (!doc.fullscreenElement) setPresenting(false); };
    const escape = (event: { key?: string }) => {
      if (event.key !== "Escape" || !presenting) return;
      setPresenting(false);
      if (doc.fullscreenElement === root.current) void doc.exitFullscreen().catch(() => {});
    };
    doc.addEventListener("fullscreenchange", fullscreenChanged);
    doc.addEventListener("keydown", escape);
    return () => {
      doc.removeEventListener("fullscreenchange", fullscreenChanged);
      doc.removeEventListener("keydown", escape);
    };
  }, [presenting]);

  if (!result) {
    return <div className="plantuml-unsupported" role="status"><span>正在出图…</span></div>;
  }
  if (!result.svg) {
    return <div className="plantuml-unsupported">
      <strong>这段 PlantUML 暂时出不了图</strong>
      <span>{result.error ?? "未知原因"}。已保留源码。</span>
      <pre className="md-block-code"><code>{source}</code></pre>
    </div>;
  }
  const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(result.svg)))}`;
  const togglePresentation = () => {
    const doc = fullscreenDocument();
    if (presenting) {
      setPresenting(false);
      if (doc.fullscreenElement === root.current) void doc.exitFullscreen().catch(() => {});
      return;
    }
    setPresenting(true);
    void root.current?.requestFullscreen?.().catch(() => { /* 页面内全屏仍可用。 */ });
  };
  return <figure ref={root} className={`plantuml-figure${result.syntax_error ? " syntax-error" : ""}${presenting ? " is-presenting ui-viewport-layer" : ""}`}>
    <div className="plantuml-toolbar">
      <span>PlantUML</span>
      <button type="button" onClick={togglePresentation}>{presenting ? "退出全屏" : "查看大图 ⛶"}</button>
    </div>
    <div className="plantuml-viewport" role="region" aria-label="PlantUML 图，可滚动查看完整内容" tabIndex={0}>
      <img src={dataUrl} alt={result.syntax_error ? "PlantUML 语法错误提示图" : "PlantUML 图"} />
    </div>
    {result.syntax_error && <details className="plantuml-source">
      <summary>PlantUML 判定这段源码有语法错误,图上标了出错行;展开看源码</summary>
      <pre className="md-block-code"><code>{source}</code></pre>
    </details>}
  </figure>;
}
