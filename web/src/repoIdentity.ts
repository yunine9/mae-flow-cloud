/**
 * 仓身份归一(与后端工具层门禁同一把尺):trim/去尾斜杠/去 .git/
 * 小写。模块目录里的绑定地址与会话账面里的仓地址,`.git` 尾缀与大小
 * 写写法可能有差异,原样字符串比对会误判(先例:MetaPane 同款函数,
 * 2026-10-21 特性树绑定外标记时提出共用)。
 */
export function repoIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}
