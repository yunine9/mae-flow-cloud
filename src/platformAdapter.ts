/**
 * CodeHub 适配层——把内部 CLI(codehubcli)翻译成宿主消费的三端点契约。
 *
 * 定位:进内网当天要填的只有配置文件里的命令行,本文件零改动。
 * 内部平台是 CodeHub(类比 GitHub):CLI 配一个平台 token 即可做
 * MR 等操作;宿主每个请求带任务归属人的令牌头,MR 发起人=本人,
 * 没带时回落适配层自己配的服务账号 token。
 *
 * 契约(与 docs/deploy-intranet.md 一字对应):
 *   POST /mr               {repo, source_branch, target_branch, title} → {url}
 *   POST /pipeline/trigger {repo, sha} → {status, log?}
 *   GET  /pipeline/status?sha=&repo=   → {runs: [{status, log?}]}
 *
 * 纪律(与本仓宪法一致):
 * - 诚实失败:CLI 缺失/非零退出/输出解析不出/状态映射不到,一律 502
 *   带原文,绝不猜一个状态糊弄宿主——假绿比失败害人;
 * - 一切等待带预算:CLI 调用有超时(默认 60s),绝无无限等待;
 * - 密钥不落日志:token 只进 CLI 参数,日志里一律掩码;
 * - 配置坏了拒绝启动(部署配置语义,同 serve --config)。
 *
 * 配置形状(JSON,权限 600——里面可能有服务账号 token):
 * {
 *   "port": 8790,
 *   "token": "<服务账号令牌,可选>",        // 或 "token_file": "路径"
 *   "timeout_s": 60,
 *   "mr_create": {
 *     "command": ["codehubcli", "mr", "create", "--repo", "{repo}",
 *                 "--source", "{source_branch}", "--target", "{target_branch}",
 *                 "--title", "{title}", "--token", "{token}", "--json"],
 *     "url": {"json": "data.web_url"}      // 或 {"regex": "https://\\S+"}
 *   },
 *   "pipeline_trigger": {
 *     "command": [...同上占位符,外加 {sha}...],
 *     "status": {"json": "data.state"},    // 或 {"const": "running"}
 *     "log": {"json": "data.fail_log"},    // 可选
 *     "status_map": {"SUCCESS": "success", "FAILED": "failed",
 *                    "RUNNING": "running", "PENDING": "running"}
 *   },
 *   "pipeline_status": {
 *     "command": [...],
 *     "runs": {"json": "data.runs"},       // 指向数组;缺省=整个输出是数组
 *     "status": {"json": "state"},         // 相对每个 run 元素
 *     "log": {"json": "fail_log"},
 *     "status_map": {...}
 *   }
 * }
 *
 * 占位符:{repo} {source_branch} {target_branch} {title} {sha}
 *        {token} {git_username}(后两个优先取请求头里的个人身份)。
 * 命令以 argv 数组直接 spawn,不过 shell——标题带空格、注入都不是问题。
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

type Extract = { json?: string; regex?: string; const?: string };

interface CommandSpec {
  command: string[];
  timeout_s?: number;
  status?: Extract;
  log?: Extract;
  url?: Extract;
  runs?: Extract;
  status_map?: Record<string, string>;
}

interface AdapterConfig {
  port?: number;
  /** 监听地址,默认 127.0.0.1(只给本机宿主)。适配层在 Windows 侧、
   * 宿主在 WSL 里时才需要放开(它拿着服务令牌,放开要想清楚)。 */
  host?: string;
  token?: string;
  token_file?: string;
  timeout_s?: number;
  mr_create: CommandSpec;
  pipeline_trigger: CommandSpec;
  pipeline_status: CommandSpec;
}

const CONTRACT_STATUS = new Set(["success", "failed", "running"]);

class AdapterError extends Error {}

