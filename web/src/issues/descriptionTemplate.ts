/**
 * 登记描述预填模板(#273):标准提单的填空形态,登记页打开即预填,
 * 用户照着填——格式合规靠阻力最小路径,不再依赖 AI 润色(ADR-0030)。
 * 文案 2026-09-16 按提单口径重写:去 markdown 修饰,触发条件并入触发
 * 步骤,发生时间/版本给示例,复现概率收敛为必现/偶现;业务模块与网管
 * 环境登记表单单独采集,不重复进模板。2026-09-18 对齐提单系统版式:
 * 段首(基本信息/问题描述)带冒号;每栏一行、栏间空行——进 Quill 各栏
 * 独立成段,编辑器里有段落间距。模板是
 * UI 文案,住前端常量,不走 promptCopy 的资产挂载。
 *
 * 原样拦截与提交后重置都以本常量为基准:比较前把两侧空白全剥掉——
 * 所见即所得编辑器序列化的往返会动空白(换行/列表空隙),剥空白后
 * 比较才稳。用户不想用模板,整段删掉自由书写仍然合法(必填校验照旧)。
 */
export const ISSUE_DESCRIPTION_TEMPLATE = `基本信息：

发生时间(例 2026-9-16 15:20:00)：

版本(例 MAE-NEM V100R027C10B005)：

复现概率：必现 / 偶现

问题描述：

触发步骤：
1.
2.

实际现象：

预期结果：
`;

/** 描述是否还是模板原样(剥空白比较):原样提交被登记页拦截——空模板
 * 会绕过「描述必填」校验,登记后白跑一轮 agent 首轮会话。 */
export function isUntouchedTemplate(description: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, "");
  return normalize(description) === normalize(ISSUE_DESCRIPTION_TEMPLATE);
}
