/**
 * 问题卡的决策卡:任务侧 WaitingCard(TaskCard.tsx)anatomy 的问题域移植。
 *
 * 提交语义与旧版完全一致——同一个 answerIssue 接口、同一个 state_version。
 * 区别只在交互:旧版"点选项立即提交",这里改成"先选/先填,统一按提交",
 * 让多题卡片能一次看清再作答。协议上是"码+文案"双通道(举卡裁决协议化):
 * 选项渲染 label(纯显示),提交回传 code(平台闸的裁决按它单点分派,
 * Agent 卡由服务端把码还原成选项原文再交给 AI)——文案改字零协议后果。
 * 服务端还会随题下发推荐码(questions[].recommended,ADR-0004):渲染
 * 成「AI 推荐」徽标+描边,只标注不预选——初始无选中,答案仍由用户
 * 亲手点选产生。
 * decision 仍是人话文本(显示/审计/自由作答);平台闸的 code 是单题卡
 * 的所选项,Agent 卡的 answers 是逐题(码或自由文本)。补充说明走 notes。
 * 后果提示(choice_effects)是任务侧的服务端能力,问题域没有对应账目,
 * 这里不伪造。
 *
 * 例外是 env_needed 闸(2026-08-28):通用选项卡换成语义化表单(地址+
 * 端口+网管后台密码),提交走 onEnvironment(由会话视图接到
 * attachIssueEnvironment——密码不进浏览器草稿,在服务端 vault 加密
 * 保存;配置后会按 ADR-0003 进入本问题会话的 AI 上下文供工具消费,
 * 但不出现在会话列表、状态摘要或事件流)。闸只收 地址+后台密码:现场补配的流程(拉日志/换库)
 * 碰不到网管页面,没有页面凭据的位置。
 */
import { useRef, useState } from "react";
import type { IssueEnvironmentForm, IssueWaitingCard } from "../api";
import { Markdown } from "../markdown";

const ENV_SCOPE_TEXT: Record<string, string> = {
  logs: "拉取日志",
  deploy: "换库部署",
};

export function IssueDecisionCard({ waiting, busy, onAnswer, onEnvironment }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  /** 组装好的答复。返回 true 表示提交成功(此时父级会带着新详情回来)。 */
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string) => Promise<boolean>;
  /** env_needed 闸的专用提交口(会话视图接到 /issues/:id/environment)。 */
  onEnvironment?: (input: IssueEnvironmentForm) => Promise<boolean>;
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

/** 网管环境表单:网管环境IP(单个,一个问题一个环境)+ 端口(默认 22)
 * + 网管后台密码。密码经 POST 进服务端 vault
 * (AES-GCM 加密文件),前端不存草稿;之后会进入本问题会话的 AI 上下文,
 * 让拉日志/换库工具能够消费,但不出现在会话列表、状态摘要或事件流。 */
