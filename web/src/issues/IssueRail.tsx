/**
 * 会话页右侧 NEXT ACTION 常驻栏:六态互斥(待答复 / 已出结论 / 运行中 /
 * 空闲 / 被打断 / 挂起待关联),底部固死 归档收口 + 取消。
 *
 * 布局改编自任务工作台的决策栏,动作语义全部承旧版:answerIssue /
 * steerIssue / replyIssue / controlIssue 及其 window.confirm、按状态禁用
 * 的逻辑原样保留,只是从底部 composer 挪到了决策位置。会话终局
 * (已归档/已取消/失败)没有"下一步",给一张静默卡说明状态即可。
 * 挂起(suspended,固定流程无单场景结论为"是问题")的下一步是关联
 * DTS 单号转正:两段式(校验过目 → 确认转正),转正即跳新会话。
 */
import { useState } from "react";
import { issueStageText, type DtsTicketDetail, type IssueDetail,
  type IssueEnvironmentForm, type IssueGateKind,
  type IssueGateOption } from "../api";
import { IssueDecisionCard } from "./IssueDecisionCard";

export function IssueRail({ detail, busy, waiting, onAnswer, onReply,
  onSteer, onArchive, onCancel, onOpenDoc, onAssociate, onEnvironment }: {
  detail: IssueDetail;
  busy: boolean;
  /** 等待中的卡(平台闸优先,Agent 问题卡兜底;由会话视图统一裁决,
   * 轮询半拍的状态不传)。 */
  waiting?: {
    waiting_id: string;
    state_version: number;
    question: { questions?: Array<{ question: string; options: IssueGateOption[] }> };
    context?: string;
    created_at: string;
    /** 平台闸专用:env_needed 闸在决策卡上渲染专用环境表单。 */
    gate_kind?: IssueGateKind;
    gate_scope?: "logs" | "deploy";
  };
  /** 提交问题卡/平台闸答复(decision=人话;code=平台闸决策码;
   * answers=Agent 卡逐题作答);返回 true 表示成功。 */
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string) => Promise<boolean>;
  /** 继续对话(idle/interrupted);返回 true 表示成功。 */
  onReply: (text: string) => Promise<boolean>;
  /** 运行中插话;返回 true 表示成功。 */
  onSteer: (text: string) => Promise<boolean>;
  onArchive: () => void;
  onCancel: () => void;
  /** 打开材料页签的结论文档子视图。 */
  onOpenDoc: () => void;
  /** 挂起会话的关联单号转正(两段式);返回校验详情或转正结果。 */
  onAssociate: (ticket: string, confirm: boolean) =>
    Promise<{ ticket_detail?: DtsTicketDetail }>;
  /** env_needed 闸的专用提交口(POST /issues/:id/environment)。 */
  onEnvironment?: (input: IssueEnvironmentForm) => Promise<boolean>;
}) {
  // 收口态:自由模式=done+idle;固定模式=末阶段完成+idle(验证通过后)。
  const lastState = detail.stage_states?.[detail.stage_states.length - 1];
  const doneIdle = !waiting && detail.status === "idle"
    && (detail.mode === "fixed"
      ? lastState === "done"
      : detail.stage === "done");

  return <aside className="issue-rail">
    <div className="issue-rail-head"><span>下一步</span></div>
    <div className="issue-rail-body">
      {waiting && <IssueDecisionCard waiting={waiting} busy={busy}
        onAnswer={onAnswer} onEnvironment={onEnvironment} />}
      {!waiting && detail.status === "suspended"
        && <IssueAssociateCard busy={busy} onAssociate={onAssociate} />}
      {!waiting && detail.status !== "suspended" && doneIdle
        && <div className="issue-rail-card is-done">
          <strong>AI 已给出结论</strong>
          <p>{detail.mode === "fixed"
            ? "环境验证已通过——确认 MR 合入后归档收口。"
            : "归档收口即正式关闭这份研究现场。"}</p>
          <button type="button" className="issue-rail-primary"
            disabled={busy}
            onClick={onArchive}>归档收口</button>
          {/* 收口不锁门:归档前仍可续聊(对话页签已并入现场,发言口
              收拢到右栏各态,这里是 done 态的那一个)。 */}
          <RailInput kind="reply" disabled={busy}
            placeholder="归档前还想补充或追问,在这里继续"
            actionLabel="发送" submit={onReply} />
        </div>}
      {!waiting && detail.status !== "suspended" && !doneIdle
        && detail.status === "running" && <div className="issue-rail-card is-running">
        <strong><i className="issue-rail-pulse" aria-hidden />AI 正在推进</strong>
        <p>{issueStageText(detail)}
          {detail.stage_note ? ` · ${detail.stage_note}` : ""}</p>
        <RailInput
          kind="steer"
          disabled={busy}
          placeholder="会话运行中——补充说明会在当前步骤完成后送达"
          actionLabel="发送补充"
          submit={onSteer}
        />
      </div>}
      {!waiting && detail.status !== "suspended" && !doneIdle
        && detail.status === "idle" && <div className="issue-rail-card is-idle">
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
      {!waiting && detail.status !== "suspended" && !doneIdle
        && detail.status === "interrupted"
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
      {!waiting && detail.status !== "suspended" && !doneIdle
        && ["archived", "canceled", "failed"].includes(detail.status)
        && <div className="issue-rail-card is-ended">
          <strong>会话已结束({detail.status === "failed" ? "失败"
            : detail.status === "canceled" ? "已取消"
            : detail.conclusion?.kind === "converted" ? "已转正" : "已归档"})</strong>
          {detail.conclusion?.kind === "converted"
            ? <p>本会话已关联单号 {detail.ticket ?? ""} 转正为
              {detail.converted_to ?? "新会话"}——后续在那里继续。</p>
            : <p>没有待办动作;结论与账单见左侧页签。</p>}
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

/** 挂起会话的关联转正卡:输单号 → 平台经 DTS 校验并把单据详情带回来
 * 过目 → 确认转正(新会话继承分析报告直接进问题修改)。转正不可逆:
 * 单号将成为新会话的身份(分支名/MR/台账都带)。 */
function IssueAssociateCard({ busy, onAssociate }: {
  busy: boolean;
  onAssociate: (ticket: string, confirm: boolean) =>
    Promise<{ ticket_detail?: DtsTicketDetail }>;
}) {
  const [ticket, setTicket] = useState("");
  const [checked, setChecked] = useState<DtsTicketDetail | undefined>();
  const [busyLocal, setBusyLocal] = useState(false);
  const pending = busy || busyLocal;

  async function check() {
    if (!ticket.trim() || pending) return;
    setBusyLocal(true);
    try {
      const result = await onAssociate(ticket.trim(), false);
      setChecked(result.ticket_detail);
    } finally {
      setBusyLocal(false);
    }
  }

  async function confirm() {
    if (!ticket.trim() || pending) return;
    setBusyLocal(true);
    try {
      await onAssociate(ticket.trim(), true);
    } finally {
      setBusyLocal(false);
    }
  }

  return <div className="issue-rail-card is-suspended">
    <strong>挂起中:结论是问题</strong>
    <p>去 DTS 提单后回来关联单号——转正生成有单流程,带着分析报告
      直接进入问题修改。</p>
    <div className="issue-associate-input">
      <input value={ticket} placeholder="DTS 单号,如 DTS2026082001317"
        onChange={(event) => { setTicket(event.target.value); setChecked(undefined); }}
        onKeyDown={(event) => { if (event.key === "Enter") void check(); }} />
      <button type="button" disabled={!ticket.trim() || pending} onClick={() => void check()}>
        {pending ? "校验中…" : "校验单号"}
      </button>
    </div>
    {checked && <div className="issue-associate-detail">
      <div className="issue-associate-ticket">
        <span className="issue-ticket">{checked.ticket}</span>
        <span>{checked.title || "(无标题)"}</span>
      </div>
      <p className="issue-associate-content">{checked.content.split("\n").slice(0, 6)
        .join("\n")}</p>
      <button type="button" className="issue-rail-primary" disabled={pending}
        onClick={() => void confirm()}>
        确认转正(继承分析报告,进入问题修改)
      </button>
      <small>转正不可逆:本会话将归档,新会话以该单号继续。</small>
    </div>}
  </div>;
}

/** 栏内输入行:插话是单行 input,续聊是小 textarea;提交后清空的时机
 * 放在 success 之后(perform 返回 true),失败保字与旧行为一致。
 * 右栏各态(运行中插话/空闲续聊/被打断续聊/收口追问)共用同一形状。 */
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
