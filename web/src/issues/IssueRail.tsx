/**
 * 会话页右侧 NEXT ACTION 常驻栏:五态互斥(待答复 / 已出结论 / 运行中 /
 * 空闲 / 被打断),底部固死 归档收口 + 取消。
 *
 * 布局改编自任务工作台的决策栏,动作语义全部承旧版:answerIssue /
 * steerIssue / replyIssue / controlIssue 及其 window.confirm、按状态禁用
 * 的逻辑原样保留,只是从底部 composer 挪到了决策位置。会话终局
 * (已归档/已取消/失败)没有"下一步",给一张静默卡说明状态即可。
 */
import { useState } from "react";
import { ISSUE_STAGE_TEXT, type IssueDetail } from "../api";
import { IssueDecisionCard } from "./IssueDecisionCard";

export function IssueRail({ detail, busy, onAnswer, onReply,
  onSteer, onArchive, onCancel, onOpenDoc }: {
  detail: IssueDetail;
  busy: boolean;
  /** 提交问题卡答复;返回 true 表示成功。 */
  onAnswer: (decision: string, notes?: string) => Promise<boolean>;
  /** 继续对话(idle/interrupted);返回 true 表示成功。 */
  onReply: (text: string) => Promise<boolean>;
  /** 运行中插话;返回 true 表示成功。 */
  onSteer: (text: string) => Promise<boolean>;
  onArchive: () => void;
  onCancel: () => void;
  /** 打开左侧结论文档页签。 */
  onOpenDoc: () => void;
}) {
  // waiting 与 waiting_user 必须同时成立才画决策卡,轮询半拍的状态不画。
  const waiting = detail.status === "waiting_user" ? detail.waiting : undefined;
  const doneIdle = !waiting && detail.stage === "done" && detail.status === "idle";

  return <aside className="issue-rail">
    <div className="issue-rail-head"><span>Next Action</span></div>
    <div className="issue-rail-body">
      {waiting && <IssueDecisionCard waiting={waiting} busy={busy} onAnswer={onAnswer} />}
      {!waiting && doneIdle && <div className="issue-rail-card is-done">
        <strong>AI 已给出结论</strong>
        <p>归档收口即正式关闭这份研究现场。</p>
        <button type="button" className="issue-rail-primary"
          disabled={busy}
          onClick={onArchive}>归档收口</button>
        {/* 承旧 issue-done-hint 的引导文案;追问入口在左侧对话页签。 */}
        <small>要继续追问就在左侧对话页签发言,把阶段从「问题闭环」切回对应环节即可。</small>
      </div>}
      {!waiting && !doneIdle && detail.status === "running" && <div className="issue-rail-card is-running">
        <strong><i className="issue-rail-pulse" aria-hidden />AI 正在推进</strong>
        <p>{ISSUE_STAGE_TEXT[detail.stage]}
          {detail.stage_note ? ` · ${detail.stage_note}` : ""}</p>
        <RailInput
          kind="steer"
          disabled={busy}
          placeholder="会话运行中——插话(当前工具调用完成后送达)"
          actionLabel="插话"
          submit={onSteer}
        />
      </div>}
      {!waiting && !doneIdle && detail.status === "idle" && <div className="issue-rail-card is-idle">
        <strong>轮到你了</strong>
        <p>补充信息、调整方向,或让 AI 继续。</p>
        <RailInput
          kind="reply"
          disabled={busy}
          placeholder="继续对话…"
          actionLabel="发送"
          primary
          submit={onReply}
        />
      </div>}
      {!waiting && !doneIdle && detail.status === "interrupted"
        && <div className="issue-rail-card is-resume">
          <strong>服务重启打断了会话</strong>
          <p>现场还在——发消息即可续聊。</p>
          <RailInput
            kind="reply"
            disabled={busy}
            placeholder="从现场继续…"
            actionLabel="发送"
            submit={onReply}
          />
        </div>}
      {!waiting && !doneIdle
        && ["archived", "canceled", "failed"].includes(detail.status)
        && <div className="issue-rail-card is-ended">
          <strong>会话已结束({detail.status === "failed" ? "失败"
            : detail.status === "canceled" ? "已取消" : "已归档"})</strong>
          <p>没有待办动作;结论与账单见左侧页签。</p>
        </div>}
    </div>
    <footer className="issue-rail-foot">
      {detail.has_analysis && <button type="button" className="issue-analysis-flag"
        title="查看结论文档"
        onClick={onOpenDoc}>
        结论文档 issue-analysis.md 已产出 →
      </button>}
      {/* 同控制/确认/禁用条件与旧 composer-actions 完全一致 */}
      <div className="issue-rail-actions">
        <button type="button" disabled={busy || ["archived", "canceled", "failed"]
          .includes(detail.status)} onClick={onArchive}>归档收口</button>
        <button type="button" className="danger" disabled={busy
          || ["archived", "canceled", "failed"].includes(detail.status)}
          onClick={onCancel}>取消</button>
      </div>
    </footer>
  </aside>;
}

/** 栏内输入行:插话是单行 input,续聊是小 textarea;提交后清空的时机
 * 放在 success 之后(perform 返回 true),失败保字与旧行为一致。
 * 导出复用:done+idle 时右栏被归档卡占据,对话页签末尾的续聊入口
 * 也用同一行输入。 */
export function RailInput({ kind, placeholder, actionLabel, disabled, primary, submit }: {
  kind: "steer" | "reply";
  placeholder: string;
  actionLabel: string;
  disabled: boolean;
  primary?: boolean;
  submit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const send = async () => {
    if (!text.trim() || disabled) return;
    if (await submit(text.trim())) setText("");
  };
  return <div className={`issue-rail-input kind-${kind}`}>
    {kind === "steer"
      ? <input value={text} placeholder={placeholder} disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void send(); }} />
      : <textarea rows={3} value={text} placeholder={placeholder} disabled={disabled}
          onChange={(event) => setText(event.target.value)} />}
    <button type="button" className={primary ? "primary" : ""}
      disabled={!text.trim() || disabled} onClick={() => void send()}>
      {actionLabel}
    </button>
  </div>;
}
