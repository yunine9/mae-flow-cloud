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
