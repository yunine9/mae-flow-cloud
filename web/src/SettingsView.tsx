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
  getSettings,
  getSystemCheck,
  putModelsSettings,
  putRuntimeSettings,
  type SettingsView as Settings,
  type SystemCheckResult,
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
    {result && <div className="system-check-grid">{result.items.map((item) => <article className={`system-check-item ${item.status}`} key={item.key}>
      <span className="check-icon" aria-hidden>{item.status === "ok" ? "✓" : item.status === "error" ? "!" : "·"}</span>
      <div><strong>{item.label}</strong><p>{item.detail}</p>{item.suggestion && <small>{item.suggestion}</small>}</div>
    </article>)}</div>}
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
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存运行参数"}</button>
      <Feedback message={message} />
    </form>
  </div>;
}

function ModelsCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const models = view.models;
  const defaults = view.defaults.models;
  const [url, setUrl] = useState(models.url ?? defaults.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(models.model ?? defaults.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putModelsSettings({
        url: url.trim(),
        api_key: apiKey.trim(),
        model: model.trim(),
      }));
      setApiKey("");
      setMessage({ kind: "success",
        text: "已保存；下一个新任务使用新配置，运行中的任务不受影响。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
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
          placeholder="例如：https://model-gateway.internal/api/anthropic"
          onChange={(event) => setUrl(event.target.value)} />
        <small className="knob-note">当前接入 Anthropic Messages 兼容接口。</small>
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
      <label className="span-2">
        <span>模型名称</span>
        <input value={model} required spellCheck={false}
          placeholder="例如：glm-5.1"
          onChange={(event) => setModel(event.target.value)} />
      </label>
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存模型配置"}</button>
      <Feedback message={message} />
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
    <RuntimeCard key={`r${JSON.stringify(view.runtime)}:${JSON.stringify(view.defaults.runtime)}`}
      view={view} onSaved={setView} />
  </section>;
}
