import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Chrome 已打印断言结果即可结束；先停止整个进程组，再删除调用方的临时目录。 */
export async function browserResultDump(browser: string, args: string[], output: string): Promise<string> {
  const fd = openSync(output, "w");
  const child = spawn(browser, args, { detached: true, stdio: ["ignore", fd, "ignore"] });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  void closed.catch(() => undefined);
  let finished = false;
  try {
    await within(Promise.race([closed, (async () => {
      const deadline = Date.now() + 25_000;
      while (!finished && Date.now() < deadline) {
        if (/<pre[^>]*id="result"[^>]*>[^<]+<\/pre>/.test(readFileSync(output, "utf8"))) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!finished) throw new Error("桌面浏览器未在25秒内打印断言结果");
    })()]), 25_000, "桌面浏览器超过25秒执行预算");
    return readFileSync(output, "utf8");
  } finally {
    finished = true;
    try {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await within(closed, 5_000, "桌面浏览器终止后超过5秒退出预算");
    } finally { closeSync(fd); }
  }
}
