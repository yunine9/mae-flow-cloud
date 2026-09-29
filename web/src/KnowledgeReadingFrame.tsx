import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function KnowledgeReadingFrame({ children, actions, title }: { children: ReactNode; actions?: ReactNode; title: string }) {
  const [fullscreen, setFullscreen] = useState(false), [showTree, setShowTree] = useState(true);
  const body = <section className={`domain-file-workspace ${showTree ? "" : "tree-hidden"}`} aria-label="领域知识审查工作区" style={{ height: fullscreen ? "100%" : "max(500px, calc(100dvh - 340px))" }}>
    <header className="research-review-toolbar">
      <Button variant="ghost" size="sm" onClick={() => setShowTree(!showTree)}>{showTree ? "收起目录" : "展开目录"}</Button>
      <strong className="mr-auto">{title}</strong>{actions}
      <Button variant="outline" size="sm" onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? "退出全屏" : "全屏阅读"}</Button>
    </header>{children}
  </section>;
  return <>{!fullscreen && body}<Dialog open={fullscreen} onOpenChange={setFullscreen}>
    <DialogContent showCloseButton={false} style={{ animation: "none" }} className="tw-root h-[100dvh] w-[100vw] max-w-none gap-0 overflow-hidden rounded-none p-0 sm:max-w-none">
      <DialogTitle className="sr-only">领域知识全屏阅读</DialogTitle>{fullscreen && body}
    </DialogContent>
  </Dialog></>;
}
