import { useEffect, useState } from "react";
import { readTaskKnowledgeSource, type TaskKnowledgeResource, type TaskKnowledgeSource } from "./api";
import { OverlayDialog } from "./WarmupPanel";
import { Markdown } from "./markdown";
import { knowledgeOrigin } from "./knowledgeOrigin";
import "./knowledge-source.css";

export function KnowledgeSource({ taskId, resource, onClose }: {
  taskId: string; resource: TaskKnowledgeResource; onClose: () => void;
}) {
  const [source, setSource] = useState<TaskKnowledgeSource>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setSource(undefined); setError("");
    void readTaskKnowledgeSource(taskId, resource.id).then((value) => {
      if (active) setSource(value);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "原文读取失败，请稍后重试");
    });
    return () => { active = false; };
  }, [taskId, resource.id]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [onClose]);
  return <OverlayDialog ariaLabel={`知识原文：${resource.name}`} title={resource.name} onClose={onClose}>
    <section className="knowledge-source-content">
      <p className="knowledge-source-origin">{knowledgeOrigin(resource)}</p>
      <code>{resource.path}</code>
      {error ? <p role="alert">{error}</p> : source ? <>
        <p className="knowledge-source-version">{source.version_changed
          ? "当前文件与任务记录的版本不同，以下展示当前原文。"
          : "当前可读取的原文；知识使用时间见工作台记录。"}</p>
        <Markdown text={source.content} />
      </> : <p role="status">正在读取原文…</p>}
    </section>
  </OverlayDialog>;
}
