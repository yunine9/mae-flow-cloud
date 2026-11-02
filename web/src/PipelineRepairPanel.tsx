import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { controlPipelineRepair, listPipelineRepairs, startPipelineRepair, type PipelineRepairRecord } from "./api";
import { repairIsActive } from "../../src/mrPipelineRepairTypes";
import { startVisiblePolling } from "./visiblePolling";
import { formatLocalDateTime } from "./time";

const STATUS_LABEL: Record<PipelineRepairRecord["status"], string> = {
  queued: "已排队", preparing: "准备中", repairing: "修复中", verifying: "流水线验证中",
  stopping: "正在停止", stopped: "已停止", passed: "流水线已通过", needs_attention: "需要处理",
};
const CHECK_LABEL = { success: "已通过", failed: "未通过", running: "运行中", pending: "等待运行", canceled: "已取消", skipped: "已跳过", not_run: "未运行" };
const DIMENSION_LABEL = { COMPILE: "编译", UT: "单元测试", CODECHECK: "代码质量" };

/** 导航与问题处理共用，数据与执行使用独立 MR 修复接口。 */
export function PipelineRepairPanel({ visible = true, onNavigateProfile }: { visible?: boolean; onNavigateProfile?: () => void }) {
  const [url, setUrl] = useState("");
  const [records, setRecords] = useState<PipelineRepairRecord[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [expanded, setExpanded] = useState("");
  const version = useRef(0);
  const alive = useRef(true);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, request: AbortController | undefined;
    const load = async () => {
      request?.abort(); request = new AbortController();
      const current = ++version.current;
      try {
        const next = await listPipelineRepairs(request.signal);
        if (stopped || current !== version.current) return;
        setRecords(next.records); setEnabled(next.enabled); setReason(next.reason); setError("");
      } catch (error) {
        if (!stopped && current === version.current && !request.signal.aborted) setError(error instanceof Error ? error.message : "读取修复记录失败");
      } finally { if (!stopped && current === version.current) setLoading(false); }
    };
    refresh.current = () => { void load(); };
    void load(); const stop = startVisiblePolling(() => void load(), 4000, document, { runOnStart: false });
    return () => { stopped = true; stop(); request?.abort(); refresh.current = () => {}; };
  }, [visible]);

  const apply = (record: PipelineRepairRecord) => {
    ++version.current;
    setRecords(rows => [record, ...rows.filter(row => row.id !== record.id)]);
    setExpanded(record.id);
  };
  const operate = async (key: string, action: () => Promise<PipelineRepairRecord>) => {
    if (pending) return;
    setPending(key); setError("");
    try { const next = await action(); if (alive.current) apply(next); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { if (alive.current) setPending(""); }
  };

  return <section hidden={!visible} aria-label="流水线修复" className="rounded-[12px] border border-line bg-surface p-6">
    <h2 className="m-0 text-lg font-semibold text-text-strong">修复已有 MR</h2>
    <form className="mt-5" onSubmit={event => { event.preventDefault(); if (url.trim() && enabled) void operate("start", () => startPipelineRepair(url.trim())); }}>
      <label htmlFor="pipeline-repair-url" className="mb-2 block text-sm font-medium text-text-strong">MR 链接</label>
      <div className="flex items-center gap-3">
        <Input id="pipeline-repair-url" type="url" required placeholder="粘贴 CodeHub MR 链接" value={url} onChange={event => setUrl(event.target.value)} className="min-w-0 flex-1" />
        <Button type="submit" disabled={!enabled || !url.trim() || !!pending}>{pending === "start" ? "正在启动…" : "开始修复"}</Button>
      </div>
      <p className="mb-0 mt-2 text-sm text-muted-foreground">自动修复编译、测试和代码质量失败，验证后推送原分支。MR 检视意见、审批与合入由你决定。</p>
    </form>
    {reason && <p role="status" className="mt-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{reason}</p>}
    {error && <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"><span>{error}</span><Button type="button" variant="outline" size="sm" onClick={() => refresh.current()}>刷新</Button></div>}
    <div className="mt-6 border-t border-line pt-4">
      <h3 className="m-0 text-sm font-medium text-muted-foreground">我的修复记录</h3>
      {loading && <p role="status" className="mt-4 text-sm text-muted-foreground">正在读取修复记录…</p>}
      {!loading && !records.length && <p className="mb-0 mt-4 text-sm text-muted-foreground">还没有修复记录，粘贴一个已有 MR 开始。</p>}
      <div aria-live="polite" className="divide-y divide-line">
        {records.map(record => <article key={record.id} aria-label={record.mr?.title ?? record.mr_url} className="py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1"><a href={record.mr_url} target="_blank" rel="noreferrer" className="break-all text-sm font-medium text-text-strong hover:underline">{record.mr?.title ?? record.mr_url}{record.mr && <span className="ml-2 font-normal text-muted-foreground">!{record.mr.iid}</span>}</a>
              <p className="mb-0 mt-1 text-sm text-muted-foreground">{record.message}</p>
            </div>
            <Badge variant={record.status === "passed" ? "success" : record.status === "needs_attention" ? "warning" : "secondary"}>{STATUS_LABEL[record.status]}</Badge>
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground"><span>{formatLocalDateTime(record.updated_at)}</span><span>已进行 {record.round} 轮修复</span>{record.mr && <code>{record.mr.sha.slice(0, 12)}</code>}</div>
          <div className="mt-3 flex items-center gap-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(expanded === record.id ? "" : record.id)} aria-expanded={expanded === record.id}>{expanded === record.id ? "收起过程" : "查看过程"}</Button>
            {repairIsActive(record.status)
              ? <Button type="button" variant="outline" size="sm" disabled={!!pending || record.status === "stopping"} onClick={() => void operate(record.id, () => controlPipelineRepair(record.id, "stop"))}>停止修复</Button>
              : record.status !== "passed" && <Button type="button" variant="outline" size="sm" disabled={!!pending || !enabled} onClick={() => void operate(record.id, () => controlPipelineRepair(record.id, "retry"))}>重试继续</Button>}
            {record.status === "needs_attention" && onNavigateProfile && /令牌|邮箱/.test(record.message) && <Button type="button" variant="link" size="sm" onClick={onNavigateProfile}>个人设置</Button>}
          </div>
          {expanded === record.id && <div className="mt-3 rounded-lg bg-muted p-3">
            {record.checks?.length ? <div className="mb-3 flex flex-wrap gap-3 text-xs text-muted-foreground">{record.checks.map((check, index) => <span key={index}>{DIMENSION_LABEL[check.dimension]} · {CHECK_LABEL[check.status]}</span>)}</div> : null}
            <ol className="m-0 list-none space-y-2 p-0 text-sm text-muted-foreground">{record.logs.map((log, index) => <li key={index} className="whitespace-pre-wrap break-words"><time className="mr-2 text-xs">{formatLocalDateTime(log.at)}</time>{log.text}</li>)}</ol>
          </div>}
        </article>)}
      </div>
    </div>
    <p className="mb-0 mt-5 border-t border-line pt-4 text-xs text-muted-foreground">离开页面后继续后台运行，从「问题处理 → 流水线修复」回来查看。执行服务重启后保留工作区，可重试继续。</p>
  </section>;
}
