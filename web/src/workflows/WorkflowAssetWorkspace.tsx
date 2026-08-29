import { useEffect, useMemo, useState } from "react";
import {
  WorkflowApiError,
  copyWorkflowAsset,
  createWorkflowAsset,
  getWorkflowAsset,
  getWorkflowAssetCatalog,
  getWorkflowStandard,
  listWorkflowAssets,
  saveWorkflowDraft,
  workflowAssetAction,
  type WorkflowAssetCatalogItem,
  type WorkflowAssetDetail,
  type WorkflowAssetSummary,
  type WorkflowDefinition,
  type WorkflowExecutionProfile,
} from "../api";
import { WorkflowDetail } from "./WorkflowDetail";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowLibrary } from "./WorkflowLibrary";

type Page = "library" | "detail" | "editor";
type CreateDialog = {
  kind: "create" | "copy";
  source?: WorkflowAssetSummary;
  name: string;
  description: string;
  scope: "personal" | "team";
};
type ActionDialog = {
  action: "submit" | "withdraw" | "approve" | "reject" | "archive";
  title: string;
  explanation: string;
  requireReason?: boolean;
};

export function WorkflowAssetWorkspace() {
  const [page, setPage] = useState<Page>("library");
  const [workflows, setWorkflows] = useState<WorkflowAssetSummary[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkflowAssetCatalogItem[]>([]);
  const [standard, setStandard] = useState<WorkflowExecutionProfile["base_snapshot"]>();
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkflowAssetDetail>();
  const [definition, setDefinition] = useState<WorkflowDefinition>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [createDialog, setCreateDialog] = useState<CreateDialog>();
  const [actionDialog, setActionDialog] = useState<ActionDialog>();

  async function refreshLibrary(showLoading = false): Promise<void> {
    if (showLoading) setLoading(true);
    try {
      const result = await listWorkflowAssets();
      setWorkflows(result.items);
      setWarnings(result.warnings);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      listWorkflowAssets(), getWorkflowAssetCatalog(), getWorkflowStandard(),
    ]).then(([libraryResult, catalogResult, launchResult]) => {
      if (!alive) return;
      if (libraryResult.status === "fulfilled") {
        setWorkflows(libraryResult.value.items);
        setWarnings(libraryResult.value.warnings);
      } else setError(messageOf(libraryResult.reason));
      if (catalogResult.status === "fulfilled") {
        setCatalog(catalogResult.value.items);
        setWarnings((current) => [...current, ...catalogResult.value.warnings]);
      } else {
        setWarnings((current) => [...current,
          `资产目录暂不可用：${messageOf(catalogResult.reason)}`]);
      }
      if (launchResult.status === "fulfilled") {
        setStandard(launchResult.value);
      } else {
        setWarnings((current) => [...current,
          `平台标准方案暂不可读：${messageOf(launchResult.reason)}`]);
      }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  async function openWorkflow(asset: WorkflowAssetSummary): Promise<void> {
    setSelectedId(asset.id);
    setPage("detail");
    setDetail(undefined);
    setDetailLoading(true);
    setError("");
    try {
      setDetail(await getWorkflowAsset(asset.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDetailLoading(false);
    }
  }

  function startCreate(): void {
    setDialogError("");
    setCreateDialog({ kind: "create", name: "", description: "", scope: "personal" });
  }

  function startCopy(asset: WorkflowAssetSummary): void {
    setDialogError("");
    setCreateDialog({
      kind: "copy", source: asset, name: `${asset.name}（副本）`,
      description: asset.description ?? "", scope: "personal",
    });
  }

  async function submitCreate(dialog: CreateDialog): Promise<void> {
    if (!dialog.name.trim() || busy) return;
    if (dialog.kind === "create" && !standard) {
      setDialogError("平台标准方案暂不可读，不能创建一个无法准确编译的工作流；刷新后重试即可。");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      const created = dialog.kind === "copy" && dialog.source
        ? await copyWorkflowAsset(dialog.source.id, {
            name: dialog.name.trim(), description: dialog.description.trim() || undefined,
            scope: dialog.scope,
          })
        : await createWorkflowAsset({
            name: dialog.name.trim(), description: dialog.description.trim() || undefined,
            scope: dialog.scope,
            definition: emptyDefinition(standard!),
          });
      setCreateDialog(undefined);
      await refreshLibrary();
      await openWorkflow(created);
    } catch (cause) {
      setDialogError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: ActionDialog, reason = ""): Promise<void> {
    if (!detail || busy) return;
    setBusy(true);
    setDialogError("");
    try {
      await workflowAssetAction(detail.asset.id, action.action,
        reason.trim() ? { reason: reason.trim() } : {});
      setActionDialog(undefined);
      await refreshLibrary();
      setDetail(await getWorkflowAsset(detail.asset.id));
    } catch (cause) {
      setDialogError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function askAction(action: ActionDialog["action"]): void {
    setDialogError("");
    const copy: Record<ActionDialog["action"], Omit<ActionDialog, "action">> = {
      submit: { title: "提交审核", explanation: "提交后草稿进入待审核状态；在审核前仍可撤回。" },
      withdraw: { title: "撤回审核", explanation: "撤回后回到草稿状态，可以继续编辑再提交。" },
      approve: { title: "审核通过并发布", explanation: "会生成一个不可覆盖的新版本，后续任务可精确选择它。" },
      reject: { title: "驳回工作流", explanation: "请明确写出需要调整的内容，维护者会看到原因。", requireReason: true },
      archive: { title: "归档工作流", explanation: "历史任务仍保留原版本；归档后新任务不能继续选择。" },
    };
    setActionDialog({ action, ...copy[action] });
  }

  const dirty = useMemo(() => Boolean(detail && definition
    && JSON.stringify(detail.draft.definition) !== JSON.stringify(definition)),
  [detail, definition]);
  const baselineMismatch = useMemo(() => Boolean(detail && standard && (
    detail.draft.definition.base.standard_id !== standard.standard_id
    || detail.draft.definition.base.standard_version !== standard.standard_version
    || detail.draft.definition.base.catalog_digest !== standard.catalog_digest
  )), [detail, standard]);

  if (page === "editor" && detail && definition && standard && !baselineMismatch) {
    return <WorkflowEditor name={detail.asset.name}
      description={detail.asset.description} definition={definition}
      base={standard} catalog={catalog} busy={busy} error={editorError}
      onDefinitionChange={(next) => { setDefinition(next); setEditorError(""); }}
      onSave={() => {
        if (busy) return;
        setBusy(true);
        setEditorError("");
        void saveWorkflowDraft(detail.asset.id, definition, detail.draft.revision)
          .then((updated) => {
            setDetail(updated);
            setDefinition(structuredClone(updated.draft.definition));
            void refreshLibrary();
          }).catch((cause) => {
            if (cause instanceof WorkflowApiError
                && cause.code === "revision_conflict") {
              setEditorError(`草稿已被别人更新到 r${cause.currentRevision ?? "?"}；`
                + "你的修改没有覆盖对方。返回详情刷新后再合并修改。");
            } else setEditorError(messageOf(cause));
          }).finally(() => setBusy(false));
      }}
      onExit={() => {
        if (!dirty || window.confirm("当前有尚未保存的修改，确定返回详情吗？")) {
          setPage("detail");
          setEditorError("");
        }
      }} />;
  }

  return <div className="wf-asset-workspace">
    {page === "library" ? <WorkflowLibrary workflows={workflows}
      loading={loading} error={error} warnings={warnings} selectedId={selectedId}
      onSelect={(asset) => void openWorkflow(asset)} onCreate={startCreate}
      onCopy={startCopy} onRefresh={() => void refreshLibrary(true)} />
      : <>
        {detail && error && <div className="wf-state-banner error" role="alert">
          <strong>操作未完成</strong><span>{error}</span>
        </div>}
        {detail && !standard && <div className="wf-state-banner warning" role="status">
          <strong>暂不可编辑</strong><span>平台标准方案读取失败；详情和生命周期操作仍可使用，刷新页面后再编辑。</span>
        </div>}
        {detail && baselineMismatch && <div className="wf-state-banner warning" role="status">
          <strong>基线已经升级</strong><span>这份草稿绑定旧版平台标准方案，历史内容仍可查看；系统不会拿新基线生成不准确的预览。请返回资产库新建一份当前基线方案。</span>
        </div>}
        <WorkflowDetail detail={detail} loading={detailLoading} error={detail ? "" : error}
          onBack={() => { setPage("library"); setError(""); }}
          onEdit={detail?.asset.permissions.can_edit && standard && !baselineMismatch ? () => {
            setDefinition(structuredClone(detail.draft.definition));
            setEditorError("");
            setPage("editor");
          } : undefined}
          onCopy={detail ? () => startCopy(detail.asset) : undefined}
          onSubmit={() => askAction("submit")}
          onWithdraw={() => askAction("withdraw")}
          onApprove={() => askAction("approve")}
          onReject={() => askAction("reject")}
          onArchive={() => askAction("archive")} />
      </>}
    {createDialog && <CreateWorkflowDialog value={createDialog} busy={busy}
      error={dialogError} onChange={setCreateDialog} onClose={() => {
        setCreateDialog(undefined); setDialogError("");
      }}
      onSubmit={() => void submitCreate(createDialog)} />}
    {actionDialog && <WorkflowActionDialog value={actionDialog} busy={busy}
      error={dialogError} onClose={() => {
        setActionDialog(undefined); setDialogError("");
      }}
      onSubmit={(reason) => void runAction(actionDialog, reason)} />}
  </div>;
}

function emptyDefinition(
  standard: WorkflowExecutionProfile["base_snapshot"],
): WorkflowDefinition {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: {
      standard_id: standard.standard_id,
      standard_version: standard.standard_version,
      catalog_digest: standard.catalog_digest,
    },
    applicability: {
      business_module_ids: [], repositories: [], technologies: [],
    },
    edits: [],
  };
}

function CreateWorkflowDialog({ value, busy, error, onChange, onClose, onSubmit }: {
  value: CreateDialog;
  busy: boolean;
  error?: string;
  onChange: (value: CreateDialog) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return <div className="wf-dialog-backdrop" role="presentation">
    <form className="wf-dialog" role="dialog" aria-modal="true"
      aria-labelledby="wf-create-title" onSubmit={(event) => {
        event.preventDefault(); onSubmit();
      }}>
      <header><span>{value.kind === "copy" ? "COPY WORKFLOW" : "NEW WORKFLOW"}</span>
        <h3 id="wf-create-title">{value.kind === "copy" ? "复制为独立工作流" : "创建工作流草稿"}</h3>
        <p>{value.kind === "copy"
          ? "副本记录来源，但不会跟随原方案自动变化。"
          : "从当前 Mae-Flow 标准方案开始，只保存你明确做出的结构化变更。"}</p></header>
      {error && <p className="wf-dialog-error" role="alert">{error}</p>}
      <label><span>名称</span><input required autoFocus maxLength={120}
        value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      <label><span>说明</span><textarea rows={3} maxLength={500}
        value={value.description}
        onChange={(event) => onChange({ ...value, description: event.target.value })} /></label>
      <fieldset><legend>保存范围</legend>
        <label><input type="radio" name="workflow-scope" checked={value.scope === "personal"}
          onChange={() => onChange({ ...value, scope: "personal" })} />个人资产</label>
        <label><input type="radio" name="workflow-scope" checked={value.scope === "team"}
          onChange={() => onChange({ ...value, scope: "team" })} />团队资产</label>
      </fieldset>
      <footer><button type="button" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="wf-primary" disabled={busy || !value.name.trim()}>
          {busy ? "正在保存…" : value.kind === "copy" ? "创建副本" : "创建草稿"}</button></footer>
    </form>
  </div>;
}

function WorkflowActionDialog({ value, busy, error, onClose, onSubmit }: {
  value: ActionDialog;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return <div className="wf-dialog-backdrop" role="presentation">
    <form className="wf-dialog compact" role="dialog" aria-modal="true"
      aria-labelledby="wf-action-title" onSubmit={(event) => {
        event.preventDefault(); onSubmit(reason);
      }}>
      <header><span>WORKFLOW ACTION</span><h3 id="wf-action-title">{value.title}</h3>
        <p>{value.explanation}</p></header>
      {error && <p className="wf-dialog-error" role="alert">{error}</p>}
      {value.requireReason && <label><span>调整说明</span><textarea autoFocus required
        rows={4} value={reason} onChange={(event) => setReason(event.target.value)}
        placeholder="写清楚需要修改什么，避免只说“不通过”。" /></label>}
      <footer><button type="button" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="wf-primary"
          disabled={busy || (value.requireReason && !reason.trim())}>
          {busy ? "正在处理…" : "确认"}</button></footer>
    </form>
  </div>;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
