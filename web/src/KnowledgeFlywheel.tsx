import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSkillLibrary,
  listSkillVersions,
  offlineSkill,
  rollbackSkill,
  uploadSkill,
  type HostSkillShelf,
  type KnowledgeInsightResource,
  type KnowledgeKind,
  type SkillOperationRecord,
  type SkillUploadFile,
  type SkillVersionRecord,
  type TeamKnowledgeInsights,
} from "./api";

const KIND_LABEL: Record<KnowledgeKind, string> = {
  rules: "项目规则",
  document: "业务文档",
  skill: "Skill",
};

function repositoryName(value?: string): string {
  if (!value) return "未标注仓库";
  const clean = value.replace(/\/+$/, "");
  return clean.split("/").at(-1)?.replace(/\.git$/i, "") || value;
}

function latest(value?: string): string {
  if (!value) return "尚未主动访问";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `最近 ${date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  })}`;
}

function ResourceRow({ resource }: { resource: KnowledgeInsightResource }) {
  const reach = resource.provided_tasks > 0
    ? Math.round(resource.accessed_tasks / resource.provided_tasks * 100) : 0;
  return <article className={`knowledge-rank kind-${resource.kind}`}>
    <span className="knowledge-rank-kind">{KIND_LABEL[resource.kind]}</span>
    <div className="knowledge-rank-main">
      <strong title={resource.name}>{resource.name}</strong>
      <span title={`${resource.repository ?? ""} · ${resource.path}`}>
        {repositoryName(resource.repository)} · {resource.path}
      </span>
    </div>
    <div className="knowledge-rank-reach" title={`${resource.provided_tasks} 个任务可用，${resource.accessed_tasks} 个主动访问`}>
      <span><i style={{ width: `${reach}%` }} /></span>
      <small>{resource.accessed_tasks}/{resource.provided_tasks} 任务访问</small>
    </div>
    <div className="knowledge-rank-outcome">
      <strong>{resource.access_events}</strong><small>访问</small>
      <strong>{resource.completed_tasks}</strong><small>交付</small>
      <strong className={resource.repair_tasks ? "attention" : ""}>{resource.repair_tasks}</strong><small>修复</small>
    </div>
    <time dateTime={resource.last_used_at}>{latest(resource.last_used_at)}</time>
  </article>;
}

const OPERATION_LABEL: Record<SkillOperationRecord["action"], string> = {
  upload: "上架",
  update: "更新",
  offline: "下线",
  rollback: "回退",
};

/** 浏览器文件 → 上传载荷。目录选择时剥掉首段(那是所选文件夹名,
 * 目录名由输入框决定);.DS_Store 之类点开头的杂物在这里就滤掉,
 * 免得整包被服务端(不收点开头路径)拒了。 */
async function encodeUpload(list: FileList): Promise<{
  files: SkillUploadFile[];
  folder?: string;
  skipped: string[];
}> {
  const files: SkillUploadFile[] = [];
  const skipped: string[] = [];
  let folder: string | undefined;
  for (const file of Array.from(list)) {
    const relative = (file as unknown as { webkitRelativePath?: string })
      .webkitRelativePath;
    let path = file.name;
    if (relative && relative.includes("/")) {
      const segments = relative.split("/");
      folder = segments[0];
      path = segments.slice(1).join("/");
    }
    if (path.split("/").some((segment) => segment.startsWith("."))) {
      skipped.push(path);
      continue;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    }
    files.push({ path, content_base64: btoa(binary) });
  }
  return { files, folder, skipped };
}

function directoryOf(skill: { path: string }): string | undefined {
  const segments = skill.path.split("/");
  return segments.length > 1 ? segments[0] : undefined;
}

/** 货架与足迹互补:足迹只看得见被任务带过的资源,放坏了的 skill 在
 * 足迹里隐形,货架把"现在生效的是什么"照出来——包括不可装载的。
 * 管理员在同一张货架上换货:上传/更新/下线/回退,写进数据目录即对
 * 下一单生效;面板自己刷新自己,不用整页重取知识效能。 */