function EnvNeededForm({ busy, onSubmit }: {
  busy: boolean;
  onSubmit?: (input: IssueEnvironmentForm) => Promise<boolean>;
}) {
  const [hosts, setHosts] = useState("");
  const [port, setPort] = useState("22");
  const [backendPassword, setBackendPassword] = useState("");
  const [error, setError] = useState("");
  const host = hosts.trim();
  const invalidHost = host !== "" && /[\s,，、]/.test(host);
  const portNumber = Number(port);
  const ready = host !== "" && !invalidHost && backendPassword.length > 0
    && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;

  async function submit() {
    if (!ready || busy || !onSubmit) return;
    const ok = await onSubmit({
      hosts: [host],
      ...(port !== "22" ? { port: portNumber } : {}),
      backend_password: backendPassword,
    });
    if (ok) {
      setBackendPassword("");
      setError("");
    } else {
      setError("提交未成功,请稍后重试");
    }
  }

  return <div className="issue-decision-env">
    <label className="issue-field wide">
      <span>网管环境IP</span>
      <input value={hosts} spellCheck={false}
        placeholder="60.14.46.16"
        onChange={(event) => setHosts(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>端口</span>
      <input type="number" min={1} max={65535} value={port}
        onChange={(event) => setPort(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>网管后台密码</span>
      <input type="password" value={backendPassword} autoComplete="new-password"
        onChange={(event) => setBackendPassword(event.target.value)} />
    </label>
    {invalidHost && <p className="issue-decision-note" role="alert">
      网管环境IP一次只填一个，请不要输入逗号、空格或换行。
    </p>}
    <p className="issue-decision-note">
      口令由服务端加密保存，不会出现在会话列表、状态摘要或事件流中，
      但会以明文进入本问题的 AI 上下文；请勿填写个人复用或生产口令。
    </p>
    {error && <p className="issue-decision-note" role="alert">{error}</p>}
    <div className="issue-decision-submit">
      <button type="button" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? "提交中…" : "保存并继续"}
      </button>
    </div>
  </div>;
}

/** 手动输入选项的虚拟 code(不会与真实选项 code 冲突)。选了它
 * 后该问题不再要求选其他选项——用户可能对所有给定选项都不满意,
 * 需要自行手写答案。提交时手写文本作为该题答案(与开放题同通道)。 */
const MANUAL_CODE = "__manual_input__";

export function areIssueQuestionsComplete(
  questions: Array<{ options: ReadonlyArray<unknown> }>,
  picked: Record<number, string>,
  custom: Record<number, string>,
): boolean {
  return questions.length > 0 && questions.every((item, index) => {
    if (item.options.length > 0) {
      const pick = picked[index];
      if (!pick) return false;
      // 选了手动输入:要求填了自定义文本才算答完。
      if (pick === MANUAL_CODE) return !!custom[index]?.trim();
      return true;
    }
    return !!custom[index]?.trim();
  });
}

function GenericDecisionCard({ waiting, busy, onAnswer }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string) => Promise<boolean>;
}) {
  const questions = waiting.question?.questions ?? [];
  // 推送过目闸(ADR-0009)的 context 是服务端现查仓库生成的变更摘要,
  // 标签按内容如实叫「变更摘要」;其余闸沿用「决策背景」。
  const contextLabel = waiting.gate_kind === "push_confirm"
    ? "变更摘要" : "决策背景";
  // picked 存决策码(选项的身份是 code,文案只用于显示)。
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const radioRefs = useRef<Record<number, Array<HTMLButtonElement | null>>>({});

  // 一张卡可能同时有选择题和开放题。逐题全答完才允许提交，不能让
  // “选择题都选了”或“任一开放题写了”掩盖同卡里仍空着的问题。
  const ready = areIssueQuestionsComplete(questions, picked, custom)
    || (questions.length === 0 && !!notes.trim());

  function moveRadio(
    questionIndex: number,
    optionIndex: number,
    key: string,
  ): boolean {
    const options = questions[questionIndex]?.options ?? [];
    if (!options.length) return false;
    const next = key === "Home" ? 0
      : key === "End" ? options.length - 1
        : key === "ArrowRight" || key === "ArrowDown"
          ? (optionIndex + 1) % options.length
          : key === "ArrowLeft" || key === "ArrowUp"
            ? (optionIndex - 1 + options.length) % options.length
            : undefined;
    if (next === undefined) return false;
    setPicked((current) => ({
      ...current,
      [questionIndex]: options[next].code,
    }));
    window.requestAnimationFrame(() =>
      radioRefs.current[questionIndex]?.[next]?.focus());
    return true;
  }

  async function submit() {
    if (!ready || busy) return;
    const labels: string[] = [];
    const answers: Record<string, string> = {};
    let code: string | undefined;
    questions.forEach((item, index) => {
      if (item.options.length) {
        const pickedCode = picked[index];
        if (!pickedCode) return;
        if (pickedCode === MANUAL_CODE) {
          // 手动输入:自定义文本作为该题答案(与开放题同通道)。
          const own = custom[index]?.trim();
          if (!own) return;
          answers[String(index)] = own;
          labels.push(own);
        } else {
          const option = item.options.find((candidate) =>
            candidate.code === pickedCode);
          if (option) labels.push(option.label);
          answers[String(index)] = pickedCode;
          code ??= pickedCode;
        }
      } else {
        const own = custom[index]?.trim();
        if (!own) return;
        answers[String(index)] = own;
        labels.push(own);
      }
    });
    const ok = await onAnswer(
      labels.join("\n"), code, answers, notes.trim() || undefined);
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
      <div className="context-label">{contextLabel}</div>
      <Markdown text={waiting.context} />
    </div>}

    {questions.map((item, index) => <fieldset className="question" key={index}>
      <legend>
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span className="question-text">{item.question || "需要你确认"}</span>
      </legend>
      {item.options.length > 0
        ? <div className="options cards" role="radiogroup"
            aria-label={`问题 ${index + 1}：${item.question || "需要你确认"}`}>
            {item.options.map((option, optionIndex) => {
              const chosen = picked[index] === option.code;
              // 推荐按码标注(ADR-0004 只标注不预选):无推荐的旧卡
              // 该键缺席,谁都不匹配,渲染与现状一致;推荐被点中后
              // 正常进已选态,徽标常驻但描边让位(accent 蓝)。
              const suggested = item.recommended === option.code;
              return <button type="button" key={option.code} role="radio"
                ref={(node) => {
                  (radioRefs.current[index] ??= [])[optionIndex] = node;
                }}
                aria-checked={chosen}
                tabIndex={chosen || (!picked[index] && optionIndex === 0) ? 0 : -1}
                className={`option${chosen ? " picked" : ""}${suggested ? " issue-recommended" : ""}`}
                onKeyDown={(event) => {
                  if (moveRadio(index, optionIndex, event.key)) event.preventDefault();
                }}
                onClick={() => setPicked((current) =>
                  ({ ...current, [index]: option.code }))}>
                <span className={`radio${chosen ? " on" : ""}`} aria-hidden />
                <span className="option-body"><span className="option-title">
                  {option.label}
                  {suggested && <span className="issue-recommended-badge">AI 推荐</span>}
                </span></span>
              </button>;
            })}
            {/* 手动输入:每个问题都可以不选给定选项,自行手写答案。
              选了它后该问题不再要求选其他选项——用户可能对所有
              给定选项都不满意,需要自行手写。提交时手写文本作为
              该题答案(与开放题同通道)。 */}
            {(() => {
              const manualChosen = picked[index] === MANUAL_CODE;
              const manualIndex = item.options.length;
              return <button type="button" key={MANUAL_CODE} role="radio"
                ref={(node) => {
                  (radioRefs.current[index] ??= [])[manualIndex] = node;
                }}
                aria-checked={manualChosen}
                tabIndex={manualChosen ? 0 : -1}
                className={`option manual${manualChosen ? " picked" : ""}`}
                onClick={() => setPicked((current) =>
                  ({ ...current, [index]: MANUAL_CODE }))}>
                <span className={`radio${manualChosen ? " on" : ""}`} aria-hidden />
                <span className="option-body"><span className="option-title">
                  手动输入
                </span></span>
              </button>;
            })()}
            {picked[index] === MANUAL_CODE && (
              <textarea className="custom-input issue-decision-manual-input"
                placeholder="写下你对这道题的答案…"
                value={custom[index] ?? ""}
                onChange={(event) => setCustom({ ...custom, [index]: event.target.value })} />
            )}
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
