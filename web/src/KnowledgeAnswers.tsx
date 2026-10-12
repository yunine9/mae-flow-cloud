import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, ChevronUp, CircleHelp, LoaderCircle, MessageSquare, Plus, Send, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getSession } from "./api";
import { KnowledgeAnswerMarkdown } from "./KnowledgeAnswerMarkdown";
import { KnowledgeMaterialUpload, type MaterialSummary } from "./KnowledgeMaterialUpload";
import { cancelKnowledgeAnswer, getKnowledgeAnswer, getKnowledgeAnswerCatalog, getKnowledgeAnswers, knowledgeAnswerRunning, newerKnowledgeAnswer, questionContext, sendKnowledgeAnswerFeedback, startKnowledgeAnswer, type KnowledgeAnswerCatalog, type KnowledgeAnswerContext, type KnowledgeAnswerEvidence, type KnowledgeAnswerInput, type KnowledgeAnswerRecord } from "./knowledgeAnswersApi";
import "./KnowledgeAnswers.css";

const sourceLabels = { knowledge: "知识文档", code: "仓库代码", everycode: "Every Code", wireless: "无线豆包", material: "原始资料" };
const stages = { queued: "等待开始", researching: "查阅资料", answering: "整理回答", checking: "检查引用", done: "回答完成" };
const statusLabel = (record: KnowledgeAnswerRecord) => record.status === "failed" ? "回答失败" : record.status === "cancelled" ? "已停止" : stages[record.stage];
const messageOf = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。";
const draftKey = (account: string) => `mae-flow:knowledge-answer:draft:${account}`;
const elapsed = (created: string, now: number) => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

interface QuestionDraft { question: string; context: KnowledgeAnswerContext; materials: MaterialSummary[] }
interface Props {
  answerId?: string;
  moduleKey?: string;
  documentId?: string;
  onSelect: (id: string) => void;
}

function readDraft(account: string): QuestionDraft | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(draftKey(account)) || "null");
    if (!value || typeof value !== "object") return;
    const draft = value as QuestionDraft;
    if (typeof draft.question !== "string" || !draft.context || typeof draft.context !== "object") return;
    const materials = Array.isArray(draft.materials) ? [...new Map(draft.materials.filter(material => material && typeof material === "object"
      && typeof material.id === "string" && /^material-[a-f0-9-]{36}$/.test(material.id)
      && typeof material.name === "string" && typeof material.version === "string" && typeof material.scope === "string"
      && ["ready", "failed"].includes(material.state) && Number.isInteger(material.sections) && material.sections >= 0)
      .map(material => [material.id, {
        id: material.id, name: material.name, version: material.version, scope: material.scope, state: material.state, sections: material.sections,
        ...(typeof material.error === "string" ? { error: material.error } : {}),
        ...(Array.isArray(material.images) ? { images: material.images.filter(image => image && typeof image.path === "string").map(image => ({ path: image.path })) } : {}),
        ...(Array.isArray(material.warnings) ? { warnings: material.warnings.filter(warning => typeof warning === "string") } : {}),
      } as MaterialSummary])).values()].slice(0, 10) : [];
    return { question: draft.question, context: {
      ...(Array.isArray(draft.context.module_ids) ? { module_ids: draft.context.module_ids.filter(id => typeof id === "string") } : {}),
      ...(Array.isArray(draft.context.repository_ids) ? { repository_ids: draft.context.repository_ids.filter(id => typeof id === "string") } : {}),
      ...(typeof draft.context.document_id === "string" ? { document_id: draft.context.document_id } : {}),
      ...(typeof draft.context.product_version === "string" ? { product_version: draft.context.product_version } : {}),
      ...(materials.length ? { material_ids: materials.map(material => material.id) } : {}),
    }, materials };
  } catch { /* 浏览器禁用存储时，仍可在本页提问。 */ }
}

