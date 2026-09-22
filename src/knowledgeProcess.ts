import { spawn } from "node:child_process";

export class KnowledgeProcessError extends Error {
  constructor(readonly code: string | number, readonly killed = false) { super("知识工具执行失败"); }
}
/** Bounded CLI execution; abort also terminates document-parser child processes. */
export function runKnowledgeCommand(file: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new KnowledgeProcessError("cancelled", true));
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(file, args, { env: options.env ?? process.env, cwd: options.cwd, detached, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0, failure: KnowledgeProcessError | undefined;
    const stop = (code: string) => {
      failure ??= new KnowledgeProcessError(code, true);
      try { if (detached && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs); timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) stop("output_limit"); else chunks.push(chunk); });
    // Discard diagnostics instead of allowing credentials or commands to escape through an exception.
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) stop("output_limit"); });
    child.on("error", (error: NodeJS.ErrnoException) => { failure ??= new KnowledgeProcessError(error.code ?? "execution"); });
    child.on("close", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new KnowledgeProcessError(code ?? "execution"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
