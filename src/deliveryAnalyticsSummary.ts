import { emptyOrigins, type DeliveryAnalysisRow, type OriginCounts } from "./deliveryAnalyticsTypes";
export const sumOrigins = (counts: OriginCounts): number => Object.values(counts).reduce((a, b) => a + b, 0);
export function aggregateDelivery(rows: DeliveryAnalysisRow[]) {
  const retained = emptyOrigins(), rework = emptyOrigins();
  let available = 0, deleted = 0;
  for (const row of rows) {
    if (!row.metric) continue;
    available++;
    for (const key of Object.keys(retained) as Array<keyof OriginCounts>) {
      retained[key] += row.metric.retained[key];
      rework[key] += row.metric.rework[key];
    }
    deleted += row.metric.deleted;
  }
  const total = sumOrigins(retained);
  return { retained, rework, available, tasks: rows.length, total, deleted,
    firstPercent: total ? retained.first / total * 100 : null };
}

/** Count only actual merged delivery leaves; each has one root requirement owner. */
export function aggregateDeliveryModules(rows: DeliveryAnalysisRow[]) {
  const groups = new Map<string, { id: string; name: string; lines: number }>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.merged || !row.metric || seen.has(row.id)) continue;
    seen.add(row.id);
    const id = row.business_module?.id ?? "";
    const group = groups.get(id) ?? { id, name: row.business_module?.name ?? "未关联模块", lines: 0 };
    group.lines += sumOrigins(row.metric.retained); groups.set(id, group);
  }
  const total = [...groups.values()].reduce((sum, group) => sum + group.lines, 0);
  return [...groups.values()].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name))
    .map(group => ({ ...group, percent: total ? group.lines / total * 100 : 0 }));
}
