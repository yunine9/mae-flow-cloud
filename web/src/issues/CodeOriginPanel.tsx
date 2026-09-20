/**
 * 一次生成归属明细(ADR-0044,工单 #339/#340):终态伴生快照
 * (code-origin.json)的人读面——聚合行 + 每仓三分类 + 逐提交证据。
 * 会话工作台(SessionView,归档后呈现)与交付分析「问题处理」页签
 * (DeliveryAnalytics,行点击下钻)共用同一份事实与同一渲染。
 * 缺席(未归档/未算完/早于起算日期)如实说明,不猜不补。
 */
import { useEffect, useState } from "react";
import {
  getIssueCodeOrigin,
  type IssueCodeOriginDetail,
  type IssueCodeOriginRepoOk,
} from "../api";
import { cn } from "cn";

const HEAD_BASIS_TEXT: Record<IssueCodeOriginRepoOk["head_basis"], string> = {
  merged_sha: "账面合入头",
  mr_branch: "MR 分支头",
  local_push: "本地末笔推送(缺平台外尾部)",
};

const FEEDBACK_TEXT: Record<string, string> = {
  review_sent: "检视批次送出",
  pipeline_repaired: "流水线失败进修复",
  verify_fail: "环境验证发现问题",
};

const ORIGIN_TEXT: Record<"first" | "rework" | "external", string> = {
  first: "首轮",
  rework: "返工",
  external: "平台外",
};

const ORIGIN_CLASS: Record<"first" | "rework" | "external", string> = {
  first: "text-success",
  rework: "text-attention",
  external: "text-muted-foreground",
};

const num = (value: number) => value.toLocaleString("zh-CN");
const percent = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(1)}%`;

/** 三分类行的合计占比(行数加权,与读侧同一口径;纯展示)。 */
function shareOf(lines: { first: number; rework: number; external: number }) {
  const total = lines.first + lines.rework + lines.external;
  return total ? Math.round((lines.first / total) * 1000) / 10 : null;
}

export function IssueCodeOriginPanel({ id, threshold }: {
  id: string;
  /** 达标线(统计端点带回);缺席只展示占比,不出达标判定。 */
  threshold?: number;
}) {
  const [snapshot, setSnapshot] = useState<IssueCodeOriginDetail>();
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setMissing(false);
    getIssueCodeOrigin(id)
      .then((body) => { if (alive) setSnapshot(body); })
      .catch(() => { if (alive) setMissing(true); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [id]);

  if (busy) {
    return <p className="m-0 text-sm text-muted-foreground">正在读取一次生成归属…</p>;
  }
  if (missing || !snapshot) {
    return <p className="m-0 text-sm text-muted-foreground">
      该会话暂无一次生成统计(未归档、未算完或早于起算日期)。</p>;
  }

  const ok = snapshot.by_repo.filter((repo): repo is IssueCodeOriginRepoOk =>
    !("unavailable" in repo));
  const total = ok.reduce((sum, repo) => ({
    first: sum.first + repo.lines.first,
    rework: sum.rework + repo.lines.rework,
    external: sum.external + repo.lines.external,
  }), { first: 0, rework: 0, external: 0 });
  const share = shareOf(total);

  return <div className="grid gap-3">
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-lg border border-line bg-surface px-4 py-3">
      <strong className="text-sm text-text-strong">
        一次生成占比 <span className="text-lg tabular-nums">{percent(share)}</span>
      </strong>
      {threshold !== undefined && share !== null && (
        <span className={cn("text-sm font-semibold",
          share >= threshold ? "text-success" : "text-attention")}>
          {share >= threshold ? "达标" : "未达标"}(线 {threshold}%)
        </span>
      )}
      <span className="text-sm text-muted-foreground">
        首轮 {num(total.first)} 行 · 返工 {num(total.rework)} 行 · 平台外 {num(total.external)} 行
        (平台外改的行计入分母——AI 没一次生成就算没做到)
      </span>
      <span className="ml-auto text-xs text-muted-foreground">
        冻结于 {new Date(snapshot.generated_at).toLocaleString("zh-CN")}
      </span>
    </div>
    {snapshot.by_repo.map((repo) => "unavailable" in repo ? (
      <div key={`${repo.repo} ${repo.branch}`}
        className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted-foreground">
        {repo.repo} · {repo.branch}:不可得——{repo.unavailable.replace(/^不可得[:：]?/, "")}
      </div>
    ) : (
      <div key={`${repo.repo} ${repo.branch}`}
        className="rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <strong className="min-w-0 truncate text-sm text-text-strong">
            {repo.repo} · {repo.branch}
          </strong>
          <span className="text-xs text-muted-foreground" title="统计头与区间的取得口径(ADR-0044 的 head 四级优先级)">
            口径:{HEAD_BASIS_TEXT[repo.head_basis]}
          </span>
          <span className="ml-auto text-sm tabular-nums">
            <span className="text-success">首轮 {num(repo.lines.first)}</span>
            {" · "}
            <span className="text-attention">返工 {num(repo.lines.rework)}</span>
            {" · "}
            <span className="text-muted-foreground">平台外 {num(repo.lines.external)}</span>
            {" · "}
            占比 <strong>{percent(shareOf(repo.lines))}</strong>
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {repo.boundary
            ? `返工边界:${FEEDBACK_TEXT[repo.boundary.kind] ?? repo.boundary.kind}`
              + `(${new Date(repo.boundary.at).toLocaleString("zh-CN")})`
              + ` 之后的推送计返工`
            : "全程没有反馈事件:全部平台推送计首轮"}
        </p>
        {repo.commits.length > 0 && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              行归属证据({repo.commits.length} 个提交拥有留存行)
            </summary>
            <table className="mt-2 w-full text-left text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">提交</th>
                  <th className="py-1 pr-3 font-medium">分类</th>
                  <th className="py-1 pr-3 font-medium">行数</th>
                  <th className="py-1 font-medium">说明</th>
                </tr>
              </thead>
              <tbody>
                {repo.commits.map((commit) => (
                  <tr key={commit.sha} className="border-t border-line">
                    <td className="py-1 pr-3 font-mono" title={commit.sha}>
                      {commit.sha.slice(0, 10)}
                    </td>
                    <td className={cn("py-1 pr-3 font-semibold", ORIGIN_CLASS[commit.origin])}>
                      {ORIGIN_TEXT[commit.origin]}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{num(commit.lines)}</td>
                    <td className="py-1 text-muted-foreground">{commit.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    ))}
  </div>;
}
