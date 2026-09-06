/**
 * PlantUML 出图:用参考实现,不再自己实现文法。
 *
 * 为什么:前端手搓的四套解析器(时序/类/活动/拓扑)共 1,562 行,八月以来
 * 专门修"又不认某个写法"的提交 7 笔,每补一条还可能抢别的图的判定。
 * PlantUML 语法面大且没有正式文法,靠补是补不完的。用户 2026-09-06 拍板:
 * 生产宿主有 JDK,jar 随仓库 vendored,手搓渲染器删除。
 *
 * 形态:服务端 `java -jar plantuml-mit.jar -tsvg -pipe`,布局用自带 smetana
 * (不依赖 Graphviz),按源码哈希缓存到数据目录;前端只显示 SVG。
 * 出不了图(没有 Java、超时、jar 缺失)一律 fail-open:返回原因,页面原样
 * 显示源码——这是旁路,绝不影响任务。语法错误时 PlantUML 自己会画一张
 * 标出错行的错误图(退出码 200),照样返回给人看,并标 syntax_error。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLANTUML_JAR = resolve(
  dirname(fileURLToPath(import.meta.url)), "..", "vendor", "plantuml", "plantuml-mit-1.2026.8.jar");

/** 单张图的预算:smetana 布局大图也就几秒;超过就是卡死,不等。 */
export const PLANTUML_TIMEOUT_MS = 30_000;
export const PLANTUML_SOURCE_LIMIT = 256 * 1024;

export interface PlantUmlResult {
  svg?: string;
  /** PlantUML 判定源码有语法错误:svg 是它画的错误图(标出错行)。 */
  syntax_error?: boolean;
  /** 出不了图的原因(没有 Java / jar 缺失 / 超时 / 进程失败)。 */
  error?: string;
  cached?: boolean;
}

let javaCommand: string | null | undefined;

/** 找 Java:JAVA_HOME 优先,其次 PATH。结果缓存——一次进程里不会变。 */
export function findJava(): string | undefined {
  if (javaCommand !== undefined) return javaCommand ?? undefined;
  const candidates = [
    ...(process.env.JAVA_HOME ? [join(process.env.JAVA_HOME, "bin", "java")] : []),
    "java",
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf-8", timeout: 10_000 });
    if (!probe.error && probe.status === 0) {
      javaCommand = candidate;
      return candidate;
    }
  }
  javaCommand = null;
  return undefined;
}

/** 测试与自检用:重置 Java 探测缓存。 */
export function resetJavaProbe(): void {
  javaCommand = undefined;
}

export function plantUmlCacheKey(source: string): string {
  return createHash("sha256").update(`${PLANTUML_JAR}\0${source}`).digest("hex");
}

export async function renderPlantUml(
  source: string,
  options: { cacheDir?: string; jar?: string; timeoutMs?: number } = {},
): Promise<PlantUmlResult> {
  const text = String(source ?? "");
  if (!text.trim()) return { error: "没有 PlantUML 源码" };
  if (Buffer.byteLength(text) > PLANTUML_SOURCE_LIMIT) {
    return { error: `源码超过 ${PLANTUML_SOURCE_LIMIT / 1024} KB,不出图` };
  }
  const jar = options.jar ?? PLANTUML_JAR;
  if (!existsSync(jar)) return { error: `PlantUML 运行库缺失: ${jar}` };
  const java = findJava();
  if (!java) return { error: "服务端没有 Java,无法出图(生产宿主应带 JDK)" };

  const key = plantUmlCacheKey(text);
  const cachePath = options.cacheDir ? join(options.cacheDir, `${key}.svg`) : undefined;
  const flagPath = options.cacheDir ? join(options.cacheDir, `${key}.syntax-error`) : undefined;
  if (cachePath && existsSync(cachePath)) {
    return { svg: readFileSync(cachePath, "utf-8"), cached: true,
      ...(flagPath && existsSync(flagPath) ? { syntax_error: true } : {}) };
  }

  // 源码里的 @startuml/@enduml 缺席时补上:文档里常常只写正文。
  const wrapped = /@start\w+/.test(text) ? text : `@startuml\n${text}\n@enduml\n`;
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((done) => {
    const child = spawn(java, [
      "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8",
      "-jar", jar, "-tsvg", "-pipe", "-Playout=smetana", "-charset", "UTF-8",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); },
      options.timeoutMs ?? PLANTUML_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, stdout: "", stderr: String(error), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"), timedOut });
    });
    child.stdin.on("error", () => { /* 子进程先死时的 EPIPE:close 会给结论 */ });
    child.stdin.end(wrapped);
  });

  if (outcome.timedOut) return { error: `出图超过 ${(options.timeoutMs ?? PLANTUML_TIMEOUT_MS) / 1000} 秒,已终止` };
  const svg = outcome.stdout.trim();
  if (!svg.startsWith("<svg") && !svg.startsWith("<?xml")) {
    return { error: `PlantUML 进程失败(退出码 ${outcome.code ?? "?"}): ${outcome.stderr.trim().slice(0, 300) || "没有输出"}` };
  }
  // 退出码 200 = 语法错误,PlantUML 已把出错行画进图里;其它非零一并当图给人看。
  const syntaxError = outcome.code !== 0;
  if (cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, svg);
      if (syntaxError && flagPath) writeFileSync(flagPath, "");
    } catch { /* 缓存是旁路 */ }
  }
  return { svg, ...(syntaxError ? { syntax_error: true } : {}) };
}
