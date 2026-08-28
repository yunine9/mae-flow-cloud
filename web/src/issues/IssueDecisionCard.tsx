/**
 * 问题卡的决策卡:任务侧 WaitingCard(TaskCard.tsx)anatomy 的问题域移植。
 *
 * 提交语义与旧版完全一致——同一个 answerIssue 接口、同一个 state_version。
 * 区别只在交互:旧版"点选项立即提交",这里改成"先选/先填,统一按提交",
 * 让多题卡片能一次看清再作答。decision 仍是单个字符串:多题答案按
 * humanGate.renderDecision 对 answers map 的同款口径以换行合并;补充说明
 * 走 notes 字段。后果提示(choice_effects)是任务侧的服务端能力,问题域
 * 没有对应账目,这里不伪造。
 *
 * 例外是 env_needed 闸(2026-08-28):通用选项卡换成语义化表单(地址+
 * 端口+密码),提交走 onEnvironment(由会话视图接到 attachIssueEnvironment
 * ——密码只经这一条路进服务端 vault,不进状态/事件/对话,也不出现在
 * 其他任何闸的渲染里)。
 */
import { useState } from "react";
import type { IssueWaitingCard } from "../api";
import { Markdown } from "../markdown";

const ENV_SCOPE_TEXT: Record<string, string> = {
  logs: "拉取日志",
  deploy: "换库部署",
};

export function IssueDecisionCard({ waiting, busy, onAnswer, onEnvironment }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  /** 组装好的答复。返回 true 表示提交成功(此时父级会带着新详情回来)。 */
  onAnswer: (decision: string, notes?: string) => Promise<boolean>;
  /** env_needed 闸的专用提交口(会话视图接到 /issues/:id/environment)。 */
  onEnvironment?: (input: {
    hosts: string[];
    port?: number;
    password: string;
  }) => Promise<boolean>;
}) {
  if (waiting.gate_kind === "env_needed") {
    return <section className="issue-decision" aria-label="配置网管环境">
      <header className="issue-decision-head">
        <span className="decision-kicker">配置网管环境</span>
        <span className="issue-decision-count">
          {ENV_SCOPE_TEXT[waiting.gate_scope ?? ""] ?? "拉日志/换库"}需要
        </span>
      </header>
      {waiting.context && <div className="issue-decision-context">
        <div className="context-label">决策背景</div>
        <Markdown text={waiting.context} />
      </div>}
      <EnvNeededForm busy={busy} onSubmit={onEnvironment} />
    </section>;
  }
  return <GenericDecisionCard waiting={waiting} busy={busy} onAnswer={onAnswer} />;
}

/** 网管环境表单:多行 hosts(逗号/换行分隔)+ 端口(默认 22)+ 共用密码。
 * 密码只在提交瞬间经 POST /issues/:id/environment 进服务端 vault
 * (AES-GCM 加密文件),不落状态/事件/对话——前端也不把它存进任何草稿。 */
