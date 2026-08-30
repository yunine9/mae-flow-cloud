/**
 * 服务设置(管理员页):运行参数、模型网关；部署基础设施只做自检。
 *
 * 两条纪律,和服务端 settings.ts 一体:
 * - 密钥只写不读:界面只见掩码(••••末4位),输入框永远从空白开始,
 *   留空=保持现状;所以"改一个键"由服务端按键合并,前端不回填明文。
 * - 生效边界如实告知:并发=下一次调度,修复轮/轮询=下一次红灯/轮询,
 *   模型=下一个新会话——不承诺"立刻"。
 */

import { useEffect, useState } from "react";
import {
  getBuildCacheStatus,
  getSettings,
  getSystemCheck,
  postModelsCheck,
  putExecutionPolicySettings,
  putModelsSettings,
  putRuntimeSettings,
  putVisionSettings,
  reclaimUnusedBuildCaches,
  testVisionCapability,
  type BuildCacheStatus,
  type SettingsView as Settings,
  type SystemCheckResult,
  type VisionProbeResult,
} from "./api";

type Message = { kind: "success" | "error"; text: string } | null;

function useMessage(): [Message, (next: Message) => void] {
  const [message, setMessage] = useState<Message>(null);
  return [message, setMessage];
}

function Feedback({ message }: { message: Message }) {
  if (!message) return null;
  return <div className={`form-message ${message.kind}`} role="status">
    {message.text}</div>;
}

/** 自检/连通性测试共用的结论网格:状态色 + 明细 + 建议一句话。 */
function CheckItems({ result }: { result: SystemCheckResult }) {
  return <div className="system-check-grid">{result.items.map((item) => <article className={`system-check-item ${item.status}`} key={item.key}>
    <span className="check-icon" aria-hidden>{item.status === "ok" ? "✓" : item.status === "error" ? "!" : "·"}</span>
    <div><strong>{item.label}</strong><p>{item.detail}</p>{item.suggestion && <small>{item.suggestion}</small>}</div>
  </article>)}</div>;
}

function SystemCheckCard() {
  const [result, setResult] = useState<SystemCheckResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setError("");
    try { setResult(await getSystemCheck()); }
    catch (cause) { setError(String((cause as Error).message ?? cause)); }
    finally { setBusy(false); }
  }

  useEffect(() => { void run(); }, []);
  const summary = result?.overall === "ok" ? "全部正常"
    : result?.overall === "error" ? "存在不可用项" : "可运行，但有待完善项";
  return <section className="system-check-card" aria-labelledby="system-check-title">
    <div className="system-check-head">
      <div><span className="section-kicker">DEPLOYMENT CHECK</span><h2 id="system-check-title">部署自检</h2><p>只读检查当前服务，不发送消息、不创建任务。</p></div>
      <div className="system-check-actions">
        {result && <span className={`check-summary ${result.overall}`}><i aria-hidden />{summary}</span>}
        <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "检查中…" : "重新检查"}</button>
      </div>
    </div>
    {error && <div className="form-message error">{error}</div>}
    {!result && !error && <div className="settings-loading">正在检查服务…</div>}
    {result && <CheckItems result={result} />}
  </section>;
}

/** 数字项:显示当前覆盖值,空=使用页面给出的服务默认值。 */
function KnobField({ label, note, defaultText, value, onChange }: {
  label: string; note: string; defaultText: string;
  value: string; onChange: (next: string) => void;
}) {
  return <label>
    <span className="setting-label-row"><span>{label}</span><em>默认 {defaultText}</em></span>
    <input inputMode="numeric" value={value} placeholder={`使用默认值：${defaultText}`}
      onChange={(event) => onChange(event.target.value)} />
    <small className="knob-note">留空即使用默认值 · {note}</small>
  </label>;
}

function RuntimeCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const runtime = view.runtime;
  const defaults = view.defaults.runtime;
  const text = (value?: number) => value === undefined ? "" : String(value);
  const [concurrent, setConcurrent] = useState(text(runtime.max_concurrent));
  const [repair, setRepair] = useState(text(runtime.repair_rounds));
  const [interval, setInterval_] = useState(text(runtime.poll_interval_s));
  const [timeout_, setTimeout_] = useState(text(runtime.poll_timeout_s));
  const [retention, setRetention] = useState(
    text(runtime.workspace_retention_days));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();
  const timeoutDefault = defaults.poll_timeout_s >= 60
    && defaults.poll_timeout_s % 60 === 0
    ? `${defaults.poll_timeout_s} 秒（${defaults.poll_timeout_s / 60} 分钟）`
    : `${defaults.poll_timeout_s} 秒`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putRuntimeSettings({
        max_concurrent: concurrent.trim(),
        repair_rounds: repair.trim(),
        poll_interval_s: interval.trim(),
        poll_timeout_s: timeout_.trim(),
        workspace_retention_days: retention.trim(),
      }));
      setMessage({ kind: "success", text: "已保存；留空项继续使用页面标注的默认值。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div className="user-create-card settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">RUNTIME</span>
      <h2>运行参数</h2>
      <p>这里调整全团队任务的默认运行节奏。每项都明确显示当前服务默认值；
        留空即可恢复默认，无需了解部署命令。</p>
    </div>
    <form className="user-create-form settings-form runtime-settings-form" onSubmit={submit}>
      <KnobField label="并发任务数" defaultText={`${defaults.max_concurrent} 个`}
        note="生效于下一次调度决策"
        value={concurrent} onChange={setConcurrent} />
      <KnobField label="自动修复轮数上限"
        defaultText={defaults.repair_rounds === null ? "不限轮" : `${defaults.repair_rounds} 轮`}
        note="0 表示关闭自动修复；生效于下一次流水线失败"
        value={repair} onChange={setRepair} />
      <KnobField label="流水线检查间隔（秒）" defaultText={`${defaults.poll_interval_s} 秒`}
        note="生效于下一轮检查"
        value={interval} onChange={setInterval_} />
      <KnobField label="流水线最长等待（秒）" defaultText={timeoutDefault}
        note="超过时间后停止等待并提示人工介入"
        value={timeout_} onChange={setTimeout_} />
      {/* 回收是不可逆动作,note 必须把"删什么、留什么"说全——
          光写"保留期"会让人以为整单历史都没了。 */}
      <KnobField label="任务现场保留期（天）"
        defaultText={defaults.workspace_retention_days === 0
          ? "永不回收" : `${defaults.workspace_retention_days} 天`}
        note="终态任务过期后回收代码克隆等可再生的大件；过程记录、证据与批注永久保留。0 表示永不回收"
        value={retention} onChange={setRetention} />
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存运行参数"}</button>
      <Feedback message={message} />
    </form>
  </div>;
}

function ExecutionPolicyCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const [instructions, setInstructions] = useState(
    view.execution_policy.team_instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putExecutionPolicySettings({
        team_instructions: instructions.trim(),
      }));
      setMessage({
        kind: "success",
        text: instructions.trim()
          ? "团队执行约定已保存；只影响之后新建的任务，运行中与历史任务保持原快照。"
          : "团队执行约定已清空；之后新建的任务只使用平台默认与任务补充。",
      });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div className="user-create-card settings-card execution-policy-card">
    <div className="user-create-copy">
      <span className="section-kicker">WORKFLOW POLICY</span>
      <h2>团队执行约定</h2>
      <p>把团队长期采用的关注点与协作习惯叠加在平台默认方案上。每个新任务都会固定当时版本，并在“执行方案”里说明来源。</p>
    </div>
    <form className="user-create-form settings-form execution-policy-form"
      onSubmit={submit}>
      <label>
        <span>新任务默认补充</span>
        <textarea rows={7} maxLength={2000} value={instructions}
          placeholder="例如：涉及存量接口时先核对兼容性；不确定的外部行为明确说明，不要猜；公共契约变更必须点名影响方。"
          onChange={(event) => setInstructions(event.target.value)} />
        <small className="knob-note">
          只调整关注点、先后顺序和协作方式；不能覆盖阶段、真实证据、人工决定或 Git/交付权限。留空表示不设置团队补充。
        </small>
        <em className="settings-char-count">{instructions.length}/2000</em>
      </label>
      {/* 团队各阶段勾选增强已随 v1 退役(2026-08-29):想定制阶段
          结构请到「团队资产 → 工作流」建团队工作流资产。 */}
      <button type="submit" disabled={busy}>
        {busy ? "正在保存…" : "保存团队执行约定"}
      </button>
      <Feedback message={message} />
    </form>
  </div>;
}

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let at = 0;
  while (size >= 1024 && at < units.length - 1) { size /= 1024; at += 1; }
  return `${size >= 10 || at === 0 ? Math.round(size) : size.toFixed(1)} ${units[at]}`;
}

function BuildCacheCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const defaults = view.defaults.runtime;
  const runtime = view.runtime;
  const text = (value?: number) => value === undefined ? "" : String(value);
  const [retention, setRetention] = useState(
    text(runtime.build_cache_retention_days));
  const [maxGb, setMaxGb] = useState(text(runtime.build_cache_max_gb));
  const [status, setStatus] = useState<BuildCacheStatus>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [message, setMessage] = useMessage();

  async function refresh() {
    setLoading(true);
    try { setStatus(await getBuildCacheStatus()); }
    catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(null);
    try {
      const next = await putRuntimeSettings({
        build_cache_retention_days: retention.trim(),
        build_cache_max_gb: maxGb.trim(),
      });
      onSaved(next);
      setMessage({ kind: "success", text: "缓存策略已保存，下一轮每日回收按新策略执行。" });
      await refresh();
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setSaving(false); }
  }

  async function clearUnused() {
    if (!window.confirm("清理当前未被任务或容器占用的全部构建缓存？\n\n"
      + "后续任务仍可重新生成，但第一次编译会变慢；运行中的缓存不会被触碰。")) return;
    setReclaiming(true); setMessage(null);
    try {
      const result = await reclaimUnusedBuildCaches();
      setStatus(result.status);
      setMessage({ kind: result.failed.length ? "error" : "success",
        text: `已清理 ${result.reclaimed} 个仓库缓存，释放 ${bytes(result.freed_bytes)}`
          + (result.skipped_active ? `；${result.skipped_active} 个正在使用，已跳过` : "")
          + (result.failed.length ? `；${result.failed.length} 个清理失败` : "") });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setReclaiming(false); }
  }

  const effectiveRetention = status?.policy.retention_days
    ?? runtime.build_cache_retention_days ?? defaults.build_cache_retention_days;
  const effectiveMax = (status?.policy.max_bytes ??
    ((runtime.build_cache_max_gb ?? defaults.build_cache_max_gb) * 1024 ** 3));
  return <div className="user-create-card settings-card build-cache-card">
    <div className="user-create-copy">
      <span className="section-kicker">BUILD CACHE</span>
      <h2>构建缓存</h2>
      <p>同一代码仓的后续任务会复用 Maven、npm、ccache 等缓存。任务删除不立即
        误删共享缓存；长期不用或超过容量上限时自动回收。</p>
      {loading && <span className="settings-state"><i aria-hidden />正在统计缓存…</span>}
      {!loading && status && !status.configured && <span className="settings-state missing">
        <i aria-hidden />当前部署未启用统一构建缓存</span>}
      {!loading && status?.configured && <div className="build-cache-summary">
        <strong>{bytes(status.total_bytes)}</strong>
        <span>{status.caches} 个仓库分区 · {status.active} 个正在使用</span>
        <small>{effectiveRetention > 0 ? `${effectiveRetention} 天未用自动清理` : "不按时间清理"}
          {` · ${effectiveMax > 0 ? `总量上限 ${bytes(effectiveMax)}` : "不设容量上限"}`}</small>
      </div>}
      {status && status.entries.length > 0 && <details className="build-cache-details">
        <summary>查看缓存明细</summary>
        <div>{status.entries.map((entry) => <div className="build-cache-entry" key={entry.key}>
          <span><strong>{entry.repository_hint || entry.key}</strong>
            <small>最后使用 {new Date(entry.last_used_at).toLocaleString()}</small></span>
          <em>{entry.active ? "使用中" : bytes(entry.size_bytes)}</em>
        </div>)}</div>
      </details>}
    </div>
    <form className="user-create-form settings-form build-cache-form" onSubmit={save}>
      <KnobField label="未使用保留期（天）"
        defaultText={`${defaults.build_cache_retention_days} 天`}
        note="从最后一次挂载使用起计算；0 表示不按时间自动清理"
        value={retention} onChange={setRetention} />
      <KnobField label="总容量上限（GB）"
        defaultText={`${defaults.build_cache_max_gb} GB`}
        note="超出后优先清最久未用的缓存；0 表示不限制"
        value={maxGb} onChange={setMaxGb} />
      <div className="build-cache-actions span-2">
        <button type="submit" disabled={saving || reclaiming}>
          {saving ? "正在保存…" : "保存缓存策略"}</button>
        <button type="button" className="secondary" disabled={loading || reclaiming || !status?.caches}
          onClick={() => void clearUnused()}>
          {reclaiming ? "正在清理…" : "清理未使用缓存"}</button>
      </div>
      <small className="knob-note span-2">手动清理也会保护运行中、等待继续执行的任务；
        只删除可重新生成的构建缓存，不删除代码、任务记录或交付证据。</small>
      <Feedback message={message} />
    </form>
  </div>;
}

function ModelsCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const models = view.models;
  const defaults = view.defaults.models;
  // 接口格式默认 OpenAI Chat(用户拍板 2026-08-26);已存配置回显原格式。
  const [apiFormat, setApiFormat] = useState(
    models.api ?? "openai-completions");
  const [url, setUrl] = useState(models.url ?? defaults.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(models.model ?? defaults.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();
  const [testing, setTesting] = useState(false);
  const [checkResult, setCheckResult] = useState<SystemCheckResult>();
  const [checkError, setCheckError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putModelsSettings({
        url: url.trim(),
        api_key: apiKey.trim(),
        model: model.trim(),
        api: apiFormat,
      }));
      setApiKey("");
      setMessage({ kind: "success",
        text: "已保存；下一个新任务使用新配置，运行中的任务不受影响。可点「测试连通」验证。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  // 测的是当前表单值(未保存也能测);密钥留空时服务端沿用已存的,
  // 与保存的合并口径一致——界面永远不回填明文。
  async function runCheck() {
    setTesting(true); setCheckError(""); setCheckResult(undefined);
    try {
      setCheckResult(await postModelsCheck({
        url: url.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        api: apiFormat,
      }));
    } catch (cause) {
      setCheckError(String((cause as Error).message ?? cause));
    } finally { setTesting(false); }
  }

  return <div className="user-create-card settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">MODEL GATEWAY</span>
      <h2>模型网关</h2>
      <p>团队任务统一使用这一套模型。只需填写网关地址、API Key 和模型名称；
        API Key 保存后不会回显明文。</p>
      <span className={`settings-state ${models.configured || defaults.configured ? "ok" : "missing"}`}>
        <i aria-hidden />{models.configured
          ? `已配置${models.key_hint ? ` · Key ${models.key_hint}` : ""}`
          : defaults.configured
            ? `使用服务默认配置${defaults.model ? ` · ${defaults.model}` : ""}`
            : "尚未配置"}
      </span>
    </div>
    <form className="user-create-form settings-form" onSubmit={submit}>
      <label className="span-2">
        <span>模型网关地址</span>
        <input value={url} type="url" required spellCheck={false}
          placeholder={apiFormat === "anthropic-messages"
            ? "例如：https://model-gateway.internal/api/anthropic"
            : "例如：https://model-gateway.internal/v1"}
          onChange={(event) => setUrl(event.target.value)} />
        <small className="knob-note">
          {apiFormat === "anthropic-messages"
            ? "Anthropic Messages 兼容接口(请求发往 地址/v1/messages)。"
            : "OpenAI Chat 兼容接口(请求发往 地址/chat/completions)。"}
        </small>
      </label>
      <label className="span-2">
        <span>API Key</span>
        <input value={apiKey} type="password" autoComplete="new-password"
          required={!models.configured}
          placeholder={models.configured
            ? `已保存 ${models.key_hint ?? "密钥"}，留空保持不变`
            : defaults.configured
              ? "覆盖服务默认配置时请输入新的 API Key"
              : "请输入模型网关 API Key"}
          onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <label>
        <span>模型名称</span>
        <input value={model} required spellCheck={false}
          placeholder="例如：glm-5.1"
          onChange={(event) => setModel(event.target.value)} />
      </label>
      <label>
        <span>接口格式</span>
        <select value={apiFormat}
          onChange={(event) => setApiFormat(event.target.value)}>
          <option value="openai-completions">OpenAI Chat</option>
          <option value="anthropic-messages">Anthropic</option>
        </select>
        <small className="knob-note">按网关实际提供的接口协议选择</small>
      </label>
      <div className="settings-form-actions">
        <button type="submit" disabled={busy || testing}>
          {busy ? "正在保存…" : "保存模型配置"}</button>
        <button type="button" disabled={busy || testing} onClick={() => void runCheck()}>
          {testing ? "测试中…" : "测试连通"}</button>
      </div>
      <small className="knob-note">测试使用当前表单值向网关发送一条极小请求（密钥留空时沿用已保存的）。</small>
      <Feedback message={message} />
      {checkError && <div className="form-message error">{checkError}</div>}
      {testing && !checkResult && !checkError
        && <div className="settings-loading">正在连通网关并等待模型回复…</div>}
      {checkResult && <>
        <span className={`check-summary ${checkResult.overall}`}>
          <i aria-hidden />{checkResult.overall === "ok"
            ? "网络与模型问答均正常" : "存在问题，见下方明细"}</span>
        <CheckItems result={checkResult} />
      </>}
    </form>
  </div>;
}

function VisionModelsCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const vision = view.models.vision;
  const defaults = view.defaults.models.vision;
  const savedUrl = vision.url ?? defaults.url ?? "";
  const savedModel = vision.model ?? defaults.model ?? "";
  const savedApi = vision.api ?? defaults.api ?? "openai-completions";
  const [url, setUrl] = useState(savedUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(savedModel);
  const [api, setApi] = useState(savedApi);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useMessage();
  const [probe, setProbe] = useState<VisionProbeResult>();
  const configured = vision.configured || defaults.configured;
  const dirty = url.trim() !== savedUrl || model.trim() !== savedModel
    || api !== savedApi || !!apiKey.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(null); setProbe(undefined);
    try {
      onSaved(await putVisionSettings({
        url: url.trim(),
        api_key: apiKey.trim(),
        model: model.trim(),
        api,
      }));
      setApiKey("");
      setMessage({ kind: "success",
        text: "图片识别配置已保存。请点击“测试识图能力”验证真实调用。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setMessage(null); setProbe(undefined);
    try { setProbe(await testVisionCapability()); }
    catch (error) {
      setProbe({ status: "failed", provider: "", model: "", latency_ms: 0,
        error: String((error as Error).message ?? error) });
    } finally { setTesting(false); }
  }

  return <div className="user-create-card settings-card vision-settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">IMAGE UNDERSTANDING</span>
      <h2>图片识别</h2>
      <p>主 Agent 需要看截图、图表或照片时，才会调用独立的 InspectImage
        工具。主会话模型不会被替换，图片原文也不会写入任务记录。</p>
      <span className={`settings-state ${configured ? "ok" : "missing"}`}>
        <i aria-hidden />{vision.configured
          ? `已配置${vision.key_hint ? ` · Key ${vision.key_hint}` : ""}`
          : defaults.configured
            ? `使用服务默认配置${defaults.model ? ` · ${defaults.model}` : ""}`
            : "尚未配置"}
      </span>
    </div>
    <form className="user-create-form settings-form" onSubmit={submit}>
      <label className="span-2">
        <span>图片识别网关地址</span>
        <input value={url} type="url" required spellCheck={false}
          placeholder="例如：https://qwen-vl.internal/v1"
          onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label>
        <span>接口协议</span>
        <select value={api} onChange={(event) => setApi(event.target.value)}>
          <option value="openai-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </label>
      <label>
        <span>模型名称</span>
        <input value={model} required spellCheck={false}
          placeholder="例如：qwen2.5-vl-72b-instruct"
          onChange={(event) => setModel(event.target.value)} />
      </label>
      <label className="span-2">
        <span>API Key</span>
        <input value={apiKey} type="password" autoComplete="new-password"
          required={!configured}
          placeholder={vision.configured
            ? `已保存 ${vision.key_hint ?? "密钥"}，留空保持不变`
            : defaults.configured
              ? "覆盖服务默认配置时请输入新的 API Key"
              : "请输入图片识别网关 API Key"}
          onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <div className="vision-settings-actions span-2">
        <button type="submit" disabled={saving || testing}>
          {saving ? "正在保存…" : "保存图片识别配置"}</button>
        <button type="button" className="secondary"
          disabled={!configured || dirty || saving || testing}
          onClick={() => void test()}>
          {testing ? "正在识别测试图…" : dirty ? "请先保存再测试" : "测试识图能力"}</button>
      </div>
      {!configured && <small className="vision-test-note span-2">
        保存配置后即可进行真实测试。</small>}
      <Feedback message={message} />
      {probe && <div className={`vision-probe-result ${probe.status}`} role="status">
        <strong>{probe.status === "ready" ? "识图能力已就绪" : "识图测试未通过"}</strong>
        <span>{probe.status === "ready"
          ? `${probe.provider}/${probe.model} · ${probe.latency_ms} ms`
          : probe.error ?? "未知错误"}</span>
        {probe.response && <details>
          <summary>查看模型观察</summary>
          <small>{probe.response}</small>
        </details>}
      </div>}
    </form>
  </div>;
}

export function SettingsBoard() {
  const [view, setView] = useState<Settings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings().then(setView).catch((cause) =>
      setError(String((cause as Error).message ?? cause)));
  }, []);

  if (error) return <section className="user-admin">
    <div className="form-message error">{error}</div></section>;
  if (!view) return <section className="user-admin">
    <div className="settings-loading">正在读取设置…</div></section>;

  // 两张设置卡共享同一份视图:任一保存返回完整 view,整页跟着刷新,
  // 掩码提示(末4位)因此始终是服务端刚确认过的事实。
  return <section className="user-admin settings-board">
    <SystemCheckCard />
    <ModelsCard key={`m${view.models.url}:${view.models.model}:${view.models.key_hint}`}
      view={view} onSaved={setView} />
    <VisionModelsCard
      key={`v${view.models.vision.url}:${view.models.vision.model}:${view.models.vision.key_hint}`}
      view={view} onSaved={setView} />
    <ExecutionPolicyCard
      key={`p${view.execution_policy.team_instructions ?? ""}`}
      view={view} onSaved={setView} />
    <RuntimeCard key={`r${JSON.stringify(view.runtime)}:${JSON.stringify(view.defaults.runtime)}`}
      view={view} onSaved={setView} />
    <BuildCacheCard view={view} onSaved={setView} />
  </section>;
}
