import { useEffect, useState } from "react";
import {
  archiveBusinessKnowledgeAsset,
  createBusinessModule,
  getBusinessKnowledgeAsset,
  getBusinessModules,
  listUsers,
  publishBusinessKnowledgeAsset,
  updateBusinessModule,
  type AuthUser,
  type BusinessKnowledgeAsset,
  type BusinessModule,
  type BusinessModuleCatalog,
} from "./api";

function lines(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function ModuleEditor({ module, admin, users, onSaved, onCancel }: {
  module: BusinessModule;
  admin: boolean;
  users: AuthUser[];
  onSaved: (module: BusinessModule) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(module.name);
  const [description, setDescription] = useState(module.description);
  const [owner, setOwner] = useState(module.owner);
  const [maintainers, setMaintainers] = useState(module.maintainers.join(", "));
  const [repositories, setRepositories] = useState(module.repositories.join("\n"));
  const [status, setStatus] = useState(module.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="business-module-editor" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      onSaved(await updateBusinessModule(module.id, {
        name, description, owner,
        maintainers: lines(maintainers),
        repositories: lines(repositories),
        ...(admin ? { status } : {}),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模块保存失败");
    } finally { setBusy(false); }
  }}>
    <div className="business-module-form-grid">
      <label><span>模块名称</span><input value={name}
        onChange={(event) => setName(event.target.value)} required /></label>
      <label><span>责任人</span>
        {admin ? <select value={owner}
          onChange={(event) => setOwner(event.target.value)} required>
          {users.map((user) => <option key={user.username}
            value={user.username}>{user.username}</option>)}
        </select> : <input value={owner} disabled title="只有管理员可以转移责任人" />}
      </label>
    </div>
    <label><span>业务语义说明</span><textarea rows={2} value={description}
      onChange={(event) => setDescription(event.target.value)} required /></label>
    <label><span>维护者账号</span><input value={maintainers}
      onChange={(event) => setMaintainers(event.target.value)}
      placeholder="多个账号用逗号分隔" /></label>
    <label><span>关联仓库</span><textarea rows={3} value={repositories}
      onChange={(event) => setRepositories(event.target.value)}
      placeholder="每行一个仓库地址，用于下单时推荐，不会自动勾选" /></label>
    {admin && <label><span>模块状态</span><select value={status}
      onChange={(event) => setStatus(event.target.value as "active" | "archived")}>
      <option value="active">启用（可供新任务选择）</option>
      <option value="archived">归档（历史任务保留）</option>
    </select></label>}
    {error && <p className="business-module-error" role="alert">{error}</p>}
    <div className="business-module-form-actions">
      <button type="button" onClick={onCancel}>取消</button>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "保存中…" : "保存模块"}</button>
    </div>
  </form>;
}

function AssetEditor({ module, asset, initialContent, onSaved, onCancel }: {
  module: BusinessModule;
  asset?: BusinessKnowledgeAsset;
  initialContent?: string;
  onSaved: (module: BusinessModule) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(asset?.id ?? "");
  const [title, setTitle] = useState(asset?.title ?? "");
  const [summary, setSummary] = useState(asset?.summary ?? "");
  const [whenToUse, setWhenToUse] = useState(asset?.when_to_use ?? "");
  const [form, setForm] = useState(asset?.form ?? "document");
  const [repositories, setRepositories] = useState(asset?.repositories ?? []);
  const [content, setContent] = useState(initialContent ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="business-asset-editor" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      onSaved(await publishBusinessKnowledgeAsset(module.id, id, {
        title, summary, when_to_use: whenToUse, form, repositories, content,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识发布失败");
    } finally { setBusy(false); }
  }}>
    <div className="business-module-form-grid">
      <label><span>资产 ID</span><input value={id} disabled={!!asset}
        onChange={(event) => setId(event.target.value)}
        placeholder="例如 release-checklist" required /></label>
      <label><span>标题</span><input value={title}
        onChange={(event) => setTitle(event.target.value)} required /></label>
    </div>
    <label><span>一句话摘要</span><textarea rows={2} value={summary}
      onChange={(event) => setSummary(event.target.value)} required /></label>
    <label><span>什么时候应该读</span><textarea rows={2} value={whenToUse}
      onChange={(event) => setWhenToUse(event.target.value)} required /></label>
    <div className="business-module-form-grid">
      <label><span>知识形态</span><select value={form}
        onChange={(event) => setForm(event.target.value as typeof form)}>
        <option value="document">文档</option>
        <option value="skill">Skill</option>
        <option value="rule">规则</option>
        <option value="example">示例</option>
      </select></label>
      <div className="business-asset-language-field">
        <span>适用代码仓（可选）</span>
        <small>不选表示适用于该模块关联的全部仓库。</small>
        {module.repositories.length ? <div className="skill-module-picker">
          {module.repositories.map((repository) => <button type="button"
            key={repository} title={repository}
            aria-pressed={repositories.includes(repository)}
            onClick={() => setRepositories((current) =>
              current.includes(repository)
                ? current.filter((item) => item !== repository)
                : [...current, repository])}>
            {repository.replace(/\/+$/, "").split("/").at(-1)
              ?.replace(/\.git$/i, "") || repository}</button>)}
        </div> : <small>模块尚未关联仓库，当前知识默认对模块内全部任务适用。</small>}
      </div>
    </div>
    <label><span>知识正文（Markdown）</span><textarea className="business-asset-content"
      rows={12} value={content}
      onChange={(event) => setContent(event.target.value)} required /></label>
    <p className="business-module-form-note">发布会产生新版本；已经发起的任务继续使用自己的固定快照。</p>
    {error && <p className="business-module-error" role="alert">{error}</p>}
    <div className="business-module-form-actions">
      <button type="button" onClick={onCancel}>取消</button>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "发布中…" : asset ? `发布 v${asset.version + 1}` : "发布知识"}
      </button>
    </div>
  </form>;
}

export function BusinessModuleLibrary({ admin }: { admin: boolean }) {
  const [catalog, setCatalog] = useState<BusinessModuleCatalog>();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [editingModule, setEditingModule] = useState("");
  const [editingAsset, setEditingAsset] = useState<{
    moduleId: string; asset?: BusinessKnowledgeAsset; content?: string }>();
  const [document, setDocument] = useState<{
    moduleId: string; assetId: string; title: string; content: string }>();
  const [documentLoading, setDocumentLoading] = useState("");
  const [create, setCreate] = useState({
    id: "", name: "", description: "", owner: "",
    maintainers: "", repositories: "",
  });
  const [createBusy, setCreateBusy] = useState(false);

  const refresh = async () => {
    setLoading(true); setError("");
    try { setCatalog(await getBusinessModules()); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "业务模块读取失败");
    } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!admin) return;
    void listUsers().then((result) => {
      setUsers(result);
      setCreate((current) => ({
        ...current, owner: current.owner || result.find((user) =>
          user.role === "developer")?.username || result[0]?.username || "",
      }));
    }).catch(() => setUsers([]));
  }, [admin]);

  const replace = (updated: BusinessModule) => setCatalog((current) =>
    current ? { ...current, modules: current.modules.map((module) =>
      module.id === updated.id ? updated : module) } : current);

  const openAsset = async (module: BusinessModule, asset: BusinessKnowledgeAsset,
    edit = false) => {
    const key = `${module.id}/${asset.id}`;
    setDocumentLoading(key); setError("");
    try {
      const value = await getBusinessKnowledgeAsset(module.id, asset.id);
      if (edit) {
        setEditingAsset({ moduleId: module.id, asset, content: value.content });
        setDocument(undefined);
      } else {
        setDocument({ moduleId: module.id, assetId: asset.id,
          title: asset.title, content: value.content });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识正文读取失败");
    } finally { setDocumentLoading(""); }
  };

  return <section className="business-module-library" aria-labelledby="business-module-library-title">
    <header className="business-module-library-head">
      <div><span className="section-kicker">TEAM ASSETS / MODULES</span>
        <h3 id="business-module-library-title">业务模块</h3>
        <p>每个模块是一个业务抽屉：说明业务边界、关联代码仓，并管理团队沉淀的模块知识。</p>
      </div>
      <div><span>{catalog?.modules.filter((item) => item.status === "active").length ?? 0} 个启用</span>
        {admin && <button type="button" className="primary"
          onClick={() => setCreateOpen((open) => !open)}>
          {createOpen ? "取消新建" : "新建业务模块"}</button>}
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}</button>
      </div>
    </header>

    {createOpen && <form className="business-module-create" onSubmit={async (event) => {
      event.preventDefault(); setCreateBusy(true); setError("");
      try {
        const module = await createBusinessModule({
          id: create.id, name: create.name, description: create.description,
          owner: create.owner, maintainers: lines(create.maintainers),
          repositories: lines(create.repositories),
        });
        setCatalog((current) => current ? {
          ...current, modules: [...current.modules, module]
            .sort((left, right) => left.name.localeCompare(right.name)),
        } : current);
        setExpanded(module.id); setCreateOpen(false);
        setCreate({ id: "", name: "", description: "",
          owner: create.owner, maintainers: "", repositories: "" });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "模块创建失败");
      } finally { setCreateBusy(false); }
    }}>
      <div className="business-module-form-grid">
        <label><span>模块 ID</span><input value={create.id}
          onChange={(event) => setCreate({ ...create, id: event.target.value })}
          placeholder="例如 payment-core" required /></label>
        <label><span>责任人</span><select value={create.owner}
          onChange={(event) => setCreate({ ...create, owner: event.target.value })} required>
          <option value="" disabled>选择现有账号</option>
          {users.map((user) => <option key={user.username}
            value={user.username}>{user.username}</option>)}
        </select></label>
      </div>
      <label><span>模块名称</span><input value={create.name}
        onChange={(event) => setCreate({ ...create, name: event.target.value })}
        placeholder="例如 支付核心" required /></label>
      <label><span>业务语义说明</span><textarea rows={2} value={create.description}
        onChange={(event) => setCreate({ ...create, description: event.target.value })}
        placeholder="说清领域概念、核心规则、流程和边界" required /></label>
      <div className="business-module-form-grid">
        <label><span>维护者账号（可选）</span><input value={create.maintainers}
          onChange={(event) => setCreate({ ...create, maintainers: event.target.value })}
          placeholder="多个账号用逗号分隔" /></label>
        <label><span>关联仓库（可选）</span><textarea rows={2} value={create.repositories}
          onChange={(event) => setCreate({ ...create, repositories: event.target.value })}
          placeholder="每行一个仓库地址" /></label>
      </div>
      <div className="business-module-form-actions">
        <span>创建后由责任人持续管理，只有管理员能转移责任人。</span>
        <button type="submit" className="primary" disabled={createBusy || !create.owner}>
          {createBusy ? "创建中…" : "创建并指定责任人"}</button>
      </div>
    </form>}

    {error && <p className="business-module-error" role="alert">{error}</p>}
    {!!catalog?.warnings.length && <p className="business-module-warning">
      {catalog.warnings.join("；")}</p>}
    {!loading && !catalog?.modules.length && <div className="business-module-empty">
      <strong>还没有业务模块</strong><span>由管理员创建并指定责任人；Owner 随后在模块内维护知识。</span>
    </div>}

    <div className="business-module-list">
      {(catalog?.modules ?? []).map((module) => {
        const open = expanded === module.id;
        const allLiveAssets = module.assets.filter((asset) =>
          asset.status === "published");
        const liveAssets = allLiveAssets;
        return <article key={module.id} className={`business-module-card status-${module.status}`}>
          <button type="button" className="business-module-card-head"
            aria-expanded={open} onClick={() => setExpanded(open ? "" : module.id)}>
            <span className="business-module-monogram">{module.name.slice(0, 1)}</span>
            <span><span><strong>{module.name}</strong><code>{module.id}</code>
              {module.status === "archived" && <em>已归档</em>}</span>
              <small>{module.description}</small>
              <span className="business-module-card-meta">Owner {module.owner} · {allLiveAssets.length} 项知识 · revision {module.revision}</span>
            </span>
            <i aria-hidden>{open ? "收起" : "展开"}</i>
          </button>
          {open && <div className="business-module-card-body">
            <div className="business-module-scope">
              <strong>关联范围</strong>
              <div>{module.repositories.length ? module.repositories.map((repo) =>
                <code key={repo}>{repo}</code>) : <span>未关联仓库，不参与下单推荐</span>}</div>
              {!!module.maintainers.length && <small>维护者：{module.maintainers.join("、")}</small>}
            </div>
            {module.can_manage && <div className="business-module-managebar">
              <button type="button" onClick={() => {
                setEditingModule(editingModule === module.id ? "" : module.id);
                setEditingAsset(undefined);
              }}>{editingModule === module.id ? "取消编辑" : "编辑模块"}</button>
              <button type="button" className="primary" disabled={module.status !== "active"}
                onClick={() => {
                  setEditingAsset({ moduleId: module.id });
                  setEditingModule(""); setDocument(undefined);
                }}>发布知识</button>
            </div>}
            {editingModule === module.id && <ModuleEditor module={module}
              admin={admin} users={users} onCancel={() => setEditingModule("")}
              onSaved={(updated) => { replace(updated); setEditingModule(""); }} />}
            {editingAsset?.moduleId === module.id && <AssetEditor module={module}
              asset={editingAsset.asset} initialContent={editingAsset.content}
              onCancel={() => setEditingAsset(undefined)}
              onSaved={(updated) => { replace(updated); setEditingAsset(undefined); }} />}
            <div className="business-asset-list">
              <div className="business-asset-list-head"><strong>已发布知识</strong>
                <small>点击名称查看正文；任务只会获得选中模块当时的固定版本。</small></div>
              {liveAssets.map((asset) => <div className="business-asset-row" key={asset.id}>
                <button type="button" className="business-asset-title"
                  disabled={documentLoading === `${module.id}/${asset.id}`}
                  onClick={() => void openAsset(module, asset)}>
                  <span><strong>{asset.title}</strong><code>v{asset.version}</code></span>
                  <small>{asset.summary}</small>
                  <em>何时读：{asset.when_to_use}</em>
                  <span className="skill-classification-tags">
                    <em className="kind-business">业务知识</em>
                    <em className="kind-form">{{ document: "文档", skill: "Skill",
                      rule: "规则", example: "示例" }[asset.form]}</em>
                    {asset.repositories.map((repository) => <em
                      className="skill-repository-tag" key={repository}>
                      {repository.replace(/\/+$/, "").split("/").at(-1)
                        ?.replace(/\.git$/i, "") || repository}</em>)}
                  </span>
                </button>
                {module.can_manage && <div>
                  <button type="button" onClick={() => void openAsset(module, asset, true)}>更新</button>
                  <button type="button" className="danger" onClick={async () => {
                    if (!window.confirm(`归档知识「${asset.title}」？历史任务不受影响。`)) return;
                    try { replace(await archiveBusinessKnowledgeAsset(module.id, asset.id)); }
                    catch (reason) { setError(reason instanceof Error ? reason.message : "归档失败"); }
                  }}>归档</button>
                </div>}
              </div>)}
              {!liveAssets.length && <div className="business-asset-empty">
                还没有已发布知识。Owner 可以从一项明确、可复用的知识开始。</div>}
            </div>
            {document?.moduleId === module.id && <div className="business-asset-document">
              <header><strong>{document.title}</strong><button type="button"
                onClick={() => setDocument(undefined)}>关闭正文</button></header>
              <pre>{document.content}</pre>
            </div>}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}
