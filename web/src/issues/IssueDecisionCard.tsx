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
 * 拒绝是同一提交口的另一条路(票 93):AI 误判要日志/要部署时,用户
 * 可按闸的 scope 拒绝(硬拒绝:同 scope 工具再调不再举卡)并留一句
 * 选填理由随平台通知转给 AI;配置环境成功即自动解除拒绝(解锢)。
 * 拒绝 wire 复用 /environment 请求体(decline:true + note),hosts/
 * backend_password 在拒绝路径上服务端不读,占位只为过表单类型。
 *
 * 另一例外是 skill_select 闸(ADR-0011):多选圈选卡——清单来自服务端
 * 扫描已拉仓的 .cac/skills,按仓分组;提交走 answer 的 selection 专用
 * 口(必须是清单子集,自报路径服务端拒收),空选=「都不用,AI 自主」。
 * 卡上没有「AI 推荐」:本卡只在月光关时举起、永远人答,推荐没有下游。
 *
 * 再一类例外是流水线红灯人工闸(2026-09-01,票 03):pipeline_unfixable
 * (不可修告警)与 pipeline_evidence(证据回灌)同卡形态、两种作答面。
 * 卡面(context)是服务端组装的失败摘要/逐维度明细/产物位置/处置指引,
 * markdown 直出;gate_pipeline 带闸归属的仓与提交。不可修卡就一个出口
 * ——「已在平台处理/豁免,重新监看」(code=resume),可附补充说明;
 * 证据卡是自由文本主通道(粘贴报错原文,空文本不可提交,code=supply)。
 * 两张卡问的都是人工事实,没有「AI 推荐」。
 */
import { useRef, useState } from "react";
import type { IssueEnvironmentForm, IssueSkillChoice, IssueWaitingCard } from "../api";
import { toggleDecisionChoice } from "../decisionSelection";
import { Markdown } from "../markdown";

const ENV_SCOPE_TEXT: Record<string, string> = {
  logs: "拉取日志",
  deploy: "换库部署",
};

/** 拒绝钮的拍板文案(票 93,按闸 scope 分叉;缺省按 logs——服务端
 * 对缺 scope 的旧卡也按 logs 处理,两端同一缺省)。 */
const ENV_DECLINE_TEXT: Record<string, string> = {
  logs: "无需拉日志,继续分析",
  deploy: "无需换库部署,继续",
};

/** 拒绝分支的 wire 形(票 93):复用 POST /issues/:id/environment
 * 请求体,decline:true 走服务端拒绝路;note 是选填理由。api.ts 的
 * 表单镜像暂未带这两个键(扩展收敛在本卡,不波及登记侧复用点),
 * 交叉类型在这里补齐——结构上仍是 IssueEnvironmentForm 的子型,
 * onEnvironment 管线原样透传。 */
type IssueEnvironmentDeclineForm = IssueEnvironmentForm & {
  decline: true;
  note?: string;
};

export function IssueDecisionCard({ waiting, busy, onAnswer, onEnvironment }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  /** 组装好的答复。返回 true 表示提交成功(此时父级会带着新详情回来)。 */
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string,
    selection?: string[]) => Promise<boolean>;
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
      <EnvNeededForm busy={busy} scope={waiting.gate_scope}
        onSubmit={onEnvironment} />
    </section>;
  }
  if (waiting.gate_kind === "skill_select") {
    return <section className="issue-decision" aria-label="圈选必读知识">
      <header className="issue-decision-head">
        <span className="decision-kicker">圈选必读知识</span>
        <span className="issue-decision-count">
          {(waiting.gate_skills ?? []).length} 个可选
        </span>
      </header>
      {waiting.context && <div className="issue-decision-context">
        <div className="context-label">决策背景</div>
        <Markdown text={waiting.context} />
      </div>}
      <SkillSelectForm busy={busy} skills={waiting.gate_skills ?? []}
        onSubmit={(selection, decision) =>
          onAnswer(decision, undefined, undefined, undefined, selection)} />
    </section>;
  }
  if (waiting.gate_kind === "pipeline_unfixable"
      || waiting.gate_kind === "pipeline_evidence") {
    return <PipelineGateCard waiting={waiting} busy={busy} onAnswer={onAnswer} />;
  }
  return <GenericDecisionCard waiting={waiting} busy={busy} onAnswer={onAnswer} />;
}

/** 网管环境表单:网管环境IP(单个,一个问题一个环境)+ 端口(默认 22)
 * + 网管后台密码。密码经 POST 进服务端 vault
 * (AES-GCM 加密文件),前端不存草稿;之后会进入本问题会话的 AI 上下文,
 * 让拉日志/换库工具能够消费,但不出现在会话列表、状态摘要或事件流。
 * 次要出路是拒绝(票 93):AI 误判要日志/要部署时,人可以不填环境
 * 直接拒绝——按闸 scope 显示拍板文案,选填一句理由随平台通知转给 AI。 */
