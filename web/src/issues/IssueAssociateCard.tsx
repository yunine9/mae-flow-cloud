/**
 * 挂起会话的关联转正卡(#127 自 IssueRail 迁出):输单号 → 平台经 DTS
 * 校验并把单据详情带回来过目 → 确认转正(新会话继承分析报告直接进问题
 * 修改)。转正不可逆:单号将成为新会话的身份(分支名/MR/台账都带)。
 *
 * 挂载点(#127 右栏侧栏拆除):协作流区顶部——「与 Agent 协作」头之下、
 * 流之上,由会话视图按 status === "suspended" 组装,经协作流组件的
 * suspendedCard 槽渲染;搬运不改语义,两段式(校验过目 → 确认)原样。
 * 查看模式渲染 IssueAssociateFacts 只读说明,关联表单不渲染。
 */
import { useState } from "react";
import { type DtsTicketDetail } from "../api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function IssueAssociateCard({ busy, onAssociate }: {
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
      <Input className="min-w-0 flex-1" value={ticket} placeholder="DTS 单号,如 DTS2026082001317"
        onChange={(event) => { setTicket(event.target.value); setChecked(undefined); }}
        onKeyDown={(event) => { if (event.key === "Enter") void check(); }} />
      {/* 校验钮(#256 收编):此前无任何样式落点,浏览器默认皮直出;
          outline 皮与 Input(h-8)同排同高。 */}
      <Button type="button" variant="outline"
        disabled={!ticket.trim() || pending} onClick={() => void check()}>
        {pending ? "校验中…" : "校验单号"}
      </Button>
    </div>
    {checked && <div className="issue-associate-detail">
      <div className="issue-associate-ticket">
        <span className="select-text rounded-full bg-primary/10 px-[7px] py-px font-mono text-xs font-bold text-primary">{checked.ticket}</span>
        <span>{checked.title || "(无标题)"}</span>
      </div>
      <p className="issue-associate-content">{checked.content.split("\n").slice(0, 6)
        .join("\n")}</p>
      {/* 转正主钮(#256 收编):旧承名主色实底类退役,换 shadcn 默认皮;
          通栏保持原占位。 */}
      <Button type="button" className="w-full" disabled={pending}
        onClick={() => void confirm()}>
        确认转正(继承分析报告,进入问题修改)
      </Button>
      <small>转正不可逆:本会话将归档,新会话以该单号继续。</small>
    </div>}
  </div>;
}

/** 挂起事实的只读说明(查看模式):结论是问题、在等单号转正——对围观者
 * 照样成立,关联表单与按钮一个不出(rail 原地内联分支升格为组件)。 */
export function IssueAssociateFacts() {
  return <div className="issue-rail-card is-suspended">
    <strong>挂起中:结论是问题</strong>
    <p>归属人去 DTS 提单后回来关联单号——转正生成有单流程,
      带着分析报告直接进入问题修改。</p>
  </div>;
}
