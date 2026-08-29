/**
 * 材料域:会话材料页签(DTS 单据 / 结论文档 / 工作区变更含快速修改 /
 * 拉取日志)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 结构照搬任务工作台交付材料页(ws-pane-head + ws-source-switch +
 * ws-doc),diff 用同一把 GitDiff 渲染;聚合 diff 按服务端自己的分段
 * 标记切片在 perRepo.ts(splitDiffByRepo)。结论文档子视图
 * (IssueConclusionDoc)只有材料页签渲染,随本文件走。
 * 快速修改是问题流唯一的人工写口——只改 repo/ 内已有文件,保存入
 * 人工台账,"请 AI 复核"走现有插话/续聊通道。
 */
import { useEffect, useMemo, useState } from "react";
import {
  getDtsTicketDetail,
  getIssueAnalysis,
  getIssueFileDiff,
  getIssueMaterialLog,
  getIssueMaterials,
  getIssueWorkspaceFile,
  saveIssueWorkspaceFile,
  type DtsTicketDetail,
  type IssueDetail,
  type IssueMaterials,
} from "../api";
import { Markdown } from "../markdown";
import { GitDiff } from "../GitDiff";
import { prepareDtsHtml } from "./dtsHtml";
import { splitDiffByRepo } from "./perRepo";

/** 结论文档(issue-analysis.md):激活页签时才取;状态一动(updated_at
 * 变化)自动重读,让 AI 续写的内容能贴着节奏刷新。 */
function IssueConclusionDoc({ id, updatedAt }: { id: string; updatedAt: string }) {
  const [docKey, setDocKey] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await getIssueAnalysis(id);
      if (result.unavailable) {
        setNote(result.unavailable);
        setContent("");
      } else {
        setNote("");
        setContent(result.content ?? "");
      }
      // 只在拿到响应后记账:半路失败下次仍会重试。
      setDocKey(updatedAt);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (docKey !== updatedAt) void load();
    // docKey 有意不在依赖里:刷新按钮要的是无视缓存的重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt]);

  return <div className="issue-thread issue-doc">
    {loading && <p className="issue-thread-empty">正在读取结论文档…</p>}
    {!loading && note && <div className="issue-doc-empty">
      <strong>还没有结论文档</strong>
      <p>{note}——AI 研究中会把结论写入 issue-analysis.md,生成后这里直接可读。</p>
    </div>}
    {!loading && !note && content && <>
      <div className="issue-doc-toolbar">
        <span>研究现场落盘的 markdown · 即写即读</span>
        <button type="button" onClick={() => void load()}>刷新</button>
      </div>
      <article className="issue-doc-body">
        <Markdown text={content} />
      </article>
    </>}
  </div>;
}

/** 会话材料(材料页签):DTS 单据 / 结论文档 / 工作区变更 / 拉取日志。
 * 数据全部旁路:任何一块失败给空态。
 * 子视图状态在会话层(右栏"结论文档已产出"要能一步跳进来)。 */