function EnvNeededForm({ busy, onSubmit }: {
  busy: boolean;
  onSubmit?: (input: {
    hosts: string[];
    port?: number;
    password: string;
  }) => Promise<boolean>;
}) {
  const [hosts, setHosts] = useState("");
  const [port, setPort] = useState("22");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const parsedHosts = hosts.split(/[\s,，、]+/).map((item) => item.trim())
    .filter(Boolean);
  const portNumber = Number(port);
  const ready = parsedHosts.length > 0 && password.length > 0
    && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;

  async function submit() {
    if (!ready || busy || !onSubmit) return;
    const ok = await onSubmit({
      hosts: parsedHosts,
      ...(port !== "22" ? { port: portNumber } : {}),
      password,
    });
    if (ok) {
      setPassword("");
      setError("");
    } else {
      setError("提交未成功,请稍后重试");
    }
  }

  return <div className="issue-decision-env">
    <label className="issue-field wide">
      <span>网管服务器地址(多个用逗号或换行分隔)</span>
      <textarea rows={2} value={hosts} spellCheck={false}
        placeholder={"60.14.46.16, 60.14.46.17"}
        onChange={(event) => setHosts(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>端口</span>
      <input type="number" min={1} max={65535} value={port}
        onChange={(event) => setPort(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>共用密码(sopuser/ossuser/ossadm)</span>
      <input type="password" value={password} autoComplete="new-password"
        onChange={(event) => setPassword(event.target.value)} />
    </label>
    <p className="issue-decision-note">
      密码由平台加密保管,不会出现在对话或状态里;提交后 AI 会重试刚才的操作。
    </p>
    {error && <p className="issue-decision-note" role="alert">{error}</p>}
    <div className="issue-decision-submit">
      <button type="button" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? "提交中…" : "保存并继续"}
      </button>
    </div>
  </div>;
}

function GenericDecisionCard({ waiting, busy, onAnswer }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  onAnswer: (decision: string, notes?: string) => Promise<boolean>;
}) {
  const questions = waiting.question?.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");

  // 可提交口径(承旧版自由作答的口子):所有选择题都选了答案;
  // 或任一开放题写了自由作答;整卡没有问题时则看补充说明是否非空。
  const hasOptionQuestion = questions.some((item) => item.options.length > 0);
  const optionsAllPicked = hasOptionQuestion && questions.every((item, index) =>
    item.options.length === 0 || !!picked[index]);
  const freeAnswered = questions.some((item, index) =>
    !item.options.length && !!custom[index]?.trim());
  const ready = optionsAllPicked || freeAnswered
    || (questions.length === 0 && !!notes.trim());

  async function submit() {
    if (!ready || busy) return;
    const decision = questions.map((item, index) => {
      const own = item.options.length ? picked[index] : custom[index]?.trim();
      return own ?? "";
    }).filter(Boolean).join("\n");
    const ok = await onAnswer(decision, notes.trim() || undefined);
    if (ok) {
      setPicked({});
      setCustom({});
      setNotes("");
      setNotesOpen(false);
    }
  }

  return <section className="issue-decision" aria-label="等你答复">
    <header className="issue-decision-head">
      <span className="decision-kicker">等你答复</span>
      <span className="issue-decision-count">{questions.length} 个问题</span>
    </header>

    {waiting.context && <div className="issue-decision-context">
      <div className="context-label">决策背景</div>
      <Markdown text={waiting.context} />
    </div>}

    {questions.map((item, index) => <fieldset className="question" key={index}>
      <legend>
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span className="question-text">{item.question || "需要你确认"}</span>
      </legend>
      {item.options.length > 0
        ? <div className="options cards">
            {item.options.map((option) => {
              const chosen = picked[index] === option;
              return <button type="button" key={option} role="radio"
                aria-checked={chosen}
                className={`option${chosen ? " picked" : ""}`}
                onClick={() => setPicked({ ...picked, [index]: option })}>
                <span className={`radio${chosen ? " on" : ""}`} aria-hidden />
                <span className="option-body"><span className="option-title">{option}</span></span>
              </button>;
            })}
          </div>
        : <textarea className="custom-input issue-decision-free"
            placeholder="这道题没有给定选项——写下你的具体答案…"
            value={custom[index] ?? ""}
            onChange={(event) => setCustom({ ...custom, [index]: event.target.value })} />}
    </fieldset>)}

    {questions.length === 0 && <p className="issue-decision-note">
      这张问题卡没有列出选项——在下方补充说明里写下你的答复。
    </p>}

    {notesOpen
      ? <div className="custom-answer issue-decision-notes">
          <textarea className="custom-input"
            placeholder="补充说明(可选):原因、约束、现场信息…"
            value={notes}
            onChange={(event) => setNotes(event.target.value)} />
          <span>这段说明会随答复一起交给 AI,不会改变上面所选的分支。</span>
        </div>
      : <button type="button" className="issue-decision-notes-toggle"
          onClick={() => setNotesOpen(true)}>+ 补充说明(可选)</button>}

    <div className="issue-decision-submit">
      <button type="button" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? "提交中…" : "提交答复"}
      </button>
    </div>
  </section>;
}
