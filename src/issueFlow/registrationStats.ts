/**
 * 登记问题统计(ADR-0048):无单会话的结论漏斗与研究质量,交付分析
 * 「登记问题」页签的读侧。人群=无单流程会话;只数结论已出——非问题/
 * 确认是问题归档,加上取消;研究进行中与存量挂起一律不进,不给挂起
 * 设任何统计口径(存量挂起手动归档后按结论自然入账)。比率口径:
 * 非问题闭环率/确认是问题率分母=研究完成(含取消);一次定位率分母=
 * 非问题+确认是问题(取消不构成一次研究)。
 *
 * 零新增记账:结论在 issue.json,报告版本数在分析版本账,取消时刻用
 * 会话 updated_at——全部纯投影,无起算日,全历史可算。
 */

/** 取消会话没有研究评价:结论取 canceled,一次定位缺席。 */
export interface IssueRegistrationSessionRow {
  id: string;
  title: string;
  module: string;
  reporter: string;
  account: string;
  concluded_at: string;
  conclusion: "non_issue" | "issue" | "canceled";
  report_version_count: number;
  /** 一次定位(报告一版过);取消会话缺席。 */
  localization_pass?: boolean;
}

export interface IssueRegistrationGroupRow {
  key: string;
  total: number;
  non_issue: number;
  issue_confirmed: number;
  canceled: number;
  localization_passed: number;
  localization_total: number;
  localization_rate: number | null;
}

export interface IssueRegistrationStats {
  /** 研究完成 = 非问题 + 确认是问题 + 取消(本页唯一分母全集)。 */
  total: number;
  non_issue: number;
  issue_confirmed: number;
  canceled: number;
  /** 一次定位:分母 = 非问题 + 确认是问题。 */
  localization: { passed: number; total: number; rate: number | null };
  per_session: IssueRegistrationSessionRow[];
  by_module: IssueRegistrationGroupRow[];
  by_reporter: IssueRegistrationGroupRow[];
}

const percent = (passed: number, total: number): number | null =>
  total ? Math.round((passed / total) * 1000) / 10 : null;

function groupRows(
  rows: ReadonlyArray<IssueRegistrationSessionRow>,
  keyOf: (row: IssueRegistrationSessionRow) => string,
): IssueRegistrationGroupRow[] {
  const map = new Map<string, IssueRegistrationGroupRow>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key) ?? {
      key, total: 0, non_issue: 0, issue_confirmed: 0, canceled: 0,
      localization_passed: 0, localization_total: 0, localization_rate: null,
    };
    bucket.total += 1;
    if (row.conclusion === "non_issue") bucket.non_issue += 1;
    else if (row.conclusion === "issue") bucket.issue_confirmed += 1;
    else bucket.canceled += 1;
    if (row.localization_pass !== undefined) {
      bucket.localization_total += 1;
      if (row.localization_pass) bucket.localization_passed += 1;
    }
    map.set(key, bucket);
  }
  const list = [...map.values()];
  for (const bucket of list) {
    bucket.localization_rate =
      percent(bucket.localization_passed, bucket.localization_total);
  }
  return list.sort((a, b) =>
    b.total - a.total || a.key.localeCompare(b.key, "zh-Hans-CN"));
}

/** 纯聚合:per_session(已按结论时刻降序)聚出瓦片计数与两维分组。 */
export function aggregateRegistrationStats(
  rows: ReadonlyArray<IssueRegistrationSessionRow>,
): IssueRegistrationStats {
  const nonIssue = rows.filter((row) => row.conclusion === "non_issue").length;
  const issueConfirmed = rows.filter((row) => row.conclusion === "issue").length;
  const canceled = rows.filter((row) => row.conclusion === "canceled").length;
  const localizationRows = rows.filter(
    (row) => row.localization_pass !== undefined);
  const localizationPassed =
    localizationRows.filter((row) => row.localization_pass).length;
  return {
    total: rows.length,
    non_issue: nonIssue,
    issue_confirmed: issueConfirmed,
    canceled,
    localization: {
      passed: localizationPassed,
      total: localizationRows.length,
      rate: percent(localizationPassed, localizationRows.length),
    },
    per_session: [...rows],
    by_module: groupRows(rows, (row) => row.module),
    by_reporter: groupRows(rows, (row) => row.reporter),
  };
}