export function IssueMaterialsPane({ detail, busy, view, onView, onNotifyAI }: {
  detail: IssueDetail;
  busy: boolean;
  view: "dts" | "changes" | "logs" | "doc";
  onView: (view: "dts" | "changes" | "logs" | "doc") => void;
  onNotifyAI: (text: string) => Promise<boolean>;
}) {
  const [data, setData] = useState<IssueMaterials>();
  const [note, setNote] = useState("");
  const [allDiff, setAllDiff] = useState("");
  // 逐仓分片:聚合 diff 按服务端自己的分段标记(service.workspaceDiffAll
  // 写入的「===== 仓库 <名> =====」)切成每仓一段;"" = 合并视图(缺省,
  // 与旧版一致)。不带 path 的聚合接口一次拿全,前端只做切片渲染。
  const [diffSections, setDiffSections] = useState<
    Array<{ name: string; diff: string }>
  >([]);
  const [diffRepo, setDiffRepo] = useState("");
  // 快速修改:选中文件 → 编辑器;undefined 表示未选中。
  const [activeFile, setActiveFile] = useState<string>();
  const [content, setContent] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [dtsDetail, setDtsDetail] = useState<DtsTicketDetail>();
  const [logView, setLogView] = useState<{ name: string; content: string }>();

  async function load() {
    try {
      const [materials, diff] = await Promise.all([
        getIssueMaterials(detail.id),
        getIssueFileDiff(detail.id),
      ]);
      const sections = splitDiffByRepo(diff.diff);
      setData(materials);
      setAllDiff(diff.diff);
      setDiffSections(sections);
      // 手选的仓刷新后仍在清单里才保留;仓的改动清零了就回合并视图。
      setDiffRepo((current) => current
        && (sections.some((section) => section.name === current)
          || materials.changes.some((change) =>
            change.path.split(/[\\/]/)[0] === current))
        ? current : "");
      setNote("");
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  useEffect(() => {
    void load();
    // 会话状态一动(AI 可能改了工作区)就刷新;id 变化由父层换页签兜底。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updated_at]);

  async function editFile(path: string) {
    setActiveFile(path);
    setContent(undefined);
    try {
      const file = await getIssueWorkspaceFile(detail.id, path);
      setContent(file.content);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  async function save() {
    if (!activeFile || content === undefined || saving) return;
    setSaving(true);
    try {
      await saveIssueWorkspaceFile(detail.id, activeFile, content);
      setNote(`已保存 ${activeFile}。改动建议让 AI 复核一次。`);
      await load();
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }

  async function openLog(name: string) {
    try {
      const log = await getIssueMaterialLog(detail.id, name);
      setLogView({ name, content: log.content });
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  useEffect(() => {
    if (view === "dts" && data?.ticket && !dtsDetail) {
      getDtsTicketDetail(data.ticket)
        .then(setDtsDetail)
        .catch((reason) => {
          setNote(String(reason instanceof Error ? reason.message : reason));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, data?.ticket]);

  const changes = data?.changes ?? [];

  // 可切的仓 = diff 分段名 ∪ 变更清单路径首段(服务端 listMaterials 给
  // 每条变更加 <仓名>/ 前缀)。两者都来自 API 输出,前端不猜仓清单。
  const diffRepos = useMemo(() => {
    const names: string[] = [];
    for (const section of diffSections) {
      if (section.name && !names.includes(section.name)) names.push(section.name);
    }
    for (const change of changes) {
      const head = change.path.split(/[\\/]/)[0];
      if (head && !names.includes(head)) names.push(head);
    }
    return names;
  }, [diffSections, changes]);
  const activeDiff = diffRepo
    ? diffSections.find((section) => section.name === diffRepo)?.diff ?? ""
    : allDiff;

  return <div className="issue-materials">
    <div className="ws-pane-head">
      <div><span>材料清单</span><strong>会话材料</strong></div>
      <div className="ws-source-switch" aria-label="材料类型">
        <button className={view === "dts" ? "on" : ""}
          disabled={!data?.ticket} onClick={() => onView("dts")}>
          <span>DTS 单据</span><i>{data?.ticket ? "1" : "0"}</i>
        </button>
        <button className={view === "doc" ? "on" : ""}
          disabled={!detail.has_analysis} onClick={() => onView("doc")}>
          <span>结论文档</span><i>{detail.has_analysis ? "1" : "0"}</i>
        </button>
        <button className={view === "changes" ? "on" : ""}
          onClick={() => onView("changes")}>
          <span>工作区变更</span><i>{changes.length}</i>
        </button>
        <button className={view === "logs" ? "on" : ""}
          onClick={() => onView("logs")}>
          <span>拉取日志</span><i>{data?.logs.length ?? 0}</i>
        </button>
      </div>
    </div>
    {note && <div className="utility-note">{note}</div>}
      {view === "changes" && <>
        {detail.status === "running" && <div className="utility-note">
          AI 正在运行:此刻的编辑可能被它覆盖,建议空闲/等待时再改。
        </div>}
        {diffRepos.length > 1 && <div className="issue-diff-repo-switch" role="group"
            aria-label="按仓查看工作区变更">
          <button type="button" className={diffRepo === "" ? "on" : ""}
            onClick={() => setDiffRepo("")}>全部合并</button>
          {diffRepos.map((name) => (
            <button type="button" key={name}
              className={diffRepo === name ? "on" : ""}
              onClick={() => setDiffRepo(name)}>{name}</button>
          ))}
        </div>}
        <div className="ws-doc">
          {activeDiff
            ? <GitDiff text={activeDiff} hideKey={detail.id} />
            : <div className="utility-note">
                {diffRepo ? "该仓当前没有可展示的改动。" : "工作区当前没有改动。"}
              </div>}
        </div>
      <div className="issue-materials-editor">
        <div className="issue-materials-editor-bar">
          <strong>快速修改</strong>
          <select value={activeFile ?? ""}
            onChange={(event) => {
              const path = event.target.value;
              if (path) void editFile(path);
            }}>
            <option value="">选择要修改的文件…</option>
            {changes.map((change) => <option key={change.path}
              value={change.path}>{change.path}</option>)}
          </select>
          <button type="button" className="primary" disabled={saving
            || !activeFile || content === undefined} onClick={save}>
            {saving ? "保存中…" : "保存修改"}
          </button>
          <button type="button" disabled={busy || saving || !activeFile}
            title="把这次人工改动告知 AI,请它复核后继续"
            onClick={() => activeFile && onNotifyAI(
              `[人工修改] 我直接改了 ${activeFile},请复核这份改动,与你的方案不一致时先说明再继续。`)}>
            请 AI 复核
          </button>
        </div>
        {activeFile && (content !== undefined
          ? <textarea value={content} spellCheck={false}
              onChange={(event) => setContent(event.target.value)} />
          : <p className="issue-materials-empty">读取中…</p>)}
      </div>
      <section className="issue-materials-block">
        <h4>人工修改记录({data?.manual_edits.length ?? 0})</h4>
        {data?.manual_edits.length === 0 && <p className="issue-materials-empty">
          还没有人工改动——从上方选择文件编辑保存后会记在这里。
        </p>}
        <ul className="issue-materials-edits">
          {data?.manual_edits.slice().reverse().map((edit, index) => <li
            key={`${edit.ts}-${index}`}>
            <span>{new Date(edit.ts).toLocaleTimeString()}</span>
            <span className="p">{edit.path}</span>
          </li>)}
        </ul>
      </section>
    </>}
    {view === "dts" && <div className="ws-doc">
      {dtsDetail ? <>
        <p className="issue-materials-dts-head">
          <strong>{dtsDetail.title || "(无标题)"}</strong>
          {dtsDetail.severity && <span>级别:{dtsDetail.severity}</span>}
          {dtsDetail.version && <span>版本:{dtsDetail.version}</span>}
          {dtsDetail.submitter && <span>提单:{dtsDetail.submitter}</span>}
          {dtsDetail.url && <a href={dtsDetail.url} target="_blank" rel="noreferrer">原始单</a>}
        </p>
        <div className="issue-materials-html issue-dts-detail-html"
          dangerouslySetInnerHTML={{
            __html: prepareDtsHtml(dtsDetail.description || dtsDetail.content)
              || "(无描述)",
          }}
        />
      </> : <div className="utility-note">正在读取单据详情…</div>}
    </div>}
    {view === "doc" && <>
      {/* 结论文档按 updated_at 缓存:文档可能被 AI 续写,状态一动就该重读。 */}
      <IssueConclusionDoc id={detail.id} updatedAt={detail.updated_at} />
    </>}
    {view === "logs" && <div className="ws-doc">
      {data && data.logs.length === 0 && <div className="utility-note">
        本会话还没有拉取过日志。
      </div>}
      <div className="issue-materials-files" role="list">
        {data?.logs.map((log) => <button type="button" role="listitem"
          key={log.name}
          className={`issue-materials-file${logView?.name === log.name ? " on" : ""}`}
          onClick={() => openLog(log.name)}>
          <span className="p">{log.name}</span>
          <span className="num">{(log.size / 1024).toFixed(1)} KB</span>
        </button>)}
      </div>
      {logView && <pre className="issue-materials-diff">{logView.content}</pre>}
    </div>}
  </div>;
}