function EnvNeededForm({ busy, scope, onSubmit }: {
  busy: boolean;
  /** 闸的用途面(logs=拉日志 / deploy=换库部署),拒绝文案按它分叉。 */
  scope?: string;
  onSubmit?: (input: IssueEnvironmentForm) => Promise<boolean>;
}) {
  const [hosts, setHosts] = useState("");
  const [port, setPort] = useState("22");
  const [backendPassword, setBackendPassword] = useState("");
  const [declineNote, setDeclineNote] = useState("");
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

  /** 拒绝(票 93):不填环境也能推进——硬拒绝后同 scope 工具不再举卡,
   * 配置环境成功即自动解除。提交走 /environment 的 decline 分支。 */
  async function decline() {
    if (busy || !onSubmit) return;
    const wire: IssueEnvironmentDeclineForm = {
      hosts: [],
      backend_password: "",
      decline: true,
      ...(declineNote.trim() ? { note: declineNote.trim() } : {}),
    };
    const ok = await onSubmit(wire);
    setError(ok ? "" : "提交未成功,请稍后重试");
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
    <label className="issue-field wide">
      <span>确定不需要?留一句理由帮 AI 调整方向(可选)</span>
      <textarea rows={2} className="custom-input"
        placeholder="如:问题在页面侧即可复现,与后台日志无关…"
        value={declineNote}
        onChange={(event) => setDeclineNote(event.target.value)} />
    </label>
    {error && <p className="issue-decision-note" role="alert">{error}</p>}
    <div className="issue-decision-submit">
      <button type="button" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? "提交中…" : "保存并继续"}
      </button>
      <button type="button" className="issue-decline" disabled={busy}
        onClick={() => void decline()}>
        {ENV_DECLINE_TEXT[scope ?? "logs"] ?? ENV_DECLINE_TEXT.logs}
      </button>
    </div>
  </div>;
}

/** 手动输入选项的虚拟 code(不会与真实选项 code 冲突)。选了它
 * 后该问题不再要求选其他选项——用户可能对所有给定选项都不满意,
 * 需要自行手写答案。提交时手写文本作为该题答案(与开放题同通道)。 */
const MANUAL_CODE = "__manual_input__";

/** skill 圈选表单(ADR-0011):按仓分组的多选清单,path 是提交身份
 * (仓段天然区分同名 skill)。「确认勾选」至少勾一项才可点;「都不用」
 * 提交空选,AI 按方法论取用次序自主——两条路的裁决在服务端同口。 */
