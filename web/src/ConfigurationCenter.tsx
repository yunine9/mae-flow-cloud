import { useEffect, useState } from "react";
import { EnvironmentRegistry } from "./EnvironmentRegistry";
import { getBusinessModules, createBusinessModule, updateBusinessModule,
  productVersionRequest, type BusinessModule, type ProductVersion } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { confirmDialog } from "./ConfirmDialog";

const PAGE_SIZE = 10;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortRepo = (repo: string) => repo.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, "") || repo;
export function ConfigurationCenter() {
  const [tab, setTab] = useState(() => { const tab = new URLSearchParams(location.search).get("tab"); return tab === "modules" || tab === "versions" ? tab : "environments"; });
  return <section className="tw-root grid gap-5 text-base">
    <nav aria-label="配置分类" className="flex gap-2 border-b border-line pb-3">
      {[["environments", "环境管理"], ["versions", "版本与分支"], ["modules", "模块与代码仓"]].map(([id, label]) =>
        <Button key={id} variant={tab === id ? "default" : "ghost"}
          aria-pressed={tab === id} onClick={() => { setTab(id); history.replaceState(history.state, "", `/configuration?tab=${id}`); }}>{label}</Button>)}
    </nav>
    {tab === "environments" ? <EnvironmentRegistry /> : <MappingList key={tab} kind={tab} />}
  </section>;
}
function MappingList({ kind }: { kind: string }) {
  const modulesMode = kind === "modules";
  const [modules, setModules] = useState<BusinessModule[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id?: string; name: string; value: string; description?: string; status?: "active" | "archived" }>();
  const [allRepos, setAllRepos] = useState<BusinessModule>();
  const [repoQuery, setRepoQuery] = useState("");
  async function refresh() {
    setLoading(true); setError("");
    try {
      if (modulesMode) { const catalog = await getBusinessModules(); setModules(catalog.modules); setWarnings(catalog.warnings); }
      else setVersions((await productVersionRequest()).versions);
    } catch (e) { setError(message(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const rows = modulesMode
    ? modules.map(m => ({ id: m.id, name: m.name, value: m.repositories.join("\n"), description: m.description, status: m.status }))
    : versions.map(v => ({ id: v.id, name: v.version, value: v.branch, description: "", status: "active" as const }));
  const filtered = rows.filter(row => `${row.name} ${row.value}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  async function save() {
    if (!edit) return;
    setBusy(true); setError("");
    try {
      if (modulesMode) {
        const input = { name: edit.name, description: edit.description?.trim() || edit.name,
          repositories: edit.value.split("\n").map(v => v.trim()).filter(Boolean), status: edit.status };
        if (edit.id) await updateBusinessModule(edit.id, input);
        else await createBusinessModule({ ...input, id: `module-${crypto.randomUUID()}` });
      } else await productVersionRequest(edit.id ? "PUT" : "POST", { id: edit.id, version: edit.name, branch: edit.value });
      setEdit(undefined); await refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
    <div className="mb-5 flex items-center gap-3">
      <Input className="max-w-md" aria-label="搜索配置" placeholder={modulesMode ? "搜索模块名称、代码仓" : "搜索版本、分支"}
        value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
      <Button variant="outline" onClick={() => { setQuery(""); setPage(1); }}>重置</Button>
      <Button variant="outline" disabled={loading} onClick={() => void refresh()}>刷新</Button>
      <Button className="ml-auto" onClick={() => { setError(""); setEdit({ name: "", value: "", status: "active" }); }}>
        ＋ 新建{modulesMode ? "模块" : "版本"}</Button>
    </div>
    {error && <p role="alert" className="mb-3 text-danger">{error}</p>}
    {!!warnings.length && <p role="alert" className="mb-3 text-attention">{warnings.join("；")}</p>}
    <p className="mb-4 text-sm text-muted-foreground">{modulesMode
      ? "维护模块与代码仓的映射。知识请在团队资产上传，并选择这里的模块。所有成员均可维护。"
      : "一个版本对应一个固定分支。需求与问题单选择版本后自动带出分支；已有任务不受后续修改影响。"}</p>
    <table className="w-full table-fixed text-left text-base">
      <thead className="border-y border-line bg-surface-2"><tr>
        <th className="w-1/4 p-4 font-medium">{modulesMode ? "业务模块" : "产品版本"}</th>
        <th className="p-4 font-medium">{modulesMode ? "关联代码仓" : "对应分支"}</th>
        <th className="w-44 p-4 font-medium">操作</th>
      </tr></thead>
      <tbody>{!loading && filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map(row => <tr key={row.id} className="border-b border-line">
        <td className="p-4 break-words font-medium">{row.name}{row.status === "archived" && <span className="ml-2 text-sm text-muted-foreground">已归档</span>}</td>
        <td className="p-4">{modulesMode ? <div className="flex flex-wrap items-center gap-2">
          {row.value.split("\n").filter(Boolean).slice(0, 3).map(repo => <span key={repo} title={repo}
            className="max-w-44 truncate rounded-md bg-surface-2 px-2 py-1 text-sm">{shortRepo(repo)}</span>)}
          <Button variant="outline" size="sm" onClick={() => { setAllRepos(modules.find(m => m.id === row.id)); setRepoQuery(""); }}>
            查看全部 {modules.find(m => m.id === row.id)?.repositories.length ?? 0} 个</Button>
        </div> : <code className="break-all text-sm">{row.value}</code>}</td>
        <td className="p-4"><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { setError(""); setEdit(row); }}>编辑</Button>
          {!modulesMode && <Button variant="ghost" size="sm" onClick={async () => {
            if (!await confirmDialog({ title: `删除版本「${row.name}」？`, message: "已有任务保留原分支。", confirmLabel: "删除" })) return;
            try { await productVersionRequest("DELETE", { id: row.id }); await refresh(); }
            catch (e) { setError(message(e)); }
          }}>删除</Button>}</div></td>
      </tr>)}</tbody>
    </table>
    {(loading || !filtered.length) && <p className="p-10 text-center text-muted-foreground">{loading ? "正在读取配置…" : query ? "没有匹配项" : "暂无配置，点击右上角新建"}</p>}
    <footer className="mt-5 flex items-center justify-between text-sm text-muted-foreground"><span>共 {filtered.length} 项 · 每页 {PAGE_SIZE} 项</span>
      <div className="flex items-center gap-3"><Button variant="outline" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</Button>
        <span>{current} / {pages}</span><Button variant="outline" size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>下一页</Button></div>
    </footer>
    <Dialog open={!!edit} onOpenChange={open => { if (!open && !busy) setEdit(undefined); }}>
      <DialogContent className="tw-root w-[620px] max-w-[90vw] sm:max-w-[620px] max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{edit?.id ? "编辑" : "新建"}{modulesMode ? "模块" : "版本"}</DialogTitle></DialogHeader>
        {edit && <form className="grid gap-4 text-base" onSubmit={e => { e.preventDefault(); void save(); }}>
          <label className="grid gap-2">{modulesMode ? "模块名称" : "版本名称"}<Input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
          {modulesMode ? <label className="grid gap-2">关联代码仓<Textarea className="min-h-48" required value={edit.value}
            placeholder="每行一个代码仓地址" onChange={e => setEdit({ ...edit, value: e.target.value })} /></label>
            : <label className="grid gap-2">分支名称<Input required value={edit.value} onChange={e => setEdit({ ...edit, value: e.target.value })} /></label>}
          {modulesMode && <label className="grid gap-2">模块说明（可选）<Input value={edit.description ?? ""} onChange={e => setEdit({ ...edit, description: e.target.value })} /></label>}
          {modulesMode && edit.id && <label className="flex items-center gap-2"><input type="checkbox" checked={edit.status === "archived"}
            onChange={e => setEdit({ ...edit, status: e.target.checked ? "archived" : "active" })} />归档模块（已有任务和知识保留）</label>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={busy} onClick={() => setEdit(undefined)}>取消</Button><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!allRepos} onOpenChange={open => { if (!open) setAllRepos(undefined); }}>
      <DialogContent className="tw-root w-[720px] max-w-[90vw] sm:max-w-[720px]">
        <DialogHeader><DialogTitle>{allRepos?.name} · 关联代码仓</DialogTitle></DialogHeader>
        <Input aria-label="搜索关联代码仓" placeholder="搜索代码仓" value={repoQuery} onChange={e => setRepoQuery(e.target.value)} />
        <ul className="max-h-[50vh] overflow-y-auto text-sm">{allRepos?.repositories.filter(repo => repo.toLowerCase().includes(repoQuery.toLowerCase())).map(repo =>
          <li className="border-b border-line py-3 break-all" key={repo}>{repo}</li>)}</ul>
      </DialogContent>
    </Dialog>
  </div>;
}
