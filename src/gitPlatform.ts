/**
 * Git 平台与权威流水线——内网能力的可替换模拟(主 spec §7.3/§10/§14.5)。
 *
 * 真假件共同遵守的语义:
 * - 服务端仓库是唯一远端真相:任务从它克隆,分支推回它;
 * - MR 属于(源分支→目标分支),重复创建返回已有 MR,不翻倍;
 * - 流水线结果与 Commit SHA 绑定:旧结果不能用于新代码,
 *   查询时 SHA 不匹配一律视为"没跑过",不许拿旧绿灯背书新提交;
 * - MR 创建成功≠可合入:流水线通过前状态是"验证中"。
 *
 * 假件形态:本地裸仓(git init --bare,从源仓灌历史)+ 环回 HTTP
 * (POST /mr、GET /mr、POST /pipeline/trigger、GET /pipeline/status)。
 * 内网真件(公司 GitLab/流水线)就绪时换 baseUrl 与鉴权,语义不变。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PipelineCheck } from "./pipelineContract.ts";

export interface MergeRequest {
  id: number;
  source_branch: string;
  target_branch: string;
  title: string;
  sha: string;
  state: "验证中" | "等待合入";
  url: string;
  /** 平台侧生命周期(门禁契约用):opened=在途,merged/closed=终态。 */
  merge_state: "opened" | "merged" | "closed";
  /** 关联的 E2E 单号(REQ/DTS):真件走 --e2e-issues,假件存证同语义
   * ——测试据此裁"宿主把单号递到了平台",不许只拼进 title。 */
  e2e_issues?: string;
}

/** 检视讨论(真件=CodeHub 的 MR discussion;假件同语义)。 */
export interface Discussion {
  id: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body: string;
  resolved: boolean;
  /** 发布过的回复(测试断言"回复真到了平台"用)。 */
  replies: string[];
}