function SkillSelectForm({ busy, skills, onSubmit }: {
  busy: boolean;
  skills: IssueSkillChoice[];
  onSubmit: (selection: string[], decision: string) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  // 按仓分组,组内保持扫描顺序;同名 skill 靠仓段区分,不拼假名字。
  const groups: Array<{ repo: string; items: IssueSkillChoice[] }> = [];
  for (const skill of skills) {
    const group = groups.find((candidate) => candidate.repo === skill.repo);
    if (group) group.items.push(skill);
    else groups.push({ repo: skill.repo, items: [skill] });
  }

  function toggle(path: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function submit(selection: string[]) {
    if (busy) return;
    const chosen = skills.filter((skill) => selection.includes(skill.path));
    const ok = await onSubmit(
      selection,
      chosen.length
        ? `圈选必读 skill:${chosen.map((skill) => skill.name).join("、")}`
        : "都不用,AI 按取用次序自主");
    setError(ok ? "" : "提交未成功,请稍后重试");
  }

  return <div className="issue-decision-env">
    {groups.map((group) => <fieldset className="question" key={group.repo}>
      <legend><span className="question-text">{group.repo}</span></legend>
      <div className="options cards">
        {group.items.map((skill) => {
          const chosen = picked.has(skill.path);
          return <button type="button" key={skill.path} role="checkbox"
            aria-checked={chosen}
            className={`option${chosen ? " picked" : ""}`}
            onClick={() => toggle(skill.path)}>
            <span className={`radio${chosen ? " on" : ""}`} aria-hidden />
            <span className="option-body"><span className="option-title">
              {skill.name}
            </span>
            {skill.description && <span className="option-hint">
              {skill.description}
            </span>}
            </span>
          </button>;
        })}
      </div>
    </fieldset>)}
    {error && <p className="issue-decision-note" role="alert">{error}</p>}
    <div className="issue-decision-submit">
      <button type="button" disabled={!picked.size || busy}
        onClick={() => void submit([...picked])}>
        {busy ? "提交中…" : `确认勾选(${picked.size})`}
      </button>
      <button type="button" className="skill-skip" disabled={busy}
        onClick={() => void submit([])}>
        都不用,AI 按取用次序自主
      </button>
    </div>
  </div>;
}

/** 流水线红灯人工闸卡(2026-09-01,票 03):不可修告警与证据回灌同卡
 * 形态、两种作答面。卡面(context,服务端组装的失败摘要/逐维度明细/
 * 产物位置/处置指引)markdown 直出;仓与提交按 gate_pipeline 陈列。
 * - pipeline_unfixable:单出口作答「已在平台处理/豁免,重新监看」
 *   (code=resume),可附补充说明(随答复入账);
 * - pipeline_evidence:自由文本主通道——粘贴报错原文提交(code=supply),
 *   原文作为人工证据注入下一修复回合;空文本不可提交(服务端同尺打回)。 */
function PipelineGateCard({ waiting, busy, onAnswer }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string) => Promise<boolean>;
}) {
  const evidence = waiting.gate_kind === "pipeline_evidence";
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const ready = evidence ? !!text.trim() : true;
  // 码与文案来自服务端下发的 options 镜像(前端不推断状态);单码闸,
  // 缺 options 时回退本地字面量仅为极端旧现场的兜底显示。
  const option = waiting.question?.questions?.[0]?.options?.[0];
  const code = option?.code ?? (evidence ? "supply" : "resume");
  const actionLabel = option?.label
    ?? (evidence ? "已粘贴报错原文,继续修复" : "已在平台处理/豁免,重新监看");

  async function submit() {
    if (!ready || busy) return;
    const decision = evidence ? text.trim() : actionLabel;
    const ok = await onAnswer(
      decision,
      code,
      undefined,
      evidence ? undefined : (notes.trim() || undefined));
    setError(ok ? "" : "提交未成功,请稍后重试");
  }

  return <section className="issue-decision"
    aria-label={evidence ? "回灌流水线报错原文" : "流水线红灯人工处理"}>
    <header className="issue-decision-head">
      <span className="decision-kicker">
        {evidence ? "流水线红灯·回灌报错原文" : "流水线红灯·需要人工处理"}
      </span>
      <span className="issue-decision-count">
        {evidence ? "粘贴原文后继续修复" : "交付平台处理/豁免"}
      </span>
    </header>
    {waiting.gate_pipeline && <p className="issue-decision-note">
      仓 {waiting.gate_pipeline.repo} · 提交 {waiting.gate_pipeline.sha.slice(0, 12)}
    </p>}
    {waiting.context && <div className="issue-decision-context">
      <div className="context-label">{evidence ? "缺口详情" : "失败详情"}</div>
      <Markdown text={waiting.context} />
    </div>}
    {evidence
      ? <div className="issue-decision-env">
          <label className="issue-field wide">
            <span>报错原文(带文件/行号/堆栈)</span>
            <textarea rows={8} className="custom-input"
              placeholder="把交付平台上失败项的报错原文粘贴到这里——它会作为人工证据注入下一修复回合…"
              value={text}
              onChange={(event) => setText(event.target.value)} />
          </label>
        </div>
      : <div className="issue-decision-env">
          <label className="issue-field wide">
            <span>补充说明(可选):在平台做了什么处理</span>
            <textarea rows={3} className="custom-input"
              placeholder="如:已豁免规则 R1 / 已处理 SuperChecker 告警…"
              value={notes}
              onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>}
    {error && <p className="issue-decision-note" role="alert">{error}</p>}
    <div className="issue-decision-submit">
      <button type="button" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? "提交中…" : actionLabel}
      </button>
    </div>
  </section>;
}


export function areIssueQuestionsComplete(
  questions: Array<{ options: ReadonlyArray<unknown> }>,
  picked: Record<string, string>,
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
  const [picked, setPicked] = useState<Record<string, string>>({});
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
    // 自定义答复也是这个单选组里的正式选项，必须能用方向键到达。
    const choices = [...options.map((option) => option.code), MANUAL_CODE];
    const next = key === "Home" ? 0
      : key === "End" ? choices.length - 1
        : key === "ArrowRight" || key === "ArrowDown"
          ? (optionIndex + 1) % choices.length
          : key === "ArrowLeft" || key === "ArrowUp"
            ? (optionIndex - 1 + choices.length) % choices.length
            : undefined;
    if (next === undefined) return false;
    setPicked((current) => ({
      ...current,
      [questionIndex]: choices[next],
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
                title={chosen ? "再次点击取消选择" : undefined}
                onKeyDown={(event) => {
                  if (moveRadio(index, optionIndex, event.key)) event.preventDefault();
                }}
                onClick={() => setPicked((current) =>
                  toggleDecisionChoice(current, index, option.code))}>
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
                title={manualChosen ? "再次点击取消自定义答复" : undefined}
                onKeyDown={(event) => {
                  if (moveRadio(index, manualIndex, event.key)) event.preventDefault();
                }}
                onClick={() => setPicked((current) =>
                  toggleDecisionChoice(current, index, MANUAL_CODE))}>
                <span className={`radio${manualChosen ? " on" : ""}`} aria-hidden />
                <span className="option-body"><span className="option-title">
                  自定义答复
                </span><span className="option-hint">
                  以上选项都不合适时使用
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