function EvidencePane({ evidence, onClose }: { evidence: KnowledgeAnswerEvidence; onClose: () => void }) {
  return <aside className="ka-evidence" aria-label="本次引用原文">
    <header><div><small>{sourceLabels[evidence.kind]}</small><h3>{evidence.title}</h3></div><Button variant="ghost" size="icon-sm" aria-label="关闭引用原文" onClick={onClose}><X size={16} /></Button></header>
    <dl className="ka-evidence-meta">
      {evidence.repository && <div><dt>仓库</dt><dd>{evidence.repository}</dd></div>}
      {evidence.path && <div><dt>文件</dt><dd>{evidence.path}</dd></div>}
      <div><dt>版本</dt><dd>{evidence.revision || "来源未提供版本"}</dd></div>
      {evidence.scope && <div><dt>适用范围</dt><dd>{evidence.scope}</dd></div>}
      {(evidence.location || evidence.start_line) && <div><dt>位置</dt><dd>{evidence.location || `第 ${evidence.start_line}${evidence.end_line ? `–${evidence.end_line}` : ""} 行`}</dd></div>}
      <div><dt>查阅时间</dt><dd>{new Date(evidence.retrieved_at).toLocaleString("zh-CN")}</dd></div>
    </dl>
    <p className="ka-evidence-note">这里保存的是本次回答实际查阅的内容。</p>
    {evidence.truncated && <p className="ka-notice">来源返回内容不完整，以下仅为实际查阅部分。</p>}
    <pre className="ka-evidence-content" tabIndex={0}>{evidence.content}</pre>
  </aside>;
}

function EvidenceList({ title, items, selectedId, onSelect }: { title: string; items: KnowledgeAnswerEvidence[]; selectedId: string; onSelect: (id: string) => void }) {
  if (!items.length) return null;
  return <section className="ka-citations" aria-label={title}><h3><BookOpen size={16} />{title}</h3>{items.map((item, index) => <button key={item.id} type="button" aria-pressed={item.id === selectedId} onClick={() => onSelect(item.id)}><span>{index + 1}</span><div><strong>{item.title}</strong><small>{sourceLabels[item.kind]}{item.path ? ` · ${item.path}` : ""}{item.revision ? ` · ${item.revision.slice(0, 12)}` : " · 版本未提供"}</small></div></button>)}</section>;
}