function SkillLibraryPanel({ fallback, admin }: {
  fallback?: HostSkillShelf;
  admin: boolean;
}) {
  const [library, setLibrary] = useState<
    HostSkillShelf & { operations: SkillOperationRecord[] }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [pending, setPending] = useState<{
    files: SkillUploadFile[]; skipped: string[] }>();
  const [confirmOffline, setConfirmOffline] = useState("");
  const [versionsFor, setVersionsFor] = useState("");
  const [versions, setVersions] = useState<SkillVersionRecord[]>();
  const [showOperations, setShowOperations] = useState(false);
  const newInputRef = useRef<HTMLInputElement>(null);
  const updateInputRef = useRef<HTMLInputElement>(null);
  const updateTargetRef = useRef("");

  const refresh = () => getSkillLibrary()
    .then((data) => { setLibrary(data); setError(""); })
    .catch((cause) => setError(String(cause instanceof Error ? cause.message : cause)));
  useEffect(() => { void refresh(); }, []);

  const shelf: HostSkillShelf | undefined = library ?? fallback;
  const operations = library?.operations ?? [];

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try {
      await work();
      await refresh();
      if (versionsFor) setVersions(await listSkillVersions(versionsFor));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  };

  const pickFiles = async (list: FileList | null, target?: string) => {
    if (!list || list.length === 0) return;
    const encoded = await encodeUpload(list);
    if (target) {
      // 行内更新:目录已定,选完即提交。
      await run(() => uploadSkill(target, encoded.files));
      return;
    }
    setPending({ files: encoded.files, skipped: encoded.skipped });
    if (!uploadName && encoded.folder) setUploadName(encoded.folder);
  };

  if (!shelf && !admin) return null;

  return <div className="knowledge-shelf" aria-label="团队 Skill 资产库">
    <div className="knowledge-panel-head">
      <div><strong>团队 Skill 资产库</strong><small>当前生效的团队资产;每个新任务自动装载,上架/下线即时生效,无需重启。</small></div>
      <div className="knowledge-shelf-head-actions">
        <span>{shelf?.skills.length ?? 0} 项</span>
        {admin && <button type="button" className="knowledge-shelf-action primary"
          onClick={() => { setUploadOpen((open) => !open); setPending(undefined); setUploadName(""); }}>
          {uploadOpen ? "收起上架" : "上架 Skill"}
        </button>}
      </div>
    </div>

    {error && <div className="knowledge-shelf-error" role="alert">{error}</div>}

    {admin && uploadOpen && <div className="knowledge-shelf-upload">
      <p>选含 SKILL.md 的技能包目录(frontmatter 需有 name/description)。上传前服务端会做密钥掩码扫描——skill 权限全开,令牌/密码一律拒收。</p>
      <div className="knowledge-shelf-upload-row">
        <input type="text" placeholder="目录名,如 java-autout" value={uploadName}
          onChange={(event) => setUploadName(event.target.value.trim())} />
        <button type="button" onClick={() => newInputRef.current?.click()}>选技能包目录</button>
        <button type="button" disabled={busy || !pending || !uploadName}
          className="knowledge-shelf-action primary"
          onClick={() => pending && void run(async () => {
            await uploadSkill(uploadName, pending.files);
            setPending(undefined); setUploadOpen(false);
          })}>
          {busy ? "上架中" : `确认上架${pending ? `(${pending.files.length} 个文件)` : ""}`}
        </button>
      </div>
      {pending && <small>
        已选 {pending.files.length} 个文件
        {pending.files.some((file) => file.path === "SKILL.md") ? "" : ";⚠ 缺少根级 SKILL.md,会被拒收"}
        {pending.skipped.length > 0 && `;已滤掉 ${pending.skipped.length} 个点开头杂物`}
      </small>}
      <input ref={newInputRef} type="file" multiple hidden
        {...({ webkitdirectory: "" } as object)}
        onChange={(event) => { void pickFiles(event.target.files); event.target.value = ""; }} />
    </div>}

    {shelf && !shelf.root_exists && !admin && <div className="knowledge-shelf-empty">本部署尚未放置团队 Skill。管理员上架后,新任务即自动装载。</div>}
    {shelf && (shelf.root_exists || admin) && shelf.skills.length === 0 && <div className="knowledge-shelf-empty">货架是空的——{admin ? "点「上架 Skill」传入含 SKILL.md 的技能包,新任务即自动装载。" : "管理员上架后,新任务即自动装载。"}</div>}

    {shelf?.skills.map((skill) => {
      const directory = directoryOf(skill);
      return <article className={`knowledge-shelf-row${skill.loadable ? "" : " broken"}`} key={skill.path}>
        <div className="knowledge-shelf-main">
          <strong>{skill.name}</strong>
          {!skill.loadable && <span className="knowledge-shelf-badge" title="pi 装载器未接受,任何会话都不会带上它;检查 SKILL.md frontmatter 的 name/description">不可装载</span>}
          <p>{skill.description || "(没有描述——模型靠描述判断何时读取,建议补上)"}</p>
        </div>
        <div className="knowledge-shelf-meta">
          <span title={`SKILL.md 内容 sha256:${skill.digest}`}>版本 {skill.digest.slice(0, 8)}</span>
          <span>{skill.path}</span>
          <time dateTime={skill.updated_at}>{latest(skill.updated_at).replace("最近 ", "更新 ")}</time>
        </div>
        {admin && directory && <div className="knowledge-shelf-actions">
          <button type="button" disabled={busy} onClick={() => {
            updateTargetRef.current = directory;
            updateInputRef.current?.click();
          }}>更新</button>
          <button type="button" disabled={busy} onClick={() => void (async () => {
            if (versionsFor === directory) { setVersionsFor(""); setVersions(undefined); return; }
            setVersionsFor(directory); setVersions(undefined);
            try { setVersions(await listSkillVersions(directory)); }
            catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
          })()}>{versionsFor === directory ? "收起历史" : "历史版本"}</button>
          {confirmOffline === directory
            ? <button type="button" className="danger" disabled={busy}
              onClick={() => { setConfirmOffline(""); void run(() => offlineSkill(directory)); }}>确认下线?</button>
            : <button type="button" disabled={busy}
              onClick={() => setConfirmOffline(directory)}>下线</button>}
        </div>}
        {versionsFor === directory && <div className="knowledge-shelf-versions">
          {!versions && <small>读取版本痕…</small>}
          {versions && versions.length === 0 && <small>还没有归档版本(第一次覆盖/下线时自动归档)。</small>}
          {versions?.map((version) => <div key={version.version_id} className="knowledge-shelf-version">
            <span title={version.version_id}>{OPERATION_LABEL[version.action as SkillOperationRecord["action"]] ?? version.action}归档 · 指纹 {version.skill_digest.slice(0, 8)}</span>
            <span>{version.operator} · {latest(version.archived_at).replace("最近 ", "")}</span>
            <button type="button" disabled={busy}
              onClick={() => void run(() => rollbackSkill(directory, version.version_id))}>回退到此版</button>
          </div>)}
        </div>}
      </article>;
    })}
    {admin && <input ref={updateInputRef} type="file" multiple hidden
      {...({ webkitdirectory: "" } as object)}
      onChange={(event) => {
        void pickFiles(event.target.files, updateTargetRef.current);
        event.target.value = "";
      }} />}

    {shelf && shelf.warnings.length > 0 && <div className="knowledge-shelf-warnings" role="note">
      {shelf.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
    </div>}

    {operations.length > 0 && <div className="knowledge-shelf-operations">
      <button type="button" onClick={() => setShowOperations((show) => !show)}>
        {showOperations ? "收起操作留痕" : `操作留痕(${operations.length})`}
      </button>
      {showOperations && operations.map((operation, index) => <div key={`${operation.at}-${index}`} className="knowledge-shelf-operation">
        <span className={`op-${operation.action}`}>{OPERATION_LABEL[operation.action]}</span>
        <strong>{operation.directory}</strong>
        <span>{operation.operator}</span>
        {operation.skill_digest && <span title={operation.skill_digest}>指纹 {operation.skill_digest.slice(0, 8)}</span>}
        {operation.detail && <span>{operation.detail}</span>}
        <time dateTime={operation.at}>{latest(operation.at).replace("最近 ", "")}</time>
      </div>)}
    </div>}
  </div>;
}

export function KnowledgeFlywheel({
  insights,
  loading,
  error,
  onRetry,
  onOpenTask,
  admin = false,
}: {
  insights?: TeamKnowledgeInsights;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenTask: (taskId: string) => void;
  admin?: boolean;
}) {
  const [kind, setKind] = useState<"all" | KnowledgeKind>("all");
  const [repository, setRepository] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const repositories = useMemo(() => [...new Set(
    (insights?.resources ?? []).map((item) => item.repository)
      .filter((item): item is string => !!item),
  )].sort(), [insights]);
  const filtered = useMemo(() => (insights?.resources ?? []).filter((item) =>
    (kind === "all" || item.kind === kind)
      && (repository === "all" || item.repository === repository)),
  [insights, kind, repository]);
  const visible = showAll ? filtered : filtered.slice(0, 6);

  return <section className="knowledge-flywheel" aria-labelledby="knowledge-flywheel-title">
    <header className="knowledge-flywheel-head">
      <div className="knowledge-flywheel-title">
        <span className="knowledge-flywheel-icon" aria-hidden>知</span>
        <div><span className="section-kicker">KNOWLEDGE FLYWHEEL</span><h2 id="knowledge-flywheel-title">团队知识效能</h2><p>从“提供”到“主动访问”再到交付结果，发现值得沉淀和需要补齐的业务知识。</p></div>
      </div>
      <div className="knowledge-flywheel-refresh">
        {insights && <small>更新于 {latest(insights.generated_at).replace("最近 ", "")}</small>}
        {error && insights && <small className="knowledge-flywheel-stale" title={error}>刷新失败，展示上次结果</small>}
        <button type="button" onClick={onRetry} disabled={loading} aria-label="刷新知识效能">
          <svg viewBox="0 0 18 18" aria-hidden><path d="M14.5 6.5A5.75 5.75 0 1 0 15 11M14.5 3v3.5H11" /></svg>
          {loading ? "统计中" : "刷新"}
        </button>
      </div>
    </header>

    {error && !insights && <div className="knowledge-flywheel-error" role="alert"><strong>知识效能暂时不可用</strong><span>{error}</span><button type="button" onClick={onRetry}>重新读取</button></div>}
    {loading && !insights && <div className="knowledge-flywheel-loading" aria-label="正在统计知识效能"><i /><i /><i /></div>}
    {insights && insights.summary.tracked_tasks === 0 && <div className="knowledge-flywheel-empty"><span aria-hidden>◎</span><div><strong>知识飞轮正在等待第一批数据</strong><p>新任务开始选择或读取业务知识后，这里会自动出现使用趋势和改进建议；旧任务不会被猜测补数。</p></div></div>}

    <SkillLibraryPanel fallback={insights?.host_skills} admin={admin} />

    {insights && insights.summary.tracked_tasks > 0 && <>
      <div className="knowledge-flywheel-metrics" aria-label="知识效能摘要">
        <div><span>已追踪任务</span><strong>{insights.summary.tracked_tasks}</strong><small>采用新知识口径</small></div>
        <div><span>主动访问率</span><strong>{insights.summary.access_rate}<em>%</em></strong><small>{insights.summary.accessed_tasks} 个任务真正读取</small></div>
        <div><span>活跃知识</span><strong>{insights.summary.active_resources}</strong><small>共识别 {insights.summary.unique_resources} 项</small></div>
        <div className={insights.summary.opportunities ? "attention" : "positive"}><span>改进机会</span><strong>{insights.summary.opportunities}</strong><small>{insights.summary.selected_unused} 项选而未用</small></div>
      </div>

      <div className="knowledge-flywheel-body">
        <div className="knowledge-ranking">
          <div className="knowledge-panel-head"><div><strong>知识使用排行</strong><small>访问表示 Agent 主动读取或检索，不把“被提供”冒充“已使用”。</small></div><span>{filtered.length} 项</span></div>
          <div className="knowledge-filterbar">
            <div role="group" aria-label="按知识类型筛选">
              {(["all", "rules", "document", "skill"] as const).map((value) => <button type="button" key={value} className={kind === value ? "on" : ""} aria-pressed={kind === value} onClick={() => { setKind(value); setShowAll(false); }}>{value === "all" ? "全部" : KIND_LABEL[value]}</button>)}
            </div>
            {repositories.length > 1 && <select aria-label="按仓库筛选知识" value={repository} onChange={(event) => { setRepository(event.target.value); setShowAll(false); }}><option value="all">全部仓库</option>{repositories.map((item) => <option value={item} key={item}>{repositoryName(item)}</option>)}</select>}
          </div>
          <div className="knowledge-ranking-list">
            {visible.map((item) => <ResourceRow key={item.key} resource={item} />)}
            {filtered.length === 0 && <div className="knowledge-ranking-empty">当前筛选下还没有知识使用记录。</div>}
          </div>
          {filtered.length > 6 && <button type="button" className="knowledge-show-all" onClick={() => setShowAll((current) => !current)}>{showAll ? "收起" : `查看全部 ${filtered.length} 项`}</button>}
        </div>

        <aside className="knowledge-opportunities">
          <div className="knowledge-panel-head"><div><strong>下一步怎么改</strong><small>建议只辅助知识运营，不会自动改仓库或卡住任务。</small></div><span>{insights.recommendations.length} 条</span></div>
          <div className="knowledge-opportunity-list">
            {insights.recommendations.map((item) => <article className={`tone-${item.tone}`} key={item.id}>
              <i aria-hidden>{item.tone === "positive" ? "✓" : item.tone === "attention" ? "!" : "i"}</i>
              <div><strong>{item.title}</strong><p>{item.evidence}</p><small>{item.action}</small>{!!item.task_ids?.length && <div className="knowledge-task-links"><span>相关任务</span>{item.task_ids.map((taskId) => <button type="button" key={taskId} onClick={() => onOpenTask(taskId)}>{taskId}</button>)}</div>}</div>
            </article>)}
            {insights.recommendations.length === 0 && <div className="knowledge-opportunity-empty"><span aria-hidden>✓</span><div><strong>暂时没有足够样本形成建议</strong><small>继续积累真实任务，不用为了填满面板制造结论。</small></div></div>}
          </div>
        </aside>
      </div>
      <footer className="knowledge-flywheel-note"><span>口径</span>“提供、加载、主动访问”分开统计；交付与修复只做相关性参考，不代表某份知识直接导致成功或失败。</footer>
    </>}
  </section>;
}
