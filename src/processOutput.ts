/** 输出管道断开不应终止执行；入口和执行器都在第一条日志之前安装。 */
export function muzzleBrokenPipes(): void {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream.listenerCount("error")) stream.on("error", () => { /* 日志是旁路。 */ });
  }
}
