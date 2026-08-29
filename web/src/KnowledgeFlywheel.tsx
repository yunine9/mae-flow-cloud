import { useEffect, useMemo, useRef, useState } from "react";
import {
  adoptSkillCandidate,
  approveSkillSubmission,
  discardSkillCandidate,
  distillSkill,
  getBusinessModules,
  getSkillCandidate,
  getSkillDocument,
  getSkillLibrary,
  listSkillCandidates,
  listSkillSubmissions,
  listSkillVersions,
  listKnowledgeCandidates as listTaskKnowledgeCandidates,
  offlineSkill,
  publishKnowledgeCandidate,
  rejectKnowledgeCandidate,
  rejectSkillSubmission,
  rollbackSkill,
  submitSkill,
  updateSkillKnowledgeMetadata,
  uploadSkill,
  type BusinessModule,
  type HostSkillDocument,
  type HostSkillShelf,
  type KnowledgeInsightResource,
  type KnowledgeKind,
  type KnowledgeCandidateRecord,
  type SkillCandidateRecord,
  type SkillOperationRecord,
  type SkillSubmissionRecord,
  type SkillKnowledgeMetadataInput,
  type KnowledgeNature,
  type SkillUploadFile,
  type SkillVersionRecord,
  type TeamKnowledgeInsights,
} from "./api";
import {
  KnowledgeLanguageFilter,
  KnowledgeLanguageTags,
  matchesKnowledgeLanguage,
} from "./KnowledgeLanguages";
import {
  skillMetadataInput,
  EMPTY_SKILL_METADATA,
  SkillMetadataEditor,
  SkillMetadataTags,
  type SkillMetadataDraft,
} from "./KnowledgeAssetMetadata";
import {
  knowledgeAssetElementId,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";

const KIND_LABEL: Record<KnowledgeKind, string> = {
  rules: "项目规则",
  document: "模块知识",
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

const MIN_SAMPLE_TASKS = 3;

function ResourceRow({ resource }: { resource: KnowledgeInsightResource }) {
  const reach = resource.provided_tasks > 0
    ? Math.round(resource.accessed_tasks / resource.provided_tasks * 100) : 0;
  const thin = resource.provided_tasks < MIN_SAMPLE_TASKS;
  return <article className={`knowledge-rank kind-${resource.kind}`}>
    <span className="knowledge-rank-kind">{KIND_LABEL[resource.kind]}</span>
    <div className="knowledge-rank-main">
      <strong title={resource.path}>{resource.name}
        {thin && <em className="knowledge-rank-thin" title={`只在 ${resource.provided_tasks} 个任务里出现过,消费率还说明不了问题`}>样本不足</em>}
      </strong>
      <span title={`${resource.repository ?? "团队级"} · ${resource.path}`}>
        {resource.description || resource.path}
      </span>
    </div>
    <div className="knowledge-rank-reach" title={`${resource.provided_tasks} 个任务可用，${resource.accessed_tasks} 个主动访问`}>
      <span><i style={{ width: `${reach}%` }} /></span>
      <small>{resource.accessed_tasks}/{resource.provided_tasks} 任务访问（{reach}%）</small>
    </div>
    <div className="knowledge-rank-outcome">
      <strong>{resource.access_events}</strong><small>访问</small>
      <strong>{resource.completed_tasks}</strong><small>交付</small>
      <strong className={resource.repair_tasks ? "attention" : ""}>{resource.repair_tasks}</strong><small>修复</small>
    </div>
    <time dateTime={resource.last_used_at}>{latest(resource.last_used_at)}</time>
  </article>;
}

/** 一个分组一个榜:仓库级资源只在本仓任务里被消费,跨仓比绝对量
 * 比的是流量不是价值(用户 2026-08-26 点名),所以按仓分组、组内按
 * 消费率排,样本不足的沉底标注。 */
function ResourceGroup({ title, note, items }: {
  title: string;
  note?: string;
  items: KnowledgeInsightResource[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 5);
  return <div className="knowledge-rank-group">
    <div className="knowledge-rank-group-head">
      <strong>{title}</strong>
      {note && <small>{note}</small>}
      <span>{items.length} 项</span>
    </div>
    {visible.map((item) => <ResourceRow key={item.key} resource={item} />)}
    {items.length > 5 && <button type="button" className="knowledge-show-all"
      onClick={() => setShowAll((current) => !current)}>
      {showAll ? "收起" : `展开全部 ${items.length} 项`}</button>}
  </div>;
}

const OPERATION_LABEL: Record<SkillOperationRecord["action"], string> = {
  upload: "上架",
  update: "更新",
  offline: "下线",
  rollback: "回退",
  submit: "提交待审",
  approve: "审核通过",
  reject: "驳回",
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

function editableMetadata(skill: {
  nature: KnowledgeNature;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}): SkillMetadataDraft {
  if (skill.nature === "unclassified") {
    return { ...EMPTY_SKILL_METADATA };
  }
  return {
    nature: skill.nature,
    business_module_ids: [...skill.business_module_ids],
    repositories: [...skill.repositories],
    technologies: [...skill.technologies],
  };
}

/** 货架与足迹互补:足迹只看得见被任务带过的资源,放坏了的 skill 在
 * 足迹里隐形,货架把"现在生效的是什么"照出来——包括不可装载的。
 * 管理员在同一张货架上换货:上传/更新/下线/回退,写进数据目录即对
 * 下一单生效;面板自己刷新自己,不用整页重取知识效能。 */
function SkillLibraryPanel({ fallback, admin, initialDirectory }: {
  fallback?: HostSkillShelf;
  admin: boolean;
  initialDirectory?: string;
}) {
  const [library, setLibrary] = useState<
    HostSkillShelf & { operations: SkillOperationRecord[] }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadClassification, setUploadClassification] =
    useState<SkillMetadataDraft>({ ...EMPTY_SKILL_METADATA });
  const [businessModules, setBusinessModules] = useState<BusinessModule[]>([]);
  const [pending, setPending] = useState<{
    files: SkillUploadFile[]; skipped: string[] }>();
  const [confirmOffline, setConfirmOffline] = useState("");
  const [versionsFor, setVersionsFor] = useState("");
  const [versions, setVersions] = useState<SkillVersionRecord[]>();
  const [candidatesFor, setCandidatesFor] = useState("");
  const [candidates, setCandidates] = useState<SkillCandidateRecord[]>();
  const [candidateOpen, setCandidateOpen] = useState("");
  const [candidateDetail, setCandidateDetail] =
    useState<{ skill: string; notes: string; evidence: string }>();
  const [distilling, setDistilling] = useState(false);
  const [showOperations, setShowOperations] = useState(false);
  const [expanded, setExpanded] = useState(Boolean(initialDirectory));
  const [documentFor, setDocumentFor] = useState(initialDirectory ?? "");
  const [document, setDocument] = useState<HostSkillDocument>();
  const [submissions, setSubmissions] = useState<SkillSubmissionRecord[]>([]);
  const [submitNote, setSubmitNote] = useState("");
  const [rejectFor, setRejectFor] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | KnowledgeNature>("all");
  const [detailFilter, setDetailFilter] = useState("all");
  const [metadataEditorFor, setMetadataEditorFor] = useState("");
  const [metadataDraft, setMetadataDraft] =
    useState<SkillMetadataDraft>({ ...EMPTY_SKILL_METADATA });
  const newInputRef = useRef<HTMLInputElement>(null);
  const updateInputRef = useRef<HTMLInputElement>(null);
  const updateTargetRef = useRef("");
  const updateMetadataRef =
    useRef<SkillKnowledgeMetadataInput | undefined>(undefined);
  const focusedSkill = useRef("");

  const refresh = () => Promise.all([
    getSkillLibrary()
      .then((data) => { setLibrary(data); setError(""); })
      .catch((cause) => setError(String(cause instanceof Error ? cause.message : cause))),
    // 提交台账是团队可见的;拉不到不挡货架(fail-open)。
    listSkillSubmissions().then(setSubmissions).catch(() => undefined),
    getBusinessModules().then((data) => setBusinessModules(data.modules))
      .catch(() => undefined),
  ]);
  useEffect(() => { void refresh(); }, []);

  const shelf: HostSkillShelf | undefined = library ?? fallback;
  const operations = library?.operations ?? [];

  useEffect(() => {
    if (!initialDirectory || !library
        || focusedSkill.current === initialDirectory) return;
    const skill = library.skills.find((item) =>
      directoryOf(item) === initialDirectory);
    focusedSkill.current = initialDirectory;
    if (!skill) {
      setError("要查看的团队 Skill 已下线或不存在；当前任务的固定版本仍保留在任务现场。");
      setDocumentFor("");
      return;
    }
    setExpanded(true);
    setDocumentFor(initialDirectory);
    setDocument(undefined);
    void getSkillDocument(initialDirectory).then((value) => {
      setDocument(value);
    }).catch((cause) => {
      setError(String(cause instanceof Error ? cause.message : cause));
      setDocumentFor("");
    });
  }, [initialDirectory, library]);

  useEffect(() => {
    if (!initialDirectory || documentFor !== initialDirectory || !document) return;
    requestAnimationFrame(() => globalThis.document.getElementById(
      `${knowledgeAssetElementId("skill", initialDirectory)}-document`,
    )?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [document, documentFor, initialDirectory]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try {
      await work();
      await refresh();
      if (versionsFor) setVersions(await listSkillVersions(versionsFor));
      if (candidatesFor) setCandidates(await listSkillCandidates(candidatesFor));
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
      await run(() => uploadSkill(
        target, encoded.files, updateMetadataRef.current));
      return;
    }
    setPending({ files: encoded.files, skipped: encoded.skipped });
    if (!uploadName && encoded.folder) setUploadName(encoded.folder);
  };

  const languageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of shelf?.skills ?? []) {
      for (const language of skill.technologies) {
        counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
    return counts;
  }, [shelf]);
  const visibleSkills = shelf?.skills.filter((skill) => {
    if (kindFilter !== "all" && skill.nature !== kindFilter) return false;
    if (kindFilter === "business" && detailFilter !== "all") {
      return skill.business_module_ids.includes(detailFilter);
    }
    if (kindFilter === "engineering") {
      return matchesKnowledgeLanguage(skill.technologies, detailFilter);
    }
    return true;
  }) ?? [];

  const toggleDocument = async (directory: string) => {
    if (documentFor === directory) {
      setDocumentFor("");
      setDocument(undefined);
      return;
    }
    setDocumentFor(directory);
    setDocument(undefined);
    setError("");
    try {
      setDocument(await getSkillDocument(directory));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      setDocumentFor("");
    }
  };

  if (!shelf && !admin) return null;

  return <div className="knowledge-shelf" aria-label="Skill 形态知识资产">
    <div className="knowledge-panel-head">
      <div><strong>知识资产 · Skill 形态</strong><small>业务知识按模块、工程知识按语言自动匹配；仓库标签可进一步收窄范围，上架/下线无需重启。</small></div>
      <div className="knowledge-shelf-head-actions">
        <span>{shelf?.skills.length ?? 0} 项</span>
        {/* 人人可提交(2026-08-27 用户拍板):开发者走待审区,管理员
            审核后上架;管理员自己上架照旧直达。 */}
        {expanded && <button type="button" className="knowledge-shelf-action primary"
          onClick={() => { setUploadOpen((open) => !open); setPending(undefined); setUploadName(""); setUploadClassification({ ...EMPTY_SKILL_METADATA }); setSubmitNote(""); }}>
          {uploadOpen ? (admin ? "收起上架" : "收起提交")
            : (admin ? "上架 Skill" : "提交 Skill")}
        </button>}
        <button type="button" className="knowledge-shelf-toggle"
          aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? "收起" : "展开"}<i aria-hidden />
        </button>
      </div>
    </div>

    {expanded && <div className="knowledge-shelf-body">
    {error && <div className="knowledge-shelf-error" role="alert">{error}</div>}
    {submitNote && <div className="knowledge-shelf-empty" role="status">{submitNote}</div>}

    {uploadOpen && <div className="knowledge-shelf-upload">
      <p>选含 SKILL.md 的技能包目录(frontmatter 需有 name/description)。上传前服务端会做密钥掩码扫描——skill 权限全开,令牌/密码一律拒收。{admin ? "" : "提交后由管理员审核,通过即上架。"}</p>
      <SkillMetadataEditor value={uploadClassification}
        modules={businessModules} onChange={setUploadClassification} />
      <div className="knowledge-shelf-upload-row">
        <input type="text" placeholder="目录名,如 order-rules" value={uploadName}
          onChange={(event) => setUploadName(event.target.value.trim())} />
        <button type="button" onClick={() => newInputRef.current?.click()}>选技能包目录</button>
        <button type="button" disabled={busy || !pending || !uploadName
          || !skillMetadataInput(uploadClassification)}
          className="knowledge-shelf-action primary"
          onClick={() => pending && void run(async () => {
            const metadata = skillMetadataInput(uploadClassification);
            if (!metadata) return;
            if (admin) {
              await uploadSkill(uploadName, pending.files, metadata);
            } else {
              const record = await submitSkill(
                uploadName, pending.files, metadata);
              setSubmitNote(`已提交待审(${record.directory}/${record.id},`
                + `${record.files} 个文件)。管理员审核通过后即上架生效。`);
            }
            setPending(undefined); setUploadOpen(false);
          })}>
          {busy ? (admin ? "上架中" : "提交中")
            : `${admin ? "确认上架" : "提交审核"}${pending ? `(${pending.files.length} 个文件)` : ""}`}
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

    {submissions.length > 0 && (
      /* 待审区:提交/裁决是团队可见的台账(被驳回的人要看得到原因)。
         管理员在这里通过或驳回;通过走与上架同一道验收闸,不是盖章
         放行。 */
      <div className="knowledge-shelf-submissions" aria-label="Skill 待审提交">
        {submissions.slice(0, 12).map((item) => (
          <div key={`${item.directory}-${item.id}`}
            className={`knowledge-shelf-operation submission-${item.status}`}>
            <span className={`op-${item.status === "pending" ? "submit"
              : item.status === "approved" ? "approve" : "reject"}`}>
              {item.status === "pending" ? "待审核"
                : item.status === "approved" ? "已上架" : "已驳回"}
            </span>
            <strong>{item.directory}</strong>
            <span>{item.operator} 提交 · {item.files} 个文件</span>
            <SkillMetadataTags nature={item.nature ?? "unclassified"}
              moduleIds={item.business_module_ids ?? []}
              repositories={item.repositories ?? []}
              technologies={item.technologies ?? []} modules={businessModules} />
            {item.reject_reason && <span>原因:{item.reject_reason}</span>}
            {item.status !== "pending" && item.decided_by
              && <span>{item.decided_by} 裁决</span>}
            <time dateTime={item.created_at}>
              {latest(item.created_at).replace("最近 ", "")}</time>
            {admin && item.status === "pending" && (
              rejectFor === `${item.directory}/${item.id}` ? (
                <span className="knowledge-shelf-submission-actions">
                  <input type="text" placeholder="驳回原因(可留空)"
                    value={rejectReason}
                    onChange={(event) => setRejectReason(event.target.value)} />
                  <button type="button" disabled={busy}
                    onClick={() => void run(async () => {
                      await rejectSkillSubmission(
                        item.directory, item.id, rejectReason);
                      setRejectFor(""); setRejectReason("");
                    })}>确认驳回</button>
                  <button type="button" disabled={busy}
                    onClick={() => { setRejectFor(""); setRejectReason(""); }}>
                    返回</button>
                </span>
              ) : (
                <span className="knowledge-shelf-submission-actions">
                  <button type="button" disabled={busy}
                    className="knowledge-shelf-action primary"
                    onClick={() => void run(() => approveSkillSubmission(
                      item.directory, item.id))}>通过并上架</button>
                  <button type="button" disabled={busy}
                    onClick={() => setRejectFor(`${item.directory}/${item.id}`)}>
                    驳回</button>
                </span>
              )
            )}
          </div>
        ))}
      </div>
    )}

    {shelf && !shelf.root_exists && !admin && <div className="knowledge-shelf-empty">本部署尚未放置 Skill 形态知识。管理员上架后，匹配的新任务即可使用。</div>}
    {shelf && (shelf.root_exists || admin) && shelf.skills.length === 0 && <div className="knowledge-shelf-empty">货架是空的——{admin ? "点「上架 Skill」传入含 SKILL.md 的技能包,新任务即自动装载。" : "管理员上架后,新任务即自动装载。"}</div>}

    {!!shelf?.skills.length && <div className="knowledge-shelf-dimension-bar">
      <span><strong>按知识性质查看</strong><small>Skill 是呈现形态；正文性质分业务知识与工程知识。</small></span>
      <div className="skill-classification-filters">
        <label><span>类型</span><select value={kindFilter}
          onChange={(event) => {
            setKindFilter(event.target.value as "all" | KnowledgeNature);
            setDetailFilter("all");
          }}>
          <option value="all">全部性质</option>
          <option value="business">业务知识</option>
          <option value="engineering">工程知识</option>
          <option value="unclassified">待补属性（历史）</option>
        </select></label>
        {kindFilter === "business" && <label><span>业务模块</span>
          <select value={detailFilter}
            onChange={(event) => setDetailFilter(event.target.value)}>
            <option value="all">全部业务模块</option>
            {businessModules.filter((module) => module.status === "active")
              .map((module) => <option value={module.id} key={module.id}>
                {module.name}</option>)}
          </select></label>}
        {kindFilter === "engineering" && <KnowledgeLanguageFilter
          value={detailFilter} onChange={setDetailFilter}
          counts={languageCounts} />}
      </div>
    </div>}
    {!!shelf?.skills.length && !visibleSkills.length
      && <div className="knowledge-shelf-empty">当前知识属性下没有 Skill；可切换筛选，或为历史资产补齐属性。</div>}

    {visibleSkills.map((skill) => {
      const directory = directoryOf(skill);
      return <article
        id={directory ? knowledgeAssetElementId("skill", directory) : undefined}
        className={`knowledge-shelf-row${skill.loadable ? "" : " broken"}${
          directory === initialDirectory ? " focused" : ""}`}
        key={skill.path}>
        <div className="knowledge-shelf-main">
          {directory ? <button type="button" className="knowledge-shelf-name"
            aria-expanded={documentFor === directory}
            onClick={() => void toggleDocument(directory)}>{skill.name}</button>
            : <strong>{skill.name}</strong>}
          {!skill.loadable && <span className="knowledge-shelf-badge" title="pi 装载器未接受,任何会话都不会带上它;检查 SKILL.md frontmatter 的 name/description">不可装载</span>}
          {skill.nature === "unclassified" && <span
            className="knowledge-shelf-badge signal-attention"
            title="缺少强制知识标签；补齐前不会自动匹配给任何任务">
            未治理 · 不会匹配</span>}
          {skill.effect?.signal && <span
            className={`knowledge-shelf-badge signal-${skill.effect.signal}`}
            title={skill.effect.signal_evidence}>
            {skill.effect.signal === "low-consumption" ? "待修订 · 没人读" : "待修订 · 读了仍返修"}
          </span>}
          <p>{skill.description || "(没有描述——模型靠描述判断何时读取,建议补上)"}</p>
          <SkillMetadataTags nature={skill.nature}
            moduleIds={skill.business_module_ids}
            repositories={skill.repositories}
            technologies={skill.technologies} modules={businessModules} />
          {skill.effect && skill.effect.provided_tasks > 0 && <div className="knowledge-shelf-effect">
            <span>装载 {skill.effect.provided_tasks} 单</span>
            <span>读取 {skill.effect.accessed_tasks} 单
              （{Math.round(skill.effect.accessed_tasks / skill.effect.provided_tasks * 100)}%）</span>
            {skill.effect.prepush_measured > 0 && <span
              title="读过该 skill 的任务中,推送前编译首轮一次通过的比例">
              读后一次过 {skill.effect.prepush_first_pass}/{skill.effect.prepush_measured}</span>}
            {skill.effect.baseline_measured > 0 && <span
              title="未读该 skill 的任务对照(相关性参考,不代表因果)">
              未读对照 {skill.effect.baseline_first_pass}/{skill.effect.baseline_measured}</span>}
            {skill.effect.repair_tasks > 0 && <span className="attention">
              读后返修 {skill.effect.repair_tasks} 单</span>}
          </div>}
        </div>
        <div className="knowledge-shelf-meta">
          <span title={`SKILL.md 内容 sha256:${skill.digest}`}>版本 {skill.digest.slice(0, 8)}</span>
          <span>{skill.path}</span>
          <time dateTime={skill.updated_at}>{latest(skill.updated_at).replace("最近 ", "更新 ")}</time>
        </div>
        {admin && directory && <div className="knowledge-shelf-actions">
          <button type="button" disabled={busy} onClick={() => {
            updateTargetRef.current = directory;
            updateMetadataRef.current = skillMetadataInput(
              editableMetadata(skill));
            updateInputRef.current?.click();
          }}>更新</button>
          <button type="button" disabled={busy} onClick={() => {
            if (metadataEditorFor === directory) {
              setMetadataEditorFor("");
              return;
            }
            setMetadataEditorFor(directory);
            setMetadataDraft(editableMetadata(skill));
          }}>{metadataEditorFor === directory ? "取消属性" : "知识属性"}</button>
          <button type="button" disabled={busy} onClick={() => void (async () => {
            if (versionsFor === directory) { setVersionsFor(""); setVersions(undefined); return; }
            setVersionsFor(directory); setVersions(undefined);
            try { setVersions(await listSkillVersions(directory)); }
            catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
          })()}>{versionsFor === directory ? "收起历史" : "历史版本"}</button>
          <button type="button" disabled={busy} onClick={() => void (async () => {
            if (candidatesFor === directory) {
              setCandidatesFor(""); setCandidates(undefined);
              setCandidateOpen(""); setCandidateDetail(undefined);
              return;
            }
            setCandidatesFor(directory); setCandidates(undefined);
            setCandidateOpen(""); setCandidateDetail(undefined);
            try { setCandidates(await listSkillCandidates(directory)); }
            catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
          })()}>{candidatesFor === directory ? "收起候选"
            : `修订候选${skill.candidates ? `(${skill.candidates})` : ""}`}</button>
          {confirmOffline === directory
            ? <button type="button" className="danger" disabled={busy}
              onClick={() => { setConfirmOffline(""); void run(() => offlineSkill(directory)); }}>确认下线?</button>
            : <button type="button" disabled={busy}
              onClick={() => setConfirmOffline(directory)}>下线</button>}
        </div>}
        {directory && metadataEditorFor === directory
          && <div className="knowledge-shelf-classification-editor">
            <span><strong>调整知识属性</strong><small>Skill 形态不变；修改会形成新版本，历史任务不受影响。</small></span>
            <SkillMetadataEditor value={metadataDraft}
              modules={businessModules} onChange={setMetadataDraft} />
            <button type="button" className="knowledge-shelf-action primary"
              disabled={busy || !skillMetadataInput(metadataDraft)}
              onClick={() => void run(async () => {
                const metadata = skillMetadataInput(metadataDraft);
                if (!metadata) return;
                await updateSkillKnowledgeMetadata(directory, metadata);
                setMetadataEditorFor("");
              })}>保存属性</button>
          </div>}
        {directory && documentFor === directory && <div
          id={`${knowledgeAssetElementId("skill", directory)}-document`}
          className="knowledge-shelf-document" aria-label={`${skill.name} 内容`}>
          <header>
            <span><strong>SKILL.md</strong><small>{skill.path}</small></span>
            <button type="button" onClick={() => void toggleDocument(directory)}>收起</button>
          </header>
          {!document && <p>正在读取内容…</p>}
          {document && <pre>{document.content}</pre>}
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
        {candidatesFor === directory && <div className="knowledge-shelf-versions">
          <div className="knowledge-shelf-version">
            <span>沉淀环:从读过该 skill 的任务现场起草修订稿,采纳前不影响任何任务。</span>
            <button type="button" disabled={busy || distilling}
              onClick={() => void (async () => {
                setDistilling(true); setError("");
                try {
                  await distillSkill(directory);
                  await refresh();
                  setCandidates(await listSkillCandidates(directory));
                } catch (cause) {
                  setError(String(cause instanceof Error ? cause.message : cause));
                } finally { setDistilling(false); }
              })()}>{distilling ? "起草中…(约一分钟)" : "起草修订稿"}</button>
          </div>
          {!candidates && <small>读取候选…</small>}
          {candidates && candidates.length === 0 && <small>还没有修订候选。</small>}
          {candidates?.map((candidate) => <div key={candidate.id}>
            <div className="knowledge-shelf-version">
              <span>{candidate.status === "drafted" ? "待裁决" : candidate.status === "adopted" ? "已采纳" : "已丢弃"} · {candidate.operator} 起草 · 证据 {candidate.evidence_tasks.length} 单</span>
              <span>{latest(candidate.created_at).replace("最近 ", "")}</span>
              <button type="button" disabled={busy} onClick={() => void (async () => {
                if (candidateOpen === candidate.id) {
                  setCandidateOpen(""); setCandidateDetail(undefined); return;
                }
                setCandidateOpen(candidate.id); setCandidateDetail(undefined);
                try { setCandidateDetail(await getSkillCandidate(directory, candidate.id)); }
                catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
              })()}>{candidateOpen === candidate.id ? "收起" : "查看"}</button>
              {candidate.status === "drafted" && <>
                <button type="button" disabled={busy}
                  onClick={() => void run(() => adoptSkillCandidate(directory, candidate.id))}>采纳上架</button>
                <button type="button" disabled={busy}
                  onClick={() => void run(() => discardSkillCandidate(directory, candidate.id))}>丢弃</button>
              </>}
            </div>
            {candidateOpen === candidate.id && <div className="knowledge-shelf-candidate">
              {!candidateDetail && <small>读取草稿…</small>}
              {candidateDetail && <>
                <p>修订说明:{candidateDetail.notes || "(无)"}</p>
                <pre>{candidateDetail.skill}</pre>
                <details><summary>起草依据的现场证据</summary>
                  <pre>{candidateDetail.evidence || "(无)"}</pre></details>
              </>}
            </div>}
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
    </div>}
  </div>;
}

const FORM_LABEL = { document: "文档", skill: "Skill", rule: "规则",
  example: "示例" } as const;

function KnowledgeCandidatePanel({ admin, onOpenTask, initialCandidateId }: {
  admin: boolean;
  onOpenTask: (taskId: string) => void;
  initialCandidateId?: string;
}) {
  const [candidates, setCandidates] = useState<KnowledgeCandidateRecord[]>([]);
  const [modules, setModules] = useState<BusinessModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reasonFor, setReasonFor] = useState("");
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(Boolean(initialCandidateId));
  const focusedCandidate = useRef("");
  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const [items, business] = await Promise.all([
        listTaskKnowledgeCandidates(), getBusinessModules(),
      ]);
      setCandidates(items); setModules(business.modules);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "知识候选读取失败");
    } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!initialCandidateId || loading
        || focusedCandidate.current === initialCandidateId) return;
    focusedCandidate.current = initialCandidateId;
    if (!candidates.some((item) => item.id === initialCandidateId)) {
      setError("要查看的工程知识不存在或已被移除；当前任务的固定版本仍保留在任务现场。");
      return;
    }
    setExpanded(true);
  }, [candidates, initialCandidateId, loading]);
  useEffect(() => {
    if (!initialCandidateId || loading || !expanded
        || !candidates.some((item) => item.id === initialCandidateId)) return;
    requestAnimationFrame(() => document.getElementById(
      `${knowledgeAssetElementId("engineering", initialCandidateId)}-document`,
    )?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [candidates, expanded, initialCandidateId, loading]);
  const pending = candidates.filter((item) => item.status === "pending");
  const visible = expanded ? candidates : candidates.slice(0, 6);
  const canManage = (candidate: KnowledgeCandidateRecord) => admin
    || candidate.nature === "business" && candidate.business_module_ids.every((id) =>
      modules.find((module) => module.id === id)?.can_manage);
  const decide = async (candidate: KnowledgeCandidateRecord,
    decision: "publish" | "reject") => {
    setBusy(candidate.id); setError("");
    try {
      if (decision === "publish") {
        await publishKnowledgeCandidate(candidate.id);
      } else {
        await rejectKnowledgeCandidate(candidate.id, reason);
        setReasonFor(""); setReason("");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "知识候选处理失败");
    } finally { setBusy(""); }
  };
  return <div className="knowledge-candidate-panel">
    <div className="knowledge-panel-head">
      <div><strong>任务沉淀候选</strong><small>
        从“本任务知识”提交；审核发布后才进入后续任务推荐。</small></div>
      <span>{pending.length} 项待审</span>
    </div>
    {error && <p className="business-module-error" role="alert">{error}</p>}
    {loading && !candidates.length && <div className="knowledge-shelf-empty">
      正在读取知识候选…</div>}
    {!loading && !candidates.length && <div className="knowledge-shelf-empty">
      还没有任务沉淀候选。开发者可在任务页提交，不会自动发布。</div>}
    <div className="knowledge-candidate-list">
      {visible.map((candidate) => <article key={candidate.id}
        id={knowledgeAssetElementId("engineering", candidate.id)}
        className={`status-${candidate.status}${candidate.id === initialCandidateId
          ? " focused" : ""}`}>
        <header><span><strong>{candidate.title}</strong>
          <small>{candidate.id} · {candidate.submitted_by}</small></span>
          <em>{candidate.status === "pending" ? "待审核"
            : candidate.status === "published" ? "已发布闭环" : "暂不接纳"}</em>
        </header>
        <p>{candidate.summary}</p>
        <div className="skill-classification-tags">
          <em className={`kind-${candidate.nature}`}>
            {candidate.nature === "business" ? "业务知识" : "工程知识"}</em>
          <em className="kind-form">{FORM_LABEL[candidate.form]}</em>
          {candidate.business_module_ids.map((id) => <em
            className="skill-module-tag" key={id}>
            {modules.find((module) => module.id === id)?.name ?? id}</em>)}
          {candidate.repositories.map((repository) => <em
            className="skill-repository-tag" key={repository}>
            {repositoryName(repository)}</em>)}
          {candidate.nature === "engineering"
            && <KnowledgeLanguageTags languages={candidate.technologies}
              empty="缺少语言标签 · 需治理" />}
        </div>
        <details
          id={`${knowledgeAssetElementId("engineering", candidate.id)}-document`}
          open={candidate.id === initialCandidateId || undefined}>
          <summary>查看正文与适用场景</summary>
          <p><strong>何时使用：</strong>{candidate.when_to_use}</p>
          <pre>{candidate.content}</pre></details>
        <footer><button type="button"
          onClick={() => onOpenTask(candidate.source_task_id)}>
          来源 {candidate.source_task_id}</button>
          {candidate.published_target && <span>
            发布到 {candidate.published_target}</span>}
          {candidate.decision_note && <span>
            说明：{candidate.decision_note}</span>}
          {candidate.status === "pending" && canManage(candidate) && <>
            <button type="button" className="primary" disabled={!!busy}
              onClick={() => void decide(candidate, "publish")}>
              {busy === candidate.id ? "处理中…" : "接纳并发布"}</button>
            <button type="button" disabled={!!busy}
              onClick={() => setReasonFor(candidate.id)}>暂不接纳</button>
          </>}
        </footer>
        {reasonFor === candidate.id && <div className="knowledge-candidate-reject">
          <input value={reason} onChange={(event) => setReason(event.target.value)}
            placeholder="必须说明原因，便于提交人修订" />
          <button type="button" disabled={!reason.trim() || !!busy}
            onClick={() => void decide(candidate, "reject")}>确认驳回</button>
          <button type="button" onClick={() => setReasonFor("")}>取消</button>
        </div>}
      </article>)}
    </div>
    {candidates.length > 6 && <button type="button" className="knowledge-show-all"
      onClick={() => setExpanded((value) => !value)}>
      {expanded ? "收起" : `查看全部 ${candidates.length} 项`}</button>}
  </div>;
}

export function KnowledgeFlywheel({
  insights,
  loading,
  error,
  onRetry,
  onOpenTask,
  admin = false,
  initialAsset,
}: {
  insights?: TeamKnowledgeInsights;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenTask: (taskId: string) => void;
  admin?: boolean;
  initialAsset?: KnowledgeAssetFocus;
}) {
  const [kind, setKind] = useState<"all" | "document" | "skill">("all");
  // 分组代替跨仓混排:团队级(跨仓资产)一组在前,其余按仓一组一个榜。
  // 组内排序:消费率(读取/装载)优先,样本不足(<3 单)沉底;绝对量只做
  // 次级键——谁的仓单多谁霸榜的老毛病由此消除。
  const groups = useMemo(() => {
    const filtered = (insights?.resources ?? [])
      .filter((item) => kind === "all" || item.kind === kind);
    const byRepo = new Map<string, KnowledgeInsightResource[]>();
    for (const item of filtered) {
      const key = item.scope === "module"
        ? `module:${item.module_id ?? item.module_name ?? "unknown"}`
        : item.repository ?? "";
      const list = byRepo.get(key) ?? [];
      list.push(item);
      byRepo.set(key, list);
    }
    const rate = (item: KnowledgeInsightResource) => item.provided_tasks > 0
      ? item.accessed_tasks / item.provided_tasks : 0;
    const sortGroup = (list: KnowledgeInsightResource[]) => [...list]
      .sort((left, right) => {
        const leftThin = left.provided_tasks < MIN_SAMPLE_TASKS;
        const rightThin = right.provided_tasks < MIN_SAMPLE_TASKS;
        if (leftThin !== rightThin) return leftThin ? 1 : -1;
        return rate(right) - rate(left)
          || right.accessed_tasks - left.accessed_tasks
          || left.name.localeCompare(right.name);
      });
    return [...byRepo.entries()]
      .map(([repo, list]) => ({
        repo,
        items: sortGroup(list),
        activity: list.reduce((sum, item) => sum + item.accessed_tasks, 0),
      }))
      .sort((left, right) => (left.repo === "" ? -1 : right.repo === "" ? 1
        : left.repo.startsWith("module:") && !right.repo.startsWith("module:") ? -1
        : right.repo.startsWith("module:") && !left.repo.startsWith("module:") ? 1
        : right.activity - left.activity
          || left.repo.localeCompare(right.repo)));
  }, [insights, kind]);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  return <section className="knowledge-flywheel" aria-labelledby="knowledge-flywheel-title">
    <header className="knowledge-flywheel-head">
      <div className="knowledge-flywheel-title">
        <span className="knowledge-flywheel-icon" aria-hidden>知</span>
        <div><span className="section-kicker">KNOWLEDGE FLYWHEEL</span><h2 id="knowledge-flywheel-title">团队知识效能</h2><p>只观察经过沉淀、能跨任务复用的团队资产；任务需求文档留在各自现场。</p></div>
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
    {insights && insights.summary.tracked_tasks === 0 && <div className="knowledge-flywheel-empty"><span aria-hidden>◎</span><div><strong>知识飞轮正在等待第一批数据</strong><p>正式模块知识或 Skill 被新任务装载、读取后，这里会出现使用趋势；任务文档和仓库项目规则不会进入团队统计。</p></div></div>}

    <SkillLibraryPanel fallback={insights?.host_skills} admin={admin}
      initialDirectory={initialAsset?.kind === "skill"
        ? initialAsset.directory : undefined} />
    <KnowledgeCandidatePanel admin={admin} onOpenTask={onOpenTask}
      initialCandidateId={initialAsset?.kind === "engineering"
        ? initialAsset.candidateId : undefined} />

    {insights && insights.summary.tracked_tasks > 0 && <>
      <div className="knowledge-flywheel-metrics" aria-label="知识效能摘要">
        <div><span>已追踪任务</span><strong>{insights.summary.tracked_tasks}</strong><small>采用新知识口径</small></div>
        <div><span>主动访问率</span><strong>{insights.summary.access_rate}<em>%</em></strong><small>{insights.summary.accessed_tasks} 个任务真正读取</small></div>
        <div><span>活跃资产</span><strong>{insights.summary.active_resources}</strong><small>共识别 {insights.summary.unique_resources} 项</small></div>
        <div className={insights.summary.opportunities ? "attention" : "positive"}><span>改进机会</span><strong>{insights.summary.opportunities}</strong><small>{insights.summary.selected_unused} 项选而未用</small></div>
      </div>

      <div className="knowledge-flywheel-body">
        <div className="knowledge-ranking">
          <div className="knowledge-panel-head"><div><strong>可复用资产使用</strong><small>这里只统计正式模块知识与 Skill 的真实消费；仓库项目规则和任务文档仍留在各自现场。</small></div><span>{total} 项</span></div>
          <div className="knowledge-filterbar">
            <div role="group" aria-label="按知识类型筛选">
              {(["all", "document", "skill"] as const).map((value) => <button type="button" key={value} className={kind === value ? "on" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "all" ? "全部" : KIND_LABEL[value]}</button>)}
            </div>
          </div>
          <div className="knowledge-ranking-list">
            {groups.map((group) => <ResourceGroup
              key={group.repo || "__team__"}
              title={group.repo.startsWith("module:")
                ? `业务模块 · ${group.items[0]?.module_name ?? group.repo.slice(7)}`
                : group.repo ? repositoryName(group.repo) : "团队级资产（跨仓）"}
              note={group.repo.startsWith("module:")
                ? "Owner 显式发布的模块知识，按任务真实读取统计"
                : group.repo ? "组内按消费率排,受本仓单量影响,不跨仓比较" : undefined}
              items={group.items} />)}
            {total === 0 && <div className="knowledge-ranking-empty">当前筛选下还没有知识使用记录。</div>}
          </div>
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
      <footer className="knowledge-flywheel-note"><span>口径</span>任务需求、附件与过程文档只留在单任务现场，项目规则只属于相关仓库；团队页只统计正式模块知识和 Skill，交付结果仅作相关性参考。</footer>
    </>}
  </section>;
}