export interface PipelineRun {
  id: number;
  sha: string;
  status: "running" | "success" | "failed";
  /** 可选的逐项诊断事实；明确 failed/pending 优先于总体状态。缺席时
   * execution_contract 已声明覆盖范围，整体 success 可聚合核销。 */
  checks?: PipelineCheck[];
  /** 失败详情(平台原文)。修复 agent 的口粮:没有它,修就是瞎修。
   * 内网真件从"拉日志"CLI 映射到这个字段,契约同形。 */
  log?: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export class FakeGitPlatform {
  readonly mergeRequests: MergeRequest[] = [];
  readonly pipelines: PipelineRun[] = [];
  /** 测试注入:下一次流水线的结局(默认 success)。
   * "running" = 模拟真实平台的异步流水线:触发后先跑着,
   * 结局由 finishPipeline 事后裁定。 */
  nextPipelineStatus: "success" | "failed" | "running" = "success";
  /** 失败时随 run 带出的日志(默认给个像样的样板)。 */
  nextPipelineLog = "BUILD FAILURE: 模块 notify-service 编译失败";
  /** 逐次结局队列:修复环一类"先红后绿"的剧本按序消费,
   * 空了退回 nextPipelineStatus——比测试里掐时序翻开关可靠。 */
  readonly statusQueue: Array<"success" | "failed" | "running"> = [];
  /** 模拟仅提供总体状态的平台（仍可聚合核销，诊断粒度较低）。 */
  omitTypedChecks = false;
  /** 测试可覆盖下一次 run 的逐项结果；触发后消费一次。 */
  nextPipelineChecks?: PipelineCheck[];
  /** 检视讨论(测试注入 seedDiscussion;修复闭环回复+resolve 落这里)。 */
  readonly discussions: Discussion[] = [];
  /** 冲突门禁:true=conflict_passed 不过(真件由平台判,假件测试拨)。 */
  conflictGate = false;
  /** 等人类门禁覆盖(approvers_passed 等):不设=通过。
   * 测试拨 false 模拟"等审批",拨回 true 模拟"有人批了"。 */
  readonly humanGates: Record<string, boolean> = {};
  /** 流水线附件(批2 落盘契约):测试注入,按名给文本。 */
  readonly artifacts: Array<{ name: string; text: string }> = [];
  barePath = "";
  private server?: Server;
  private counter = 0;

  /** 从源仓灌历史建裸仓——任务的 origin,推送的唯一去处。 */
  initBare(sourceRepo: string, dataDir: string): string {
    this.barePath = join(dataDir, "origin.git");
    mkdirSync(this.barePath, { recursive: true });
    git(this.barePath, "init", "--bare", "--quiet");
    execFileSync(
      "git", ["push", "--quiet", this.barePath, "--all"],
      { cwd: sourceRepo, encoding: "utf-8" });
    // 裸仓 HEAD 默认指向 init.defaultBranch,与源仓分支名不符时
    // clone 会得到空工作树(git 只警告不报错)。显式对齐源仓当前分支。
    const head = git(sourceRepo, "branch", "--show-current") || "master";
    git(this.barePath, "symbolic-ref", "HEAD", `refs/heads/${head}`);
    return this.barePath;
  }

  get baseUrl(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  branchSha(branch: string): string {
    return git(this.barePath, "rev-parse", branch);
  }

  /** 每个请求的身份头台账(测试断言用):真适配层靠这两个头把
   * MR 发起人落到任务归属人,假件只记录不消费。 */
  readonly seenIdentity: Array<{
    path: string;
    user?: string;
    token?: string;
  }> = [];

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        this.seenIdentity.push({
          path: url.pathname,
          user: request.headers["x-mfc-git-user"] as string | undefined,
          token: request.headers["x-mfc-git-token"] as string | undefined,
        });
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(
            Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          response.writeHead(400).end();
          return;
        }
        const reply = (status: number, payload: unknown) => {
          const text = JSON.stringify(payload);
          response
            .writeHead(status, { "content-type": "application/json" })
            .end(text);
        };
        try {
          const replyMatch = url.pathname.match(
            /^\/mr\/discussions\/([^/]+)\/reply$/);
          if (request.method === "POST" && url.pathname === "/mr") {
            reply(201, this.createMergeRequest(body));
          } else if (request.method === "GET" && url.pathname === "/mr") {
            reply(200, this.mergeRequests);
          } else if (request.method === "POST"
              && url.pathname === "/pipeline/trigger") {
            reply(201, this.triggerPipeline(String(body.sha ?? "")));
          } else if (request.method === "GET"
              && url.pathname === "/pipeline/status") {
            reply(200, this.pipelineStatus(
              url.searchParams.get("sha") ?? ""));
          } else if (request.method === "GET"
              && url.pathname === "/mr/gates") {
            reply(200, this.mergeGates(
              url.searchParams.get("source_branch") ?? "",
              url.searchParams.get("target_branch") ?? ""));
          } else if (request.method === "GET"
              && url.pathname === "/mr/discussions") {
            reply(200, { discussions: this.discussions
              .filter((item) => !item.resolved)
              .map(({ replies: _r, resolved: _s, ...rest }) => rest) });
          } else if (request.method === "POST" && replyMatch) {
            reply(200, this.replyDiscussion(replyMatch[1], body));
          } else if (request.method === "GET"
              && url.pathname === "/pipeline/artifacts") {
            reply(200, { files: this.artifacts });
          } else {
            reply(404, { error: "未知路径" });
          }
        } catch (error) {
          reply(400, { error: String(error) });
        }
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  /** 同(源→目标)分支已有 MR 时幂等返回——恢复重放不翻倍(§10 幂等键)。
   * 幂等复用时顺带把 sha 对齐到分支最新(修复推了新提交,MR 跟着走,
   * 真平台就是这个行为)。 */
  private createMergeRequest(body: Record<string, any>): MergeRequest {
    const source = String(body.source_branch ?? "");
    const target = String(body.target_branch ?? "");
    if (!source || !target) throw new Error("source_branch/target_branch 必填");
    const existing = this.mergeRequests.find(
      (mr) => mr.source_branch === source && mr.target_branch === target
        && mr.merge_state === "opened");
    if (existing) {
      existing.sha = this.branchSha(source);
      return existing;
    }
    const sha = this.branchSha(source); // 分支必须已推到位,否则这里抛错
    this.counter += 1;
    const mr: MergeRequest = {
      id: this.counter,
      source_branch: source,
      target_branch: target,
      title: String(body.title ?? source),
      e2e_issues: String(body.dts_no ?? "") || undefined,
      sha,
      state: "验证中",
      url: `${this.baseUrl}/mr/${this.counter}`,
      merge_state: "opened",
    };
    this.mergeRequests.push(mr);
    return mr;
  }

  /** 门禁九项的假件版:三项可修按真实状态算,等人类由测试拨。
   * 语义与真件对齐:名字用 CodeHub 原始拼写,passed 是布尔。 */
  private mergeGates(source: string, target: string): {
    mr_state: string;
    gates: Array<{ name: string; passed: boolean; detail?: string }>;
  } {
    const mr = this.mergeRequests.find(
      (item) => item.source_branch === source
        && item.target_branch === target);
    if (!mr) throw new Error(`MR(${source}->${target}) 不存在`);
    const unresolved = this.discussions.filter((item) => !item.resolved);
    const lastRun = this.pipelines.findLast((run) => run.sha === mr.sha);
    const gates = [
      {
        name: "resolve_discussion_passed",
        passed: unresolved.length === 0,
        ...(unresolved.length
          ? { detail: `${unresolved.length} 条检视意见未解决` } : {}),
      },
      {
        name: "conflict_passed",
        passed: !this.conflictGate,
        ...(this.conflictGate ? { detail: "与目标分支存在冲突" } : {}),
      },
      {
        name: "ci_state_passed",
        passed: lastRun?.status === "success",
        ...(lastRun?.status !== "success"
          ? { detail: `流水线 ${lastRun?.status ?? "未跑"}` } : {}),
      },
      ...Object.entries(this.humanGates).map(([name, passed]) => ({
        name, passed,
      })),
    ];
    return { mr_state: mr.merge_state, gates };
  }

  private replyDiscussion(
    id: string,
    body: Record<string, any>,
  ): { ok: boolean } {
    const discussion = this.discussions.find((item) => item.id === id);
    if (!discussion) throw new Error(`讨论 ${id} 不存在`);
    discussion.replies.push(String(body.body ?? ""));
    if (body.resolve === true) discussion.resolved = true;
    return { ok: true };
  }

  /** 测试注入:种一条未解决的检视意见。 */
  seedDiscussion(input: Omit<Discussion, "resolved" | "replies">): void {
    this.discussions.push({ ...input, resolved: false, replies: [] });
  }

  /** 测试裁定:平台侧把 MR 合入/关闭(审批人点了按钮)。 */
  settleMr(source: string, state: "merged" | "closed"): void {
    for (const mr of this.mergeRequests) {
      if (mr.source_branch === source) mr.merge_state = state;
    }
  }

  private triggerPipeline(sha: string): PipelineRun {
    if (!sha) throw new Error("sha 必填:流水线结果必须绑定代码版本");
    this.counter += 1;
    const status = this.statusQueue.shift() ?? this.nextPipelineStatus;
    const run: PipelineRun = {
      id: this.counter,
      sha,
      status,
      ...(!this.omitTypedChecks
        ? { checks: this.consumePipelineChecks(status) } : {}),
      log: status === "failed" ? this.nextPipelineLog : undefined,
    };
    this.pipelines.push(run);
    if (run.status === "success") {
      for (const mr of this.mergeRequests) {
        if (mr.sha === sha) mr.state = "等待合入";
      }
    }
    return run;
  }

  /** SHA 精确匹配才算数:旧绿灯不背书新代码(§14.5)。 */
  private pipelineStatus(sha: string): { sha: string; runs: PipelineRun[] } {
    return { sha, runs: this.pipelines.filter((run) => run.sha === sha) };
  }

  /** 异步流水线的事后裁定(模拟真实平台跑完):running → 终态,
   * 绿灯连带把同 SHA 的 MR 升为等待合入——与同步路径同一语义。 */
  finishPipeline(sha: string, status: "success" | "failed", log?: string): void {
    for (const run of this.pipelines) {
      if (run.sha === sha && run.status === "running") {
        run.status = status;
        if (!this.omitTypedChecks) {
          run.checks = this.consumePipelineChecks(status);
        }
        if (status === "failed") run.log = log ?? this.nextPipelineLog;
      }
    }
    if (status === "success") {
      for (const mr of this.mergeRequests) {
        if (mr.sha === sha) mr.state = "等待合入";
      }
    }
  }

  private consumePipelineChecks(
    status: "running" | "success" | "failed",
  ): PipelineCheck[] {
    const injected = this.nextPipelineChecks;
    this.nextPipelineChecks = undefined;
    if (injected) return injected.map((item) => ({ ...item }));
    if (status === "success") {
      return [
        { dimension: "COMPILE", status: "success", job: "compile" },
        { dimension: "UT", status: "success", job: "unit-test" },
        { dimension: "CODECHECK", status: "success", job: "codecheck" },
      ];
    }
    if (status === "running") {
      return [
        { dimension: "COMPILE", status: "running", job: "compile" },
        { dimension: "UT", status: "pending", job: "unit-test" },
        { dimension: "CODECHECK", status: "pending", job: "codecheck" },
      ];
    }
    return [
      { dimension: "COMPILE", status: "failed", job: "compile" },
      { dimension: "UT", status: "not_run", job: "unit-test" },
      { dimension: "CODECHECK", status: "not_run", job: "codecheck" },
    ];
  }
}
