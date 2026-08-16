/**
 * 服务设置(管理员页)——运行时可热改的那层:运行参数/通知/模型网关。
 * 部署形态(仓库/平台/端口)不在这儿,那些改了要重启+过自查清单。
 *
 * 两条纪律,和服务端 settings.ts 一体:
 * - 密钥只写不读:界面只见掩码(••••末4位),输入框永远从空白开始,
 *   留空=保持现状;所以"改一个键"由服务端按键合并,前端不回填明文。
 * - 生效边界如实告知:并发=下一次调度,修复轮/轮询=下一次红灯/轮询,
 *   通知=下一条消息,模型=下一个新会话——不承诺"立刻"。
 */

import { useEffect, useState } from "react";
import {
  getSettings,
  putLubanSettings,
  putModelsSettings,
  putRuntimeSettings,
  putServiceSettings,
  testLuban,
  type SettingsView as Settings,
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

/** 数字项:显示当前覆盖值,空=用部署值。提交空串服务端清掉覆盖。 */
function KnobField({ label, note, value, onChange }: {
  label: string; note: string;
  value: string; onChange: (next: string) => void;
}) {
  return <label>
    <span>{label}</span>
    <input inputMode="numeric" value={value} placeholder="留空 = 用部署值"
      onChange={(event) => onChange(event.target.value)} />
    <small className="knob-note">{note}</small>
  </label>;
}

function RuntimeCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const runtime = view.runtime;
  const text = (value?: number) => value === undefined ? "" : String(value);
  const [concurrent, setConcurrent] = useState(text(runtime.max_concurrent));
  const [repair, setRepair] = useState(text(runtime.repair_rounds));
  const [interval, setInterval_] = useState(text(runtime.poll_interval_s));
  const [timeout_, setTimeout_] = useState(text(runtime.poll_timeout_s));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();

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
      setMessage({ kind: "success", text: "已保存;各项按右侧说明的边界生效。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div className="user-create-card settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">RUNTIME</span>
      <h2>运行参数</h2>
      <p>等待都带预算——“无限等待”不是合法取值。修复轮默认不限
        （修到绿为止，收敛靠“没新提交即停+原地打转出诊断”两道刹车），
        数字是可选的手刹，0 表示完全关掉自动修复。</p>
    </div>
    <form className="user-create-form settings-form" onSubmit={submit}>
      <KnobField label="并发任务数" note="生效于下一次调度决策"
        value={concurrent} onChange={setConcurrent} />
      <KnobField label="流水线修复轮上限（手刹）"
        note="生效于下一次红灯；0=关闭修复环；各层都不配=不限轮，修到绿或修复会话出诊断为止"
        value={repair} onChange={setRepair} />
      <KnobField label="流水线轮询间隔（秒）" note="生效于下一轮轮询"
        value={interval} onChange={setInterval_} />
      <KnobField label="流水线轮询预算（秒）" note="超预算如实停在“验证中”请人工"
        value={timeout_} onChange={setTimeout_} />
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存运行参数"}</button>
      <Feedback message={message} />
    </form>
  </div>;
}

function ServiceCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const service = view.service;
  const [platformUrl, setPlatformUrl] = useState(service.platform_url ?? "");
  const [defaultRepo, setDefaultRepo] = useState(service.default_repo ?? "");
  const [verify, setVerify] = useState(
    service.verify_via_pipeline === undefined
      ? "" : String(service.verify_via_pipeline));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putServiceSettings({
        platform_url: platformUrl,
        default_repo: defaultRepo,
        verify_via_pipeline: verify,
      }));
      setMessage({ kind: "success",
        text: "已保存;平台/默认仓生效于下一次交付动作,免编译生效于下一个新会话。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div className="user-create-card settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">DELIVERY</span>
      <h2>交付与形态</h2>
      <p>平台适配层地址、默认交付仓、免编译开关——原来是启动项，
        现在在这儿热改。唯一要重启的例外：服务启动时既没有 --repo
        也没有这里的默认仓，内核模式没开；首次配好默认仓后重启一次。
        开免编译前确认平台地址在场，否则没人裁判。</p>
    </div>
    <form className="user-create-form settings-form" onSubmit={submit}>
      <label className="span-2">
        <span>平台适配层地址（MR / 流水线）</span>
        <input value={platformUrl} placeholder="http://127.0.0.1:8790（留空=用部署值）"
          onChange={(event) => setPlatformUrl(event.target.value)} />
      </label>
      <label className="span-2">
        <span>默认交付代码仓（下单不填时用它）</span>
        <input value={defaultRepo} spellCheck={false}
          placeholder="https://codehub…/xxx.git（不许带账号密码）"
          onChange={(event) => setDefaultRepo(event.target.value)} />
      </label>
      <label>
        <span>免编译（编译/UT/CodeCheck 交流水线）</span>
        <select value={verify}
          onChange={(event) => setVerify(event.target.value)}>
          <option value="">跟随部署启动项</option>
          <option value="true">开启</option>
          <option value="false">关闭</option>
        </select>
      </label>
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存交付配置"}</button>
      <Feedback message={message} />
    </form>
  </div>;
}

function LubanCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const [endpoint, setEndpoint] = useState(view.luban.endpoint ?? "");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const headers: Record<string, string> = {};
      if (headerName.trim()) headers[headerName.trim()] = headerValue;
      onSaved(await putLubanSettings({ endpoint, headers }));
      setHeaderName(""); setHeaderValue("");
      setMessage({ kind: "success", text: "已保存;下一条通知走新配置。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  async function removeHeader(name: string) {
    setBusy(true); setMessage(null);
    try {
      // 空串=删除:服务端按键合并的删除语法。
      onSaved(await putLubanSettings({ headers: { [name]: "" } }));
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  async function runTest() {
    setBusy(true); setMessage(null);
    try {
      const result = await testLuban();
      setMessage(result.ok
        ? { kind: "success", text: "测试消息已送达通知端点。" }
        : { kind: "error", text: `投递失败:${result.error ?? "未知原因"}` });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div className="user-create-card settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">NOTIFY</span>
      <h2>通知投递（小鲁班 / WeLink）</h2>
      <p>鉴权头只写不读：这里永远见不到明文，只显示末 4 位。
        改一个键不影响其他键；测试按钮发一条真实消息验证连通。</p>
      {view.luban.headers.length > 0 && <ul className="secret-list">
        {view.luban.headers.map((header) => <li key={header.name}>
          <code>{header.name}</code><span className="secret-hint">{header.hint}</span>
          <button type="button" className="secret-remove" disabled={busy}
            onClick={() => removeHeader(header.name)}>删除</button>
        </li>)}
      </ul>}
    </div>
    <form className="user-create-form settings-form" onSubmit={submit}>
      <label className="span-2">
        <span>投递端点 URL</span>
        <input value={endpoint} placeholder="http://内网通知服务/notify"
          onChange={(event) => setEndpoint(event.target.value)} />
      </label>
      <label>
        <span>鉴权头名（如 Authorization）</span>
        <input value={headerName} autoComplete="off"
          onChange={(event) => setHeaderName(event.target.value)} />
      </label>
      <label>
        <span>鉴权头值（保存后只显示末 4 位）</span>
        <input type="password" value={headerValue} autoComplete="new-password"
          placeholder="留空名则本次不改鉴权头"
          onChange={(event) => setHeaderValue(event.target.value)} />
      </label>
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存通知配置"}</button>
      <button type="button" className="secondary-button" disabled={busy}
        onClick={runTest}>发送测试消息</button>
      <Feedback message={message} />
    </form>
  </div>;
}

function ModelsCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const models = view.models;
  const [json, setJson] = useState("");
  const [provider, setProvider] = useState(models.provider ?? "");
  const [model, setModel] = useState(models.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();
  const providerSpec = models.providers.find((item) => item.name === provider);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      let parsed: unknown;
      if (json.trim()) {
        try { parsed = JSON.parse(json); } catch {
          throw new Error("models.json 内容不是合法 JSON");
        }
      }
      onSaved(await putModelsSettings({
        ...(parsed !== undefined ? { json: parsed } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      }));
      setJson("");
      setMessage({ kind: "success",
        text: "已保存;下一个新会话用新网关,在跑的会话不换血。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div className="user-create-card settings-card">
    <div className="user-create-copy">
      <span className="section-kicker">MODEL GATEWAY</span>
      <h2>模型网关</h2>
      <p>粘贴整份 models.json 同形内容（含网关地址与 apiKey），
        再选默认 provider / 模型。apiKey 保存后只显示末 4 位；
        未配置时任务用部署启动时给的模型。</p>
      {models.providers.length > 0 && <ul className="secret-list">
        {models.providers.map((item) => <li key={item.name}>
          <code>{item.name}</code>
          <span className="secret-hint">
            {item.models.join("、") || "无模型"}
            {item.key_hint ? ` · key ${item.key_hint}` : ""}
          </span>
        </li>)}
      </ul>}
    </div>
    <form className="user-create-form settings-form" onSubmit={submit}>
      <label className="span-2">
        <span>models.json 内容（留空 = 保持现有配置）</span>
        <textarea value={json} rows={6} spellCheck={false}
          placeholder='{"providers": {"名字": {"baseUrl": "…", "apiKey": "…", "models": [{"id": "…"}]}}}'
          onChange={(event) => setJson(event.target.value)} />
      </label>
      <label>
        <span>默认 provider</span>
        {models.providers.length > 0 && !json.trim()
          ? <select value={provider}
              onChange={(event) => { setProvider(event.target.value); setModel(""); }}>
              <option value="">（不指定）</option>
              {models.providers.map((item) =>
                <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          : <input value={provider} placeholder="与 json 里的键一致"
              onChange={(event) => setProvider(event.target.value)} />}
      </label>
      <label>
        <span>默认模型</span>
        {providerSpec && !json.trim()
          ? <select value={model}
              onChange={(event) => setModel(event.target.value)}>
              <option value="">（不指定）</option>
              {providerSpec.models.map((id) =>
                <option key={id} value={id}>{id}</option>)}
            </select>
          : <input value={model} placeholder="与 provider 的 models 里的 id 一致"
              onChange={(event) => setModel(event.target.value)} />}
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

  // 三张卡共享同一份视图:任一保存返回完整 view,整页跟着刷新,
  // 掩码提示(末4位)因此始终是服务端刚确认过的事实。
  return <section className="user-admin settings-board">
    <ServiceCard key={`s${JSON.stringify(view.service)}`}
      view={view} onSaved={setView} />
    <RuntimeCard key={`r${JSON.stringify(view.runtime)}`}
      view={view} onSaved={setView} />
    <LubanCard key={`l${view.luban.endpoint}:${view.luban.headers.length}`}
      view={view} onSaved={setView} />
    <ModelsCard key={`m${view.models.provider}:${view.models.model}:${view.models.providers.length}`}
      view={view} onSaved={setView} />
  </section>;
}
