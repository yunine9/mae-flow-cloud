import type { WorkflowExecutionProfile } from "./api";

export function WorkflowProfileCard({ profile, warning }: {
  profile: WorkflowExecutionProfile;
  warning?: string;
}) {
  const sourceName = profile.source.label
    ?? (profile.source.kind === "platform" ? "平台标准方案"
      : profile.source.kind === "task" ? "本任务临时方案" : profile.source.id);
  const version = profile.source.version ?? profile.base_snapshot.standard_version;
  const digest = profile.source.digest ?? profile.revision;
  const unavailable = profile.asset_manifest.filter((item) =>
    item.state !== "available").length;
  return <section className="workflow-profile-card" aria-label="本任务固定工作流方案">
    <header>
      <span aria-hidden>WF</span>
      <div><small>本任务固定方案</small><strong>{sourceName}</strong>
        <p>任务只执行这一份最终方案；资产升级或改名不会改写当前任务。</p></div>
      <div className="workflow-profile-version"><b>{version}</b>
        <code title={digest}>{shortDigest(digest)}</code></div>
    </header>
    <div className="workflow-profile-facts">
      <span><b>{profile.final_snapshot.stages.length}</b> 个固定阶段</span>
      <span><b>{profile.edits.length}</b> 项精确变更</span>
      <span className={unavailable ? "warning" : "ok"}>
        <b>{profile.asset_manifest.length - unavailable}/{profile.asset_manifest.length}</b>
        项资产可用</span>
      <span><b>{profile.diagnostics.length}</b> 条编译诊断</span>
    </div>
    {(warning || unavailable > 0) && <p className="workflow-profile-warning" role="status">
      {warning ?? `${unavailable} 项固定资产当前不可用；平台已只回退对应单项，其余定制继续生效。`}
    </p>}
  </section>;
}

function shortDigest(value: string): string {
  const digest = value.replace(/^sha256:/, "");
  return `sha256:${digest.slice(0, 10)}…`;
}
