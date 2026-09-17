/** 问题工作台深链路径的唯一拼写处(ADR-0040):工作台是独立浏览器页签,
 * 应用内卡片一律以 `<a target="_blank">` 打开本路径,不再页内跳转。
 * 与 App 的路由读写(readIssueRoute)同格式:encodeURIComponent(id)。 */
export function issueSessionPath(id: string): string {
  return `/issues/${encodeURIComponent(id)}`;
}