/** 点路径取值:"data.runs.0.state" 一路走下去,走不通=undefined。 */
function dig(source: unknown, path: string): unknown {
  let current: any = source;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

/** 从 CLI 输出里抠一个值。json=点路径(要求 stdout 是 JSON),
 * regex=第一个捕获组(没有捕获组就取整个匹配),const=固定值
 * (给"触发成功但不回状态"的 CLI 用)。抠不到=诚实报错,不猜。 */
function extract(
  spec: Extract | undefined,
  what: string,
  stdout: string,
  parsed: () => unknown,
): unknown {
  if (!spec) return undefined;
  if (spec.const !== undefined) return spec.const;
  if (spec.json !== undefined) {
    const value = dig(parsed(), spec.json);
    if (value === undefined) {
      throw new AdapterError(
        `${what}: CLI 输出的 JSON 里没有 ${spec.json}(输出前 500 字:`
        + `${stdout.slice(0, 500)})`);
    }
    return value;
  }
  if (spec.regex !== undefined) {
    const match = new RegExp(spec.regex, "m").exec(stdout);
    if (!match) {
      throw new AdapterError(
        `${what}: 正则 ${spec.regex} 在 CLI 输出里没匹配到`);
    }
    return match[1] ?? match[0];
  }
  throw new AdapterError(`${what}: 抽取配置必须给 json/regex/const 之一`);
}

/** 平台状态 → 契约状态。映射表没配=输出必须已经是契约词;
 * 映射不到=502,拒绝猜测——把 UNKNOWN 猜成 running 会让宿主
 * 白轮询到预算耗尽,猜成 failed 会白烧一轮修复。 */
function mapStatus(
  raw: unknown,
  map: Record<string, string> | undefined,
): string {
  const key = String(raw ?? "");
  const mapped = map ? map[key] ?? map[key.toUpperCase()] : key;
  if (!mapped || !CONTRACT_STATUS.has(mapped)) {
    throw new AdapterError(
      `流水线状态 "${key}" 不在映射表里,拒绝猜测——`
      + `请在 status_map 里补上它对应 success/failed/running 哪个`);
  }
  return mapped;
}

export class PlatformAdapter {
  private readonly config: AdapterConfig;
  private serviceToken = "";

  constructor(configPath: string, private log = console.error) {
    // 部署配置语义:坏了拒绝启动。带着一半配置起服,比不起服更害人。
    const raw = readFileSync(configPath, "utf-8");
    this.config = JSON.parse(raw) as AdapterConfig;
    for (const section of
        ["mr_create", "pipeline_trigger", "pipeline_status"] as const) {
      const spec = this.config[section];
      if (!Array.isArray(spec?.command) || spec.command.length === 0) {
        throw new Error(`配置缺 ${section}.command(argv 数组)`);
      }
    }
    if (this.config.token_file) {
      this.serviceToken = readFileSync(this.config.token_file, "utf-8").trim();
    } else if (this.config.token) {
      this.serviceToken = this.config.token;
    }
  }

  /** 模板套值 + 执行。token 优先用请求头里的个人令牌(MR 发起人=
   * 本人),没有回落服务账号;引用了 {token} 又两头都没有=502,
   * 不带着空令牌去撞平台。 */
  private run(
    spec: CommandSpec,
    values: Record<string, string>,
  ): Promise<string> {
    const [executable, ...args] = spec.command.map((part) =>
      part.replace(/\{(\w+)\}/g, (_whole, name: string) => {
        const value = values[name];
        if (value === undefined || value === "") {
          throw new AdapterError(
            `命令引用了 {${name}} 但没有值`
            + (name === "token" ? "(个人令牌没带、服务账号也没配)" : ""));
        }
        return value;
      }));
    const timeoutMs =
      (spec.timeout_s ?? this.config.timeout_s ?? 60) * 1000;
    return new Promise((resolve, reject) => {
      execFile(executable, args,
        { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new AdapterError(
              `CLI 失败: ${executable} 退出异常(${error.message.slice(0, 200)})`
              + `\nstderr: ${String(stderr).slice(0, 1000)}`));
          } else {
            // Windows CLI(WSL 互操作调 .exe / 适配层直跑 Windows)输出
            // 是 \r\n,\r 会咬正则抽取一口——统一归一化,JSON 不受影响。
            resolve(String(stdout).replace(/\r/g, ""));
          }
        });
    });
  }

  /** 请求级取值表。个人身份从请求头来(percent 编码,防非 ASCII
   * 撞 HTTP 头限制),宿主侧 tryDeliver 同一约定。 */
  private values(
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const decode = (value: unknown) => {
      try {
        return decodeURIComponent(String(value ?? ""));
      } catch {
        return String(value ?? "");
      }
    };
    const personal = decode(headers["x-mfc-git-token"]);
    return {
      repo: String(body.repo ?? ""),
      source_branch: String(body.source_branch ?? ""),
      target_branch: String(body.target_branch ?? ""),
      title: String(body.title ?? ""),
      sha: String(body.sha ?? ""),
      token: personal || this.serviceToken,
      git_username: decode(headers["x-mfc-git-user"]),
    };
  }

  async handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ status: number; payload: unknown }> {
    if (method === "GET" && path === "/") {
      return { status: 200, payload: {
        ok: true,
        endpoints: ["POST /mr", "POST /pipeline/trigger",
                    "GET /pipeline/status?sha=&repo="],
      } };
    }
    if (method === "POST" && path === "/mr") {
      const spec = this.config.mr_create;
      const stdout = await this.run(spec, this.values(body, headers));
      let parsedCache: unknown;
      const parsed = () => parsedCache ??= JSON.parse(stdout);
      const url = extract(spec.url, "MR 链接", stdout, parsed);
      return { status: 201, payload: { url: String(url ?? "") } };
    }
    if (method === "POST" && path === "/pipeline/trigger") {
      const spec = this.config.pipeline_trigger;
      const stdout = await this.run(spec, this.values(body, headers));
      let parsedCache: unknown;
      const parsed = () => parsedCache ??= JSON.parse(stdout);
      const status = mapStatus(
        extract(spec.status, "流水线状态", stdout, parsed), spec.status_map);
      const log = spec.log
        ? String(extractOptional(spec.log, stdout, parsed) ?? "") : undefined;
      return { status: 201, payload: { status, log } };
    }
    if (method === "GET" && path === "/pipeline/status") {
      const spec = this.config.pipeline_status;
      const stdout = await this.run(spec, this.values({
        sha: query.get("sha") ?? "",
        repo: query.get("repo") ?? "",
      }, headers));
      let parsedCache: unknown;
      const parsed = () => parsedCache ??= JSON.parse(stdout);
      const list = spec.runs
        ? extract(spec.runs, "runs 数组", stdout, parsed)
        : parsed();
      if (!Array.isArray(list)) {
        throw new AdapterError("pipeline_status 抽出来的不是数组");
      }
      const runs = list.map((run) => ({
        status: mapStatus(
          extract(spec.status, "run 状态", stdout, () => run),
          spec.status_map),
        log: spec.log
          ? String(extractOptional(spec.log, stdout, () => run) ?? "")
          : undefined,
      }));
      return { status: 200, payload: { runs } };
    }
    return { status: 404, payload: { error: "未知路径" } };
  }

  serve(port?: number): Promise<number> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          response.writeHead(400).end('{"error":"请求体不是 JSON"}');
          return;
        }
        this.handle(request.method ?? "GET", url.pathname,
          url.searchParams, body,
          request.headers as Record<string, string | undefined>)
          .then(({ status, payload }) => {
            response
              .writeHead(status, { "content-type": "application/json" })
              .end(JSON.stringify(payload));
          })
          .catch((error) => {
            // 诚实失败:宿主拿到 502 会如实记"平台不可用",
            // 绝不下发一个猜出来的状态。日志里不出现令牌。
            this.log(`[adapter] ${url.pathname}: ${String(error?.message ?? error)}`);
            response
              .writeHead(502, { "content-type": "application/json" })
              .end(JSON.stringify({ error: String(error?.message ?? error) }));
          });
      });
    });
    return new Promise((resolve) => {
      const listenPort = port ?? this.config.port ?? 8790;
      // 默认只听回环:适配层拿着服务令牌执行 CLI,敞给全网卡等于
      // 内网任何人都能借服务账号建 MR。宿主在本机时不需要暴露;
      // 适配层跑在 Windows 侧、宿主在 WSL 里隔墙喊话时,配置里
      // 显式给 host(如 0.0.0.0),自担边界。
      const listenHost = this.config.host ?? "127.0.0.1";
      server.listen(listenPort, listenHost, () =>
        resolve((server.address() as { port: number }).port));
    });
  }
}

/** 可选字段的抽取:抠不到不报错(log 缺席是常态),抠到才带上。 */
function extractOptional(
  spec: Extract,
  stdout: string,
  parsed: () => unknown,
): unknown {
  try {
    return extract(spec, "", stdout, parsed);
  } catch {
    return undefined;
  }
}

// 直跑入口:npm run adapter -- --config /etc/mae-flow-cloud/adapter.json
if (process.argv[1]?.endsWith("platformAdapter.ts")) {
  const flagAt = process.argv.indexOf("--config");
  const configPath = flagAt >= 0 ? process.argv[flagAt + 1] : "";
  if (!configPath) {
    console.error("用法: tsx src/platformAdapter.ts --config <adapter.json>");
    process.exit(2);
  }
  try {
    const adapter = new PlatformAdapter(configPath);
    void adapter.serve().then((port) => {
      console.log(`[adapter] CodeHub 适配层就绪: http://127.0.0.1:${port}`);
      console.log("[adapter] 宿主侧: npm run serve -- --platform http://127.0.0.1:" + port);
    });
  } catch (error) {
    console.error(`[adapter] 配置不可用,拒绝启动: ${String(error)}`);
    process.exit(2);
  }
}