export function KnowledgeAnswers({ answerId = "", moduleKey, documentId, onSelect }: Props) {
  const [history, setHistory] = useState<KnowledgeAnswerRecord[]>([]), [historyError, setHistoryError] = useState("");
  const [catalog, setCatalog] = useState<KnowledgeAnswerCatalog>(), [catalogError, setCatalogError] = useState("");
  const [record, setRecord] = useState<KnowledgeAnswerRecord>(), [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<QuestionDraft>({ question: "", context: questionContext(moduleKey, documentId), materials: [] });
  const [account, setAccount] = useState(""), [draftReady, setDraftReady] = useState(false);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState(""), [refresh, setRefresh] = useState(0);
  const [selectedEvidence, setSelectedEvidence] = useState(""), [showContext, setShowContext] = useState(!!moduleKey || !!documentId);
  const [feedbackChoice, setFeedbackChoice] = useState<boolean>(), [feedbackComment, setFeedbackComment] = useState("");
  const [showMaterials, setShowMaterials] = useState(false), [uploading, setUploading] = useState(false);
  const [now, setNow] = useState(Date.now);
  const selectedId = useRef(answerId); selectedId.current = answerId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!record || !knowledgeAnswerRunning(record)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [record?.id, record?.status]);

  useEffect(() => {
    let live = true;
    void getSession().then(session => {
      if (!live) return;
      if (session?.username) {
        const saved = readDraft(session.username), context = questionContext(moduleKey, documentId);
        setAccount(session.username);
        if (saved) {
          setDraft({ ...saved, context: { ...saved.context, ...context } });
          setShowMaterials(saved.materials.length > 0);
        }
      }
      setDraftReady(true);
    }).catch(() => { if (live) setDraftReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!draftReady || !account) return;
    try { sessionStorage.setItem(draftKey(account), JSON.stringify(draft)); } catch { /* 存储不可用不影响提交。 */ }
  }, [draft, account, draftReady]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryError(""); setCatalogError("");
    void getKnowledgeAnswers(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setHistory(current => {
        // 列表可能晚于单条更新返回；保留本页已取得的新记录和最终状态。
        const merged = new Map(current.map(item => [item.id, item]));
        for (const item of result.answers) merged.set(item.id, newerKnowledgeAnswer(merged.get(item.id), item));
        return [...merged.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
    }).catch(error => { if (!controller.signal.aborted) setHistoryError(messageOf(error)); });
    void getKnowledgeAnswerCatalog(controller.signal).then(setCatalog).catch(error => { if (!controller.signal.aborted) setCatalogError(messageOf(error)); });
    return () => controller.abort();
  }, [refresh]);

  function receive(next: KnowledgeAnswerRecord) {
    if (!mounted.current) return;
    setHistory(current => {
      const previous = current.find(item => item.id === next.id);
      return [newerKnowledgeAnswer(previous, next), ...current.filter(item => item.id !== next.id)].sort((a, b) => b.created_at.localeCompare(a.created_at));
    });
    if (selectedId.current === next.id) setRecord(current => newerKnowledgeAnswer(current, next));
  }
  useEffect(() => {
    setRecord(undefined); setLoadError(""); setActionError(""); setSelectedEvidence(""); setFeedbackChoice(undefined); setFeedbackComment("");
    if (!answerId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await getKnowledgeAnswer(answerId, controller.signal);
        if (controller.signal.aborted) return;
        receive(next); setLoadError("");
        if (knowledgeAnswerRunning(next)) timer = setTimeout(() => { void poll(); }, 1500);
      } catch (error) { if (!controller.signal.aborted) setLoadError(messageOf(error)); }
    }
    void poll();
    // 离开页面只停止浏览器轮询，服务端继续回答。
    return () => { controller.abort(); clearTimeout(timer); };
  }, [answerId, refresh]);

  async function submit(input: KnowledgeAnswerInput, clearDraft = false) {
    if (busy || uploading || !input.question.trim()) return;
    setBusy(true); setActionError("");
    try {
      const next = await startKnowledgeAnswer({ question: input.question.trim(), context: input.context });
      if (!mounted.current) return;
      receive(next);
      if (clearDraft) setDraft(current => ({ ...current, question: "", context: { ...current.context, material_ids: undefined }, materials: [] }));
      onSelect(next.id);
    } catch (error) { if (mounted.current) setActionError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function stop() {
    if (!record || busy) return;
    setBusy(true); setActionError("");
    try { receive(await cancelKnowledgeAnswer(record.id)); }
    catch (error) { if (mounted.current) setActionError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function feedback() {
    if (!record || feedbackChoice === undefined || busy) return;
    setBusy(true); setActionError("");
    try { receive(await sendKnowledgeAnswerFeedback(record.id, feedbackChoice, feedbackComment.trim())); if (mounted.current) { setFeedbackChoice(undefined); setFeedbackComment(""); } }
    catch (error) { if (mounted.current) setActionError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function changeContext(value: Partial<KnowledgeAnswerContext>) { setDraft(current => ({ ...current, context: { ...current.context, ...value } })); }
  function changeMaterials(materials: MaterialSummary[]) { setDraft(current => ({ ...current, materials, context: { ...current.context, material_ids: materials.map(material => material.id) } })); }
  const evidence = record?.evidence.find(item => item.id === selectedEvidence);
  const cited = record?.status === "done" && record.answer ? record.answer.evidence_ids.map(id => record.evidence.find(item => item.id === id)).filter((item): item is KnowledgeAnswerEvidence => !!item) : [];
  const moduleNames = record?.context?.module_ids?.map(id => catalog?.modules.find(item => item.id === id)?.name || id) || [];
  const contextDocument = catalog?.documents?.find(item => item.id === draft.context.document_id);

  return <section className={`tw-root ka-workspace${evidence ? " has-evidence" : ""}`} aria-label="知识问答工作区">
    <aside className="ka-history" aria-label="最近问答">
      <header><h2>知识问答</h2><Button variant="outline" size="sm" onClick={() => onSelect("")}><Plus size={15} />新问题</Button></header>
      <p>查业务规则、组件用法、代码和测试。</p>
      {historyError && <div role="alert" className="ka-error">{historyError}<Button variant="ghost" size="sm" onClick={() => setRefresh(value => value + 1)}>重试加载</Button></div>}
      <nav>{history.map(item => <button type="button" key={item.id} className="ka-history-item" aria-current={answerId === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}><span>{item.question}</span><small>{statusLabel(item)} · {new Date(item.created_at).toLocaleDateString("zh-CN")}</small></button>)}</nav>
      {!history.length && !historyError && <div className="ka-history-empty"><MessageSquare size={24} /><span>你的问答会保存在这里</span></div>}
    </aside>
    <main className="ka-main">
      {!answerId ? <div className="ka-compose">
        <div className="ka-compose-title"><CircleHelp size={30} /><h2>你想了解什么？</h2><p>根据实际查阅的资料回答。</p></div>
        <form onSubmit={event => { event.preventDefault(); void submit(draft, true); }}>
          <label htmlFor="knowledge-answer-question">问题</label>
          <Textarea id="knowledge-answer-question" aria-label="知识问答问题" placeholder="例如：这个组件怎么接入？类似代码的 UT 怎么写？这条业务规则在哪里实现？" value={draft.question} onChange={event => setDraft(current => ({ ...current, question: event.target.value }))} disabled={!draftReady || busy} maxLength={12000} />
          <Button type="button" variant="ghost" size="sm" className="ka-context-toggle" aria-expanded={showContext} onClick={() => setShowContext(value => !value)}>{showContext ? <ChevronUp size={14} /> : <ChevronDown size={14} />}补充范围与参考文档{(draft.context.module_ids?.length || draft.context.repository_ids?.length || draft.context.document_id || draft.context.product_version) ? "（已补充）" : "（可选）"}</Button>
          {showContext && <div className="ka-context">
            <label>相关模块<select aria-label="问答相关模块" value={draft.context.module_ids?.[0] || ""} onChange={event => changeContext({ module_ids: event.target.value ? [event.target.value] : [] })}><option value="">所有模块</option>{catalog?.modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>相关仓库<select aria-label="问答相关仓库" value={draft.context.repository_ids?.[0] || ""} onChange={event => changeContext({ repository_ids: event.target.value ? [event.target.value] : [] })}><option value="">按问题查找</option>{catalog?.repositories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="ka-context-document">参考文档<select aria-label="问答参考文档" value={draft.context.document_id || ""} onChange={event => changeContext({ document_id: event.target.value || undefined })}><option value="">不指定</option>{catalog?.documents?.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}{draft.context.document_id && !contextDocument && <option value={draft.context.document_id}>{draft.context.document_id}</option>}</select><small>指定文档作为参考，仍会按问题补查其他依据。</small></label>
            <label>适用版本<input aria-label="问答适用版本" value={draft.context.product_version || ""} onChange={event => changeContext({ product_version: event.target.value || undefined })} placeholder="可填写产品或组件版本" /></label>
          </div>}
          <Button type="button" variant="ghost" size="sm" className="ka-context-toggle" aria-expanded={showMaterials} onClick={() => setShowMaterials(value => !value)}>{showMaterials ? <ChevronUp size={14} /> : <ChevronDown size={14} />}补充原始资料{draft.materials.length ? `（${draft.materials.length} 份）` : "（可选）"}</Button>
          {showMaterials && <div className="ka-material-upload"><KnowledgeMaterialUpload purpose="question" materials={draft.materials} onChange={changeMaterials} onBusy={setUploading} disabled={!draftReady || busy} /></div>}
          {catalogError && <p className="ka-notice">范围选项加载失败，仍可直接提问。<button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></p>}
          {actionError && <p role="alert" className="ka-error">{actionError}</p>}
          <div className="ka-submit"><small>{uploading ? "资料正在上传并解析，请稍候" : draft.context.module_ids?.length ? "结合所选模块查阅相关知识" : "默认查阅所有可用的正式知识"}</small><Button type="submit" disabled={!draftReady || busy || uploading || !draft.question.trim()}>{busy ? <LoaderCircle className="ka-spinner" size={16} /> : <Send size={16} />}{busy ? "正在发起" : "提问"}</Button></div>
        </form>
        {catalog?.sources.length ? <details className="ka-sources"><summary>可查阅的来源</summary>{catalog.sources.map(source => <div key={source.kind}><strong>{source.label}</strong><span>{source.detail || (source.available ? "已配置" : "暂未配置")}</span></div>)}</details> : null}
      </div> : <div className="ka-answer-view">
        {loadError && <p role="alert" className="ka-error">{loadError}<Button variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)}>重试加载</Button></p>}
        {!record && !loadError && <p role="status" className="ka-loading"><LoaderCircle className="ka-spinner" size={17} />正在加载问答…</p>}
        {record && <>
          <header className="ka-question"><small>你的问题{moduleNames.length ? ` · ${moduleNames.join("、")}` : ""}</small><h2>{record.question}</h2></header>
          {knowledgeAnswerRunning(record) && <section className="ka-progress" aria-label="回答进度" aria-live="polite"><div><LoaderCircle className="ka-spinner" size={18} /><strong>{statusLabel(record)}</strong><small aria-label="本次已等待时长">已等待 {elapsed(record.created_at, now)}</small><Button variant="outline" size="sm" onClick={() => { void stop(); }} disabled={busy}><Square size={13} />停止</Button></div><p>{record.activity.at(-1)?.message || "问答已提交，正在准备查阅资料。"}</p><small>离开页面不会停止回答，可以稍后回来查看。</small></section>}
          {record.activity.length > 0 && <details className="ka-activity"><summary>查阅过程 · {record.activity.length} 条</summary><ol>{record.activity.map((item, index) => <li key={`${item.at}:${index}`}><span>{stages[item.stage]}</span><p>{item.message}</p></li>)}</ol></details>}
          {record.status !== "done" && <EvidenceList title="本次已查阅资料" items={record.evidence} selectedId={selectedEvidence} onSelect={setSelectedEvidence} />}
          {record.status === "done" && record.answer && <>
            <article className="ka-answer" aria-label="知识回答"><KnowledgeAnswerMarkdown text={record.answer.markdown} onOpenKnowledgeLink={href => {
              const id = href.startsWith("#evidence-") ? href.slice("#evidence-".length) : undefined;
              if (id && record.evidence.some(item => item.id === id)) setSelectedEvidence(id);
            }} /></article>
            {record.answer.unknowns.length > 0 && <section className="ka-unknowns" aria-label="待确认内容"><h3>还需要确认</h3><ul>{record.answer.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
            <EvidenceList title="回答依据" items={cited} selectedId={selectedEvidence} onSelect={setSelectedEvidence} />
            <section className="ka-feedback" aria-label="回答反馈"><div><span>{record.feedback ? "已收到你的反馈" : "这次回答有帮助吗？"}</span><Button variant={feedbackChoice === true ? "secondary" : "ghost"} size="sm" aria-pressed={feedbackChoice === true} onClick={() => setFeedbackChoice(true)}><ThumbsUp size={15} />有帮助</Button><Button variant={feedbackChoice === false ? "secondary" : "ghost"} size="sm" aria-pressed={feedbackChoice === false} onClick={() => setFeedbackChoice(false)}><ThumbsDown size={15} />有问题</Button></div>{feedbackChoice !== undefined && <div className="ka-feedback-form"><Textarea aria-label="回答反馈说明" value={feedbackComment} onChange={event => setFeedbackComment(event.target.value)} placeholder={feedbackChoice ? "可以补充哪些部分有帮助（可选）" : "哪里不准确，或缺少哪些依据？（可选）"} maxLength={2000} /><Button size="sm" onClick={() => { void feedback(); }} disabled={busy}>提交反馈</Button></div>}</section>
          </>}
          {(record.status === "failed" || record.status === "cancelled") && <section className="ka-terminal" aria-label="问答未完成"><h3>{record.status === "failed" ? "这次回答未完成" : "回答已停止"}</h3><p>{record.error || (record.status === "failed" ? "服务暂时无法完成回答，请稍后重试。" : "已保留本次问题和查阅过程。")}</p><Button variant="outline" onClick={() => { void submit({ question: record.question, context: record.context }); }} disabled={busy}>重新提问</Button></section>}
          {record.warnings.length > 0 && <section className="ka-notice" aria-label="来源说明">{record.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</section>}
          {actionError && <p role="alert" className="ka-error">{actionError}</p>}
        </>}
      </div>}
    </main>
    {evidence && <EvidencePane evidence={evidence} onClose={() => setSelectedEvidence("")} />}
  </section>;
}
