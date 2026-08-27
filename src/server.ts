/**
 * 任务 API(主 spec §5.1/§5.2):REST 命令 + SSE 事件流,零框架依赖。
 *
 *   POST /tasks                {requirement}            → 201 摘要
 *   GET  /tasks                                         → 列表
 *   GET  /knowledge-insights                            → 团队知识效能(只读)
 *   GET  /skills                                        → Skill 货架 + 操作留痕
 *   GET  /skills/:dir/versions                          → 归档版本痕(可回退点)
 *   PUT  /skills/:dir          {files:[{path,content_base64}]} → 上传/更新(管理员)
 *   DELETE /skills/:dir                                 → 下线并归档(管理员)
 *   POST /skills/:dir/rollback {version}                → 回退归档版本(管理员)
 *   POST /skills/:dir/distill                           → 从任务现场起草修订稿(管理员)
 *   GET  /skills/:dir/candidates[/:id]                  → 修订候选列表/详情
 *   POST /skills/:dir/candidates/:id/adopt              → 采纳候选,走上架闸(管理员)
 *   DELETE /skills/:dir/candidates/:id                  → 丢弃候选(管理员)
 *   GET  /tasks/:id                                     → 详情(含待办)
 *   POST /tasks/:id/decision   {state_version,decision,notes?}
 *        → 200;版本冲突/已被抢先 → 409 "任务状态已变化"(先到决定生效)
 *   POST /tasks/:id/interrupt  {text}                   → 200;跑动中插话(发送即打断)
 *   GET/POST /tasks/:id/developer-assistant             → 旁路开发助手现场/发起处理
 *   POST /tasks/:id/pause|resume|cancel                 → 200;任务控制
 *   POST /tasks/:id/rerun                               → 200;原位清空并从头重跑
 *   DELETE /tasks/:id                                   → 200;管理员彻底删除真终态历史
 *   GET  /tasks/:id/interrupts                          → 发过的插话 + 送达与否
 *   GET  /tasks/:id/annotations                         → 待送出批注 + 锚点现状
 *   POST /tasks/:id/annotations {artifact,file,line,anchor,note,kind} → 201
 *   PATCH /tasks/:id/annotations/:annId {note}        → 修改(只能改自己的)
 *   DELETE /tasks/:id/annotations/:annId                → 软删(只能删自己的)
 *   POST /tasks/:id/annotations/send {ids?}             → 走插话通道当场送给模型
 *   POST /tasks/:id/annotations/:annId/verify           → 裁决:确认通过(只裁自己的)
 *   POST /tasks/:id/annotations/:annId/reopen           → 裁决:返工,退回草稿再送一轮
 *   GET  /tasks/:id/events                              → SSE:重放事件日志后持续跟进
 *   GET  /tasks/:id/prepush/events                      → SSE:推送前验证实时事件(换轮自动切新)
 *   GET  /tasks/:id/warmup/events                       → SSE:环境预热编译实时事件
 *   GET  /tasks/:id/timeline                            → 人话交付时间线(只读现场)
 *   GET  /tasks/:id/activity                            → 行为摘要:此刻在干嘛/分段折叠/异常信号
 *   GET  /tasks/:id/artifacts[/:name]                   → 检视产物清单/内容(只读现场)
 *
 * Web 不自行推断状态:详情与列表只是 TaskService 状态的镜像,
 * 事件流只是 events.jsonl 的镜像——真相都在文件与状态机里。
 */

import { createServer, type Server } from "node:http";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { StateConflictError } from "./humanGate.ts";
import {
  DEFAULT_WORKSPACE_RETENTION_DAYS,
  NotFoundError,
  TaskControlError,
  type TaskService,
} from "./taskService.ts";
import { buildTimeline } from "./timeline.ts";
import {
  listArtifactsAsync,
  readArtifactAsync,
  resolveArtifactRoot,
} from "./artifacts.ts";
import { WEB_PAGE } from "./webPage.ts";
import {
  cookieValue,
  type AuthUser,
  type LocalAuth,
} from "./auth.ts";
import { SettingsError } from "./settings.ts";
import {
  checkModelGateway,
  GatewayCheckError,
  resolveGatewayTarget,
} from "./modelGatewayCheck.ts";
import {
  AnnotationError,
  AnnotationPermissionError,
} from "./annotations.ts";
import type { LubanApprovalGateway } from "./lubanApproval.ts";
import { handleIssueRoutes } from "./issueFlow/routes.ts";
import {
  SkillLibraryError,
  listSkillOperations,
  listSkillVersions,
  offlineHostSkill,
  rollbackHostSkill,
  uploadHostSkill,
} from "./hostSkillLibrary.ts";
import {
  SkillDistillError,
  adoptSkillCandidate,
  discardSkillCandidate,
  listSkillCandidates,
  readSkillCandidate,
} from "./skillDistiller.ts";

/** 正式前端静态文件的最小类型表:Vite 产物就这几种。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

function readBody(request: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** 回调正文卡在 16 KiB：这里只有工号和一条文本命令，大包没有用途。 */
function readRawBody(
  request: import("node:http").IncomingMessage,
  limit = 16 * 1024,
): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) reject(new Error("回调正文超过 16 KiB"));
      else resolveBody(Buffer.concat(chunks).toString("utf-8"));
    });
    request.on("error", reject);
  });
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

/** 从这次 HTTP 请求还原用户真正访问的站点。浏览器 Origin 最接近
 * 用户地址栏，即使反代把后端 Host 改成 127.0.0.1 也不受影响；其次
 * 才认 X-Forwarded-* 与 Host。--public-url 只用于特殊部署覆盖。 */
function requestBaseUrl(
  request: import("node:http").IncomingMessage,
): string | undefined {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  const origin = first(request.headers.origin);
  if (origin && origin !== "null") {
    try {
      const parsed = new URL(origin);
      if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch { /* 坏 Origin 继续走代理头和 Host，不挡请求。 */ }
  }
  const host = first(request.headers["x-forwarded-host"])
    ?? first(request.headers.host);
  if (!host || /[\r\n/\\]/.test(host)) return undefined;
  const forwardedProtocol = first(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function createTaskServer(
  service: TaskService,
  options: {
    webRoot?: string;
    auth?: LocalAuth;
    lubanApproval?: LubanApprovalGateway;
    issueFlow?: import("./issueFlow/service.ts").IssueFlowService;
  } = {},
): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const sessionToken = cookieValue(
        request.headers.cookie,
        "mae_flow_session",
      );
      const viewer = options.auth?.sessionUser(sessionToken);
      if (viewer) service.observeLinkBase(requestBaseUrl(request));

      // 小鲁班插件回调使用独立固定 Token，不依赖浏览器 Cookie。插件
      // 只获得这一个纯文本入口，绝不能借它穿透成通用任务 API。
      if (parts[0] === "integrations" && parts[1] === "luban"
          && parts[2] === "plugin" && parts.length === 3) {
        if (!options.lubanApproval) {
          return json(response, 404, { error: "未启用小鲁班手机审批" });
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          return json(response, 405, { error: "只接受 POST" });
        }
        let rawBody: string;
        try {
          rawBody = await readRawBody(request);
        } catch (error) {
          return json(response, 413, { error: String(error) });
        }
        const first = (value: string | string[] | undefined) =>
          Array.isArray(value) ? value[0] : value;
        const authorization = first(request.headers.authorization);
        const reply = await options.lubanApproval.handle({
          rawBody,
          token: first(request.headers["x-mfc-luban-plugin-token"])
            ?? authorization?.replace(/^Bearer\s+/i, ""),
        });
        return json(response, reply.status, {
          text: reply.text,
          ...(reply.replayed ? { replayed: true } : {}),
        });
      }
      /** 当前登录者自己缺的配置。两样都是"以本人身份做事"的凭据:
       * Git 令牌决定 push 与 MR 发起人是谁,通知令牌决定消息以谁的
       * 身份发——管理员代配不了(密钥只写不读),所以只能各人自己配,
       * 没配就别让他下单(用户 2026-08-18 拍板)。 */
      const personalBlockers = (
        who: { username: string; role?: string } | undefined,
      ): Array<{ key: string; label: string; where: "admin" | "me" }> => {
        if (!options.auth || !who) return [];
        // 管理员不发起任务,个人令牌对他不咬人——别拿"你缺 Git 令牌"
        // 去烦一个本来就不下单的角色。
        if (who.role === "admin") return [];
        const needs = service.launchOptions().needs;
        const missing: Array<
          { key: string; label: string; where: "admin" | "me" }> = [];
        const credential = needs.git_token
          ? options.auth.gitCredential(who.username) : undefined;
        if (needs.git_token && !credential) {
          missing.push({ key: "git_token", where: "me",
            label: "CodeHub Token 未配置（个人设置 → 个人接入），"
              + "没有它无法用你的身份推送代码" });
        }
        // 邮箱与令牌同级必填(用户拍板):commit 署名要它,平台按邮箱
        // 对人——缺它推上去的提交是无主的。老账号只配过令牌没配邮箱,
        // 在这儿被逮住补配,而不是等提交推上去才发现署名残缺。
        if (needs.git_token && credential && !credential.email) {
          missing.push({ key: "git_email", where: "me",
            label: "个人邮箱未配置（个人设置 → 个人接入），"
              + "Git 提交署名和 CodeHub 归属需要它" });
        }
        if (needs.luban_token && !options.auth.lubanToken(who.username)) {
          missing.push({ key: "luban_token", where: "me",
            label: "小鲁班 Token 未配置（个人设置 → 个人接入），"
              + "没有它就无法及时提醒你处理任务" });
        }
        return missing;
      };

      // 登录页资产公开，身份 API 自己决定是否需要会话。
      if (parts[0] === "auth") {
        if (request.method === "POST" && parts[1] === "login") {
          if (!options.auth) {
            return json(response, 404, { error: "未启用本地登录" });
          }
          const body = await readBody(request);
          const result = options.auth.authenticate(
            String(body.username ?? ""),
            String(body.password ?? ""),
            request.socket.remoteAddress ?? "unknown",
          );
          if (result.blockedForMs) {
            response.setHeader(
              "retry-after",
              String(Math.ceil(result.blockedForMs / 1000)),
            );
            return json(response, 429, {
              error: "登录失败次数过多，请稍后再试",
            });
          }
          if (!result.user) {
            return json(response, 401, { error: "账号或密码错误" });
          }
          const token = options.auth.createSession(result.user);
          response.setHeader("set-cookie", sessionCookie(token, request));
          // 登录成功后的首屏与刷新页面走的 /auth/me 必须是同一份视图。
          // 之前这里只回账号/角色，前端便把已有 Token 状态覆盖成“未配”。
          return json(response, 200,
            options.auth.sessionView(result.user.username));
        }
        if (request.method === "GET" && parts[1] === "me"
            && parts.length === 2) {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          return json(response, 200,
            options.auth!.sessionView(viewer.username));
        }
        if (request.method === "GET" && parts[1] === "me"
            && parts[2] === "moonlight-preview") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          return json(response, 200,
            service.previewMoonlight(viewer.username));
        }
        // 月光模式默认只影响后续节点。当前待办必须由调用方展示预览后
        // 显式带 include_current，且数量没有在确认期间发生变化。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "moonlight") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          const on = body.on === true;
          const preview = service.previewMoonlight(viewer.username);
          const includeCurrent = on && body.include_current === true;
          if (includeCurrent && Number(body.expected_eligible) !== preview.eligible) {
            return json(response, 409, {
              error: "待办数量已变化，请重新预览后确认",
              ...preview,
            });
          }
          options.auth!.setMoonlight(viewer.username, on);
          const swept = includeCurrent
            ? service.sweepMoonlight(viewer.username) : 0;
          return json(response, 200, { moonlight: on, swept, ...preview });
        }
        // push 前清单过目的个人默认(缺省即开):谁登录改谁的。
        // 关掉不撤已举的卡——那张卡按当时意愿举的,点确认即走。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "push-confirmation") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          options.auth!.setPushConfirmation(viewer.username, body.on === true);
          return json(response, 200,
            options.auth!.sessionView(viewer.username));
        }
        // 个人 Git 令牌:谁登录改谁的,写完只回掩码(只写不读)。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "git-token") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          try {
            options.auth!.setGitToken(
              viewer.username,
              String(body.token ?? ""),
              body.git_email === undefined
                ? undefined : String(body.git_email),
            );
          } catch (error) {
            return json(response, 400, { error: String(error) });
          }
          return json(response, 200,
            options.auth!.gitProfile(viewer.username));
        }
        // 个人通知令牌(小鲁班):同样只写不读。按人存是因为那个接口
        // 以令牌对应的人的身份发消息——管理员配一个服务号,所有人收到
        // 的都是同一个机器人；各人配自己的，普通提醒发给自己，主动
        // 邀请检视时则发给所选 Committer 工号。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "luban-token") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          try {
            options.auth!.setLubanToken(
              viewer.username, String(body.token ?? ""));
          } catch (error) {
            return json(response, 400, { error: String(error) });
          }
          return json(response, 200, {
            luban_token_hint: options.auth!.lubanTokenHint(viewer.username),
          });
        }
        if (request.method === "POST" && parts[1] === "logout") {
          options.auth?.endSession(sessionToken);
          response.setHeader("set-cookie", sessionCookie("", request, true));
          return json(response, 200, { ok: true });
        }
        if (parts[1] === "users") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          if (viewer.role !== "admin") {
            return json(response, 403, { error: "只有管理员可以管理账号" });
          }
          if (request.method === "GET" && parts.length === 2) {
            return json(response, 200, options.auth?.listUsers() ?? []);
          }
          if (request.method === "POST" && parts.length === 2) {
            const body = await readBody(request);
            try {
              const user = options.auth!.createUser(
                String(body.username ?? ""),
                String(body.password ?? ""),
                String(body.role ?? "developer") as "admin" | "developer",
              );
              return json(response, 201, user);
            } catch (error) {
              return json(response, 400, { error: String(error) });
            }
          }
          if (request.method === "PUT" && parts.length === 4
              && parts[3] === "committer") {
            const body = await readBody(request);
            try {
              const user = options.auth!.setCommitter(
                decodeURIComponent(parts[2]), body.on === true);
              return json(response, 200, user);
            } catch (error) {
              return json(response, 400, { error: String(error) });
            }
          }
          // 内部平台的管理员特权(用户拍板:内网自用,不要自助找回那
          // 套):改密码不验旧密码;删号即物理删除。守自己的两条底线
          // (删自己/删最后一个管理员)在 LocalAuth 里,这儿只递操作人。
          if (request.method === "PUT" && parts.length === 4
              && parts[3] === "password") {
            const body = await readBody(request);
            try {
              options.auth!.resetPassword(
                decodeURIComponent(parts[2]), String(body.password ?? ""));
              return json(response, 200, { ok: true });
            } catch (error) {
              return json(response, 400, { error: String(error) });
            }
          }
          if (request.method === "DELETE" && parts.length === 3) {
            try {
              options.auth!.deleteUser(
                decodeURIComponent(parts[2]), viewer.username);
              return json(response, 200, { ok: true });
            } catch (error) {
              return json(response, 400, { error: String(error) });
            }
          }
        }
        // Committer 名单不是账号管理能力：登录开发需要读取它，才能主动
        // 选择检视人；只有上面的管理员接口可以改名单。
        if (request.method === "GET" && parts[1] === "committers") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          return json(response, 200,
            options.auth?.listUsers().filter((user) => user.committer) ?? []);
        }
        return json(response, 404, { error: "未知身份接口" });
      }

      // 管理页服务设置:运行参数与模型网关。仓库/平台/端口等部署形态
      // 不在这儿——由启动配置固定注入，管理员只看自检结果。
      // 密钥只写不读:GET 永远给掩码,PUT 不给的键保持不动。
      if (parts[0] === "settings") {
        if (options.auth) {
          if (!viewer) return json(response, 401, { error: "请先登录" });
          if (viewer.role !== "admin") {
            return json(response, 403, { error: "只有管理员可以改服务设置" });
          }
        }
        if (request.method === "GET" && parts[1] === "check") {
          return json(response, 200, await service.systemCheck());
        }
        const settings = service.options.settings;
        if (!settings) {
          return json(response, 404, { error: "本部署未接运行时设置" });
        }
        const settingsView = () => {
          const providers = (service.options.modelsJson as {
            providers?: Record<string, any>;
          }).providers ?? {};
          const provider = service.options.provider || Object.keys(providers)[0];
          const modelSpec = providers[provider] ?? {};
          const model = service.options.model
            || String(modelSpec.models?.[0]?.id ?? "");
          return ({
            ...settings.view(),
            defaults: {
              runtime: {
                max_concurrent: service.options.maxConcurrent ?? 2,
                repair_rounds: service.options.delivery?.repairRounds ?? null,
                poll_interval_s:
                  (service.options.delivery?.pollIntervalMs ?? 10_000) / 1000,
                poll_timeout_s:
                  (service.options.delivery?.pollTimeoutMs ?? 30 * 60_000) / 1000,
                workspace_retention_days:
                  service.options.workspaceRetentionDays
                    ?? DEFAULT_WORKSPACE_RETENTION_DAYS,
              },
              models: {
                configured: !!modelSpec.baseUrl && !!modelSpec.apiKey && !!model,
                url: modelSpec.baseUrl ? String(modelSpec.baseUrl) : undefined,
                model: model || undefined,
              },
            },
          });
        };
        try {
          if (request.method === "GET" && parts.length === 1) {
            return json(response, 200, settingsView());
          }
          if (request.method === "PUT" && parts[1] === "runtime") {
            settings.updateRuntime(await readBody(request));
            return json(response, 200, settingsView());
          }
          if (request.method === "PUT" && parts[1] === "models") {
            settings.updateModels(await readBody(request));
            return json(response, 200, settingsView());
          }
          // 模型网关连通性测试:表单草稿优先,留空回落已存配置/部署
          // 默认(密钥"留空=沿用"与保存同口径)。与部署自检的分工:
          // 自检只读不外发;这里管理员主动发起一次真实外发请求。
          if (request.method === "POST" && parts[1] === "models"
              && parts[2] === "check") {
            const body = await readBody(request);
            const target = resolveGatewayTarget(body, settings.models(),
              service.options.modelsJson as Record<string, unknown> | undefined);
            return json(response, 200, await checkModelGateway(target));
          }
        } catch (error) {
          if (error instanceof SettingsError
              || error instanceof GatewayCheckError) {
            return json(response, 400, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知设置接口" });
      }

      // 问题流 API(/issues/*):独立于任务命名空间;未启用时由路由
      // 自己 404。必须先于静态托管兜底(非 /tasks 的 GET 会被接管)。
      if (parts[0] === "issues") {
        const handled = await handleIssueRoutes(request, response, parts, {
          issueFlow: options.issueFlow,
          viewer: viewer ?? undefined,
          authEnabled: Boolean(options.auth),
        });
        if (handled) return;
      }

      // 下单表单的数据源:模型清单与当前默认。登录即可看(不是密钥,
      // 只有名字);选项从当前生效的 models.json 来,设置层热改即时反映。
      // 必须先于静态托管兜底(和 /history 一样,非 /tasks 的 GET 会被接管)。
      if (request.method === "GET" && url.pathname === "/launch-options") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        const launch = service.launchOptions();
        return json(response, 200, {
          ...launch,
          blockers: [...launch.blockers, ...personalBlockers(viewer)],
        });
      }

      // 仓库 Skill 目录属于下单前的显式只读动作：用户填好仓和基线后
      // 才触发，服务端用本人的 Git 凭据读取；不把路径/正文交给浏览器
      // 决定。管理员没有下单入口，也不替开发者读取私仓。
      if (request.method === "POST"
          && url.pathname === "/repository-skills/scan") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        if (viewer?.role === "admin") {
          return json(response, 403, { error: "管理员不发起任务，不能读取仓内能力" });
        }
        const blockers = personalBlockers(viewer)
          .filter((item) => item.key === "git_token" || item.key === "git_email");
        if (blockers.length) {
          return json(response, 409, {
            error: "请先完成个人 CodeHub 接入，再读取私有仓库能力",
            blockers,
          });
        }
        try {
          const body = await readBody(request);
          const repositories = Array.isArray(body.repositories)
            ? body.repositories.map(String) : [];
          const baseline = body.baseline === undefined
            ? undefined : String(body.baseline);
          return json(response, 200, await service.scanRepositorySkills({
            repositories,
            baseline,
            account: viewer?.username,
          }));
        } catch (error) {
          return json(response, 400, { error: String(error) });
        }
      }

      const protectedRoute =
        url.pathname === "/history" || parts[0] === "tasks"
        || url.pathname === "/knowledge-insights"
        || parts[0] === "reviews" || parts[0] === "repository-skills"
        || parts[0] === "skills";
      // 兼容已经发出去的旧通知。/tasks/:id 是 JSON API，但旧链接若由
      // 浏览器作为页面打开，应带人去新的任务工作台；程序 fetch 默认
      // Accept: */*，仍拿原来的 JSON，不改变 API 契约。
      const legacyTaskPage = request.method === "GET"
        && parts[0] === "tasks" && parts.length === 2
        && String(request.headers.accept ?? "").includes("text/html");
      if (legacyTaskPage) {
        response.writeHead(302, {
          location: `/work/${encodeURIComponent(decodeURIComponent(parts[1]))}`,
          "cache-control": "no-store",
        });
        return response.end();
      }
      if (options.auth && protectedRoute && !viewer) {
        return json(response, 401, { error: "请先登录" });
      }

      // 历史读侧(§11):任务摘要投影来自 PG,跨进程生命周期。
      // 必须先于静态托管兜底判定——非 /tasks 前缀的 GET 会被它接管。
      if (request.method === "GET" && url.pathname === "/history") {
        const projection = service.options.projection;
        if (!projection) {
          return json(response, 404,
            { error: "未配置 PostgreSQL 投影(--pg),没有历史可查" });
        }
        return json(response, 200, await projection.listTaskHistory());
      }
      // 团队知识运营同样先于静态前端兜底；否则这个非 /tasks 的 GET
      // 会被当成前端资源并返回 404。只读口径与团队任务可见性一致。
      if (request.method === "GET" && url.pathname === "/knowledge-insights") {
        return json(response, 200, service.knowledgeInsights());
      }
      // 团队 Skill 资产库(货架的写半边):读与货架同口径(登录即可),
      // 写只归管理员,操作人逐条进留痕。写进数据目录即对下一单生效,
      // 快照器每任务从源重造——这里不用通知任何运行时组件。
      // GET 也必须先于静态托管兜底,否则会被当前端资源接管。
      if (parts[0] === "skills") {
        const dataDir = service.options.dataDir;
        if (request.method === "GET" && parts.length === 1) {
          return json(response, 200, {
            ...service.hostSkillShelf(),
            operations: listSkillOperations(dataDir),
          });
        }
        try {
          if (request.method === "GET" && parts.length === 3
              && parts[2] === "versions") {
            return json(response, 200, {
              versions: listSkillVersions(
                dataDir, decodeURIComponent(parts[1])),
            });
          }
          // 修订候选(沉淀环):读=登录即可(检视草稿是团队的事),
          // 起草/采纳/丢弃归管理员——采纳复用资产库同一道上架闸。
          if (request.method === "GET" && parts.length === 3
              && parts[2] === "candidates") {
            return json(response, 200, {
              candidates: listSkillCandidates(
                dataDir, decodeURIComponent(parts[1])),
            });
          }
          if (request.method === "GET" && parts.length === 4
              && parts[2] === "candidates") {
            return json(response, 200, readSkillCandidate(
              dataDir, decodeURIComponent(parts[1]),
              decodeURIComponent(parts[3])));
          }
          if (options.auth && viewer?.role !== "admin") {
            return json(response, 403,
              { error: "只有管理员可以管理团队 Skill" });
          }
          const operator = viewer?.username ?? "本地部署";
          if (request.method === "PUT" && parts.length === 2) {
            const body = await readBody(request);
            return json(response, 200, await uploadHostSkill(
              dataDir, decodeURIComponent(parts[1]),
              Array.isArray(body.files) ? body.files : [], operator));
          }
          if (request.method === "DELETE" && parts.length === 2) {
            return json(response, 200, await offlineHostSkill(
              dataDir, decodeURIComponent(parts[1]), operator));
          }
          if (request.method === "POST" && parts.length === 3
              && parts[2] === "rollback") {
            const body = await readBody(request);
            return json(response, 200, await rollbackHostSkill(
              dataDir, decodeURIComponent(parts[1]),
              String(body.version ?? ""), operator));
          }
          if (request.method === "POST" && parts.length === 3
              && parts[2] === "distill") {
            return json(response, 200, await service.distillSkillDraft(
              decodeURIComponent(parts[1]), operator));
          }
          if (request.method === "POST" && parts.length === 5
              && parts[2] === "candidates" && parts[4] === "adopt") {
            return json(response, 200, await adoptSkillCandidate(
              dataDir, decodeURIComponent(parts[1]),
              decodeURIComponent(parts[3]), operator));
          }
          if (request.method === "DELETE" && parts.length === 4
              && parts[2] === "candidates") {
            discardSkillCandidate(dataDir,
              decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
            return json(response, 200, { ok: true });
          }
        } catch (error) {
          if (error instanceof SkillLibraryError
              || error instanceof SkillDistillError) {
            return json(response, 400, { error: error.message });
          }
          if (error instanceof TaskControlError) {
            return json(response, 409, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知 Skill 资产接口" });
      }
      // Committer 的个人检视收件箱。名单只决定“还能不能被新邀请”，
      // 已经发给本人的邀请即使后来移出名单也仍应可见、可完成。
      if (parts[0] === "reviews") {
        if (!viewer) return json(response, 401, { error: "请先登录" });
        if (request.method === "GET" && parts[1] === "mine") {
          return json(response, 200, service.listReviewsFor(viewer.username));
        }
        if (request.method === "POST" && parts.length === 3
            && parts[2] === "complete") {
          try {
            return json(response, 200,
              service.completeReview(decodeURIComponent(parts[1]), viewer.username));
          } catch (error) {
            return json(response, 403, { error: String(error) });
          }
        }
        return json(response, 404, { error: "未知检视接口" });
      }
      // 静态前端(webRoot=React 构建产物):/ 与非 API 路径出文件;
      // /work/:taskId[/review/:reviewId] 是前端深链，文件系统里当然没有
      // 这个文件，必须回退 index.html 交给 React 解析。
      // 没配 webRoot 时零构建演示页兜底——两种形态永远有一个能用。
      if (request.method === "GET"
          && (url.pathname === "/" || parts[0] !== "tasks")) {
        const workspaceRoute = parts[0] === "work" && parts.length >= 2;
        const exactFile = options.webRoot
          ? staticFile(options.webRoot, url.pathname)
          : undefined;
        const file = exactFile ?? (options.webRoot && workspaceRoute
          ? staticFile(options.webRoot, "/") : undefined);
        if (file) {
          response.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
            // index.html 一个缓存头都不带时,浏览器可以按启发式规则自行
            // 缓存——包名带 hash 也救不了:入口页是旧的,它引的就永远是
            // 旧包。修了三轮图,人看到的可能一直是修之前那版。
            // 入口页每次回源,带 hash 的资产则可以长期缓存。
            "cache-control": file.endsWith(".html")
              ? "no-cache" : "public, max-age=31536000, immutable",
          });
          return response.end(readFileSync(file));
        }
        if (url.pathname === "/" || workspaceRoute) {
          response.writeHead(200,
            { "content-type": "text/html; charset=utf-8" });
          return response.end(WEB_PAGE);
        }
        return json(response, 404, { error: "未知路径" });
      }
      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = await readBody(request);
        const title = body.title === undefined
          ? undefined : String(body.title).trim() || undefined;
        const requirement = String(body.requirement ?? "").trim();
        if (!requirement) {
          return json(response, 400, { error: "requirement 不能为空" });
        }
        // 管理员不发起任务(用户 2026-08-19 拍板):管理平台与干活是两个
        // 角色——管理员配服务、建账号、兜底控制,任务由开发者自己发起、
        // 挂在自己名下。替人下单看似方便,实际是把"以谁的身份推代码/
        // 收通知"的归属搞混的入口(之前那套"管理员填账号替人下单"的
        // 逻辑连带它踩过的归属人为空的坑,一并退役)。
        if (viewer?.role === "admin") {
          return json(response, 403, {
            error: "管理员不发起任务——用开发者账号登录下单;"
              + "管理员负责配置平台、管理账号与兜底控制",
          });
        }
        // 任务归属人=登录者本人(不许替别人下单);无鉴权形态(本地
        // 单人/测试)沿用请求体里的账号。
        const account = viewer?.username
          ?? (body.account ? String(body.account) : undefined);
        const requirementDocumentName = body.requirement_document_name === undefined
          ? undefined : String(body.requirement_document_name);
        // 任务级可配(用户拍板):交付代码仓、交付方式(选项来自内核)、修复轮预算。
        const repo = body.repo === undefined ? undefined : String(body.repo);
        const repos = Array.isArray(body.repos)
          ? body.repos.map(String) : undefined;
        // 兼容旧前端：select 显示了默认项但可能提交空串。空白就是
        // “未指定”，交给 TaskService 采用内核默认交付方式。
        const lane = body.lane === undefined
          ? undefined : String(body.lane).trim() || undefined;
        const ticket = body.ticket === undefined
          ? undefined : String(body.ticket);
        const baseline = body.baseline === undefined
          ? undefined : String(body.baseline);
        const model = body.model
          ? {
              provider: String((body.model as { provider?: unknown })
                .provider ?? ""),
              model: String((body.model as { model?: unknown }).model ?? ""),
            }
          : undefined;
        const repairRounds = body.repair_rounds === undefined
          || body.repair_rounds === null || body.repair_rounds === ""
          ? undefined : Number(body.repair_rounds);
        const repositorySkillCatalogToken =
          body.repository_skill_catalog_token === undefined
            ? undefined : String(body.repository_skill_catalog_token);
        const selectedRepositorySkillIds =
          Array.isArray(body.selected_repository_skill_ids)
            ? body.selected_repository_skill_ids.map(String) : undefined;
        const selectedRepositoryKnowledgeIds =
          Array.isArray(body.selected_repository_knowledge_ids)
            ? body.selected_repository_knowledge_ids.map(String) : undefined;
        // 配置没配齐不给下单(用户拍板)。前端会把缺项摆在明面上,
        // 但拦必须在后端——绕过界面直接打接口的一样要被拦住,
        // 否则任务会带着缺失的令牌一路跑到推送/通知那步才炸。
        const blockers = [
          ...service.launchOptions().blockers,
          ...personalBlockers(viewer),
        ];
        if (blockers.length) {
          return json(response, 409, {
            error: "配置未完成,先补齐这些再下单:"
              + blockers.map((item) => item.label).join(";"),
            blockers,
          });
        }
        try {
          return json(response, 201, service.create(requirement,
            {
              title, account, repo, repos,
              requirementDocumentName,
              lane, ticket, baseline, model,
              repairRounds, repositorySkillCatalogToken,
              selectedRepositorySkillIds, selectedRepositoryKnowledgeIds,
            }));
        } catch (error) {
          return json(response, 400, { error: String(error) });
        }
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        return json(response, 200, service.list());
      }
      if (parts[0] === "tasks" && parts.length >= 2) {
        const id = parts[1];
        if (request.method !== "GET" && service.historyMutationInProgress(id)) {
          return json(response, 409, {
            error: `任务 ${id} 正在执行清空重跑或彻底删除，请勿同时修改`,
          });
        }
        if (request.method === "GET" && parts.length === 2) {
          const task = service.get(id);
          if (!task) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, task);
        }
        if (request.method === "DELETE" && parts.length === 2) {
          if (viewer?.role !== "admin") {
            return json(response, 403, { error: "只有管理员可以彻底删除历史任务" });
          }
          options.lubanApproval?.purgeTask(id);
          return json(response, 200, await service.hardDeleteHistory(id));
        }
        if (request.method === "POST" && parts[2] === "decision") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能处理分配给自己的任务" });
          }
          const body = await readBody(request);
          const task = await service.decide(id, {
            state_version: Number(body.state_version),
            selected_options: body.selected_options
              && typeof body.selected_options === "object"
              ? body.selected_options : undefined,
            free_responses: body.free_responses
              && typeof body.free_responses === "object"
              ? body.free_responses : undefined,
            comment: body.comment !== undefined
              ? String(body.comment) : undefined,
            decision: body.decision !== undefined
              ? String(body.decision) : undefined,
            answers: body.answers && typeof body.answers === "object"
              ? body.answers : undefined,
            notes: body.notes ? String(body.notes) : undefined,
            annotation_ids: Array.isArray(body.annotation_ids)
              ? body.annotation_ids.map(String) : undefined,
            repository_skill_catalog_token:
              body.repository_skill_catalog_token === undefined
                ? undefined : String(body.repository_skill_catalog_token),
            selected_repository_skill_ids:
              Array.isArray(body.selected_repository_skill_ids)
                ? body.selected_repository_skill_ids.map(String) : undefined,
            selected_repository_knowledge_ids:
              Array.isArray(body.selected_repository_knowledge_ids)
                ? body.selected_repository_knowledge_ids.map(String) : undefined,
            delivery_paths: Array.isArray(body.delivery_paths)
              ? body.delivery_paths.map(String) : undefined,
          });
          return json(response, 200, task);
        }
        if (request.method === "PUT" && parts[2] === "moonlight") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能调整分配给自己的任务" });
          }
          const body = await readBody(request);
          const mode = String(body.mode ?? "inherit");
          if (!(["inherit", "manual", "moonlight"] as string[]).includes(mode)) {
            return json(response, 400, { error: "任务审批方式无效" });
          }
          return json(response, 200, service.setTaskApprovalMode(
            id,
            mode as "inherit" | "manual" | "moonlight",
            body.include_current === true,
          ));
        }
        // push 前人工确认交付清单(任务级开关)。默认关;开着时宿主
        // 在推送前挂云端原生 diff 卡。
        if (request.method === "PUT" && parts[2] === "push-confirmation") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能调整分配给自己的任务" });
          }
          const body = await readBody(request);
          try {
            return json(response, 200,
              service.setPushConfirmation(id, body.on === true));
          } catch (error) {
            if (error instanceof TaskControlError) {
              return json(response, 409, { error: error.message });
            }
            throw error;
          }
        }
        // 多仓需求图的结构化确认:平台自己的按钮,不依赖模型把
        // 「确认并生成任务」的选项原文写对(魔法字符串漂了会静默丢单,
        // 车道双问同款教训)。幂等:已生成的仓不重复建。
        if (request.method === "POST" && parts[2] === "graph"
            && parts[3] === "confirm") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能处理分配给自己的任务" });
          }
          const body = await readBody(request);
          return json(response, 200, await service.confirmRequirementGraph(id, {
            catalog_token: body.repository_skill_catalog_token === undefined
              ? undefined : String(body.repository_skill_catalog_token),
            selected_ids: Array.isArray(body.selected_repository_skill_ids)
              ? body.selected_repository_skill_ids.map(String) : undefined,
            selected_knowledge_ids:
              Array.isArray(body.selected_repository_knowledge_ids)
                ? body.selected_repository_knowledge_ids.map(String) : undefined,
          }));
        }
        // Committer 检视必须由该单责任人主动发起。管理员只维护名单，
        // 即使拥有其他操作兜底权，也不能替开发点击邀请。
        if (request.method === "POST" && parts[2] === "review-request") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!viewer || viewer.username !== target.luban_account) {
            return json(response, 403,
              { error: "只有该任务责任人可以邀请 Committer 检视" });
          }
          const body = await readBody(request);
          const committer = String(body.committer ?? "").trim();
          const allowed = options.auth?.listUsers().some((user) =>
            user.username === committer && user.committer);
          if (!allowed) {
            return json(response, 400,
              { error: "请选择管理员配置的 Committer" });
          }
          return json(response, 200,
            await service.requestReview(id, viewer.username, committer));
        }
        if (request.method === "GET" && parts[2] === "reviews") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, service.listTaskReviews(id));
        }
        if (request.method === "GET" && parts[2] === "events") {
          return streamEvents(service, id, response);
        }
        // 推送前验证的实时事件流(用户点名:编译过程、执行命令必须
        // 看得见)。轮目录由服务端每拍重解析,换轮自动从头放新一轮。
        if (request.method === "GET" && parts[2] === "prepush"
            && parts[3] === "events") {
          return streamPrepushEvents(service, id, response);
        }
        // 环境预热编译的实时事件流(用户点名:预热进展必须清楚可见)。
        if (request.method === "GET" && parts[2] === "warmup"
            && parts[3] === "events") {
          return streamJsonlAsSse(service, id, response,
            () => service.warmupEventLogPath(id));
        }
        if (parts[2] === "developer-assistant") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (request.method === "GET") {
            return json(response, 200, service.developerAssistant(id));
          }
          if (request.method === "POST") {
            if (!canOperate(viewer, target.luban_account, !!options.auth)) {
              return json(response, 403,
                { error: "只能为分配给自己的任务使用开发助手" });
            }
            const body = await readBody(request);
            return json(response, 202, service.startDeveloperAssistant(
              id,
              String(body.text ?? ""),
              viewer?.username ?? "本地用户",
            ));
          }
        }
        // 发过的补充说明 + 送达与否:发出去没有回执等于对着空气说话。
        if (request.method === "GET" && parts[2] === "interrupts") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, service.listInterrupts(id));
        }
        // 检视批注:圈注权和送达权分开——谁都能圈(领导路过提一句是
        // 真实场景),送达只有该单负责人。这一刀下去,"多人并发提交"
        // 根本不会发生:提交的永远只有一个人。
        if (parts[2] === "annotations") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          const author = viewer?.username ?? "本地用户";
          if (request.method === "GET" && parts.length === 3) {
            return json(response, 200, await service.listAnnotationsAsync(id));
          }
          if (request.method === "POST" && parts.length === 3) {
            const body = await readBody(request);
            return json(response, 201, service.addAnnotation(id, {
              author,
              artifact: String(body.artifact ?? ""),
              file: String(body.file ?? ""),
              line: Number(body.line ?? 0),
              anchor: String(body.anchor ?? ""),
              note: String(body.note ?? ""),
              kind: body.kind === "code" ? "code" : "doc",
            }));
          }
          // 送达 = 在指挥这一单,权限同决定;圈注不需要这个门槛。
          if (request.method === "POST" && parts[3] === "send") {
            if (!canOperate(viewer, target.luban_account, !!options.auth)) {
              return json(response, 403, { error: "只能给分配给自己的任务送批注" });
            }
            const body = await readBody(request);
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
            return json(response, 200, await service.sendAnnotations(id, ids));
          }
          if (request.method === "GET" && parts[3] === "preview") {
            return json(response, 200,
              { text: service.previewAnnotations(id) });
          }
          // 批注归作者本人管理，与任务责任人 / Committer 身份无关。
          if (request.method === "PATCH" && parts.length === 4) {
            const body = await readBody(request);
            return json(response, 200,
              service.editAnnotation(id, decodeURIComponent(parts[3]),
                String(body.note ?? ""), author));
          }
          // 只能删自己写的:多人环境里替别人删等于替他改主意。
          if (request.method === "DELETE" && parts.length === 4) {
            return json(response, 200,
              service.dropAnnotation(id, decodeURIComponent(parts[3]), author));
          }
          // 检视闭环的裁决:确认通过 / 返工。作者校验在台账层——
          // 谁的意见谁裁决,替别人点"通过"等于替他签字。
          if (request.method === "POST" && parts.length === 5
              && parts[4] === "verify") {
            return json(response, 200,
              service.verifyAnnotation(id, decodeURIComponent(parts[3]), author));
          }
          if (request.method === "POST" && parts.length === 5
              && parts[4] === "reopen") {
            return json(response, 200, await service.reopenAnnotation(
              id, decodeURIComponent(parts[3]), author));
          }
        }
        // 跑动中插话(本地 CLI 的 ESC 等价物):发送即打断,模型把手头
        // 这一轮做完就收到。权限同决定——插话也是在指挥这一单,不是围观。
        if (request.method === "POST" && parts[2] === "interrupt") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能给分配给自己的任务插话" });
          }
          const body = await readBody(request);
          const task = await service.interrupt(id, String(body.text ?? ""));
          return json(response, 200, task);
        }
        if (request.method === "POST"
            && ["pause", "resume", "cancel"].includes(parts[2])) {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能控制分配给自己的任务" });
          }
          const actor = viewer?.username ?? "本地用户";
          if (parts[2] === "pause") {
            return json(response, 200, await service.pause(id, actor));
          }
          if (parts[2] === "resume") {
            return json(response, 200, service.resume(id, actor));
          }
          return json(response, 200, await service.cancel(id, actor));
        }
        // 重跑一单(run7 实测的运维刚需):环境故障被迫收口的任务,
        // 修好环境后续接内核当前步骤,不从头再来。终态校验在服务层。
        if (request.method === "POST" && parts[2] === "retry") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能重跑分配给自己的任务" });
          }
          return json(response, 200, service.retry(id));
        }
        // 推送前验证失败停机后,人可拍板跳过本地验证,直推流水线裁决。
        if (request.method === "POST" && parts[2] === "prepush"
            && parts[3] === "skip") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能操作分配给自己的任务" });
          }
          return json(response, 200,
            await service.skipPrePushVerification(id));
        }
        // 从头重跑会原位覆盖旧任务及其审计现场。管理员不替开发者发起
        // 或冒用其代码身份；鉴权部署下只能由任务本人执行。
        if (request.method === "POST" && parts[2] === "rerun") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (options.auth && (!viewer || viewer.role === "admin"
              || viewer.username !== target.luban_account)) {
            return json(response, 403, { error: "只有该任务责任人可以从头重跑" });
          }
          const blockers = [
            ...service.launchOptions().blockers,
            ...personalBlockers(viewer),
          ];
          if (blockers.length) {
            return json(response, 409, {
              error: "配置未完成,先补齐这些再从头重跑:"
                + blockers.map((item) => item.label).join(";"),
              blockers,
            });
          }
          options.lubanApproval?.purgeTask(id);
          return json(response, 200, await service.rerunFromStart(id));
        }
        // 行为摘要(只读):事件流折叠成人看得过来的分段与异常信号。
        // 权限口径同任务详情;纯展示,不参与任何判定。
        if (request.method === "GET" && parts[2] === "activity") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, service.activity(id));
        }
        // 交付时间线(只读):现场文件读成人话,权限口径同任务详情
        // ——能看任务就能看它经历了什么。纯展示,不参与判定。
        if (request.method === "GET" && parts[2] === "timeline") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          // 代码工作区经现成的公开方法反推:面板在 <cwd>/.mae-flow-work/
          // 之下,拿不到就交给 buildTimeline 自己在工作区里找。
          const panel = service.panelFile(id, "panel.html")
            ?? service.panelFile(id, "panel-pulse.js");
          const cwd = panel ? dirname(dirname(panel)) : undefined;
          return json(response, 200,
            buildTimeline(target.workspace, cwd));
        }
        // 检视产物(只读):决策与证据必须同屏——审批卡问"Spec 确认吗",
        // spec.md 就该在旁边,而不是让人跳到另一套界面里翻。权限口径
        // 同任务详情;能读哪些文件由 artifacts.ts 的白名单把守。
        if (request.method === "GET" && parts[2] === "artifacts") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          const panel = service.panelFile(id, "panel.html")
            ?? service.panelFile(id, "panel-pulse.js");
          const root = resolveArtifactRoot(
            target.workspace, panel ? dirname(dirname(panel)) : undefined);
          if (parts.length === 3) {
            // 没有现场时给空列表:流程还没走到 init 不是错误。
            return json(response, 200,
              root ? await listArtifactsAsync(root) : []);
          }
          // name 里带 `/`(单号目录/文件名):编码与未编码两种形态都收。
          const name = decodeURIComponent(parts.slice(3).join("/"));
          const artifact = root
            ? await readArtifactAsync(root, name) : undefined;
          if (!artifact) {
            return json(response, 404,
              { error: `没有可检视的产物「${name}」` });
          }
          return json(response, 200, artifact);
        }
        // 审计读侧(§11):外部动作台账来自 PG 投影。没配投影时
        // 明说,而不是空数组装作"没有动作"。
        if (request.method === "GET" && parts[2] === "actions") {
          const projection = service.options.projection;
          if (!projection) {
            return json(response, 404,
              { error: "未配置 PostgreSQL 投影(--pg),没有台账可查" });
          }
          return json(response, 200, await projection.listActions(id));
        }
        // 内核现场面板(铁原则:请用户检视的东西必须在面板可见)。
        // panel 是内核生成的单文件 HTML,pulse/stamp 是它的自动刷新
        // 探针(相对路径 script src),同前缀一起放行。
        if (request.method === "GET" && parts.length === 3
            && ["panel", "panel-pulse.js", "panel-stamp.js"]
              .includes(parts[2])) {
          const name = parts[2] === "panel" ? "panel.html" : parts[2];
          const file = service.panelFile(id, name);
          if (!file) {
            return json(response, 404, {
              error: "这个任务还没有现场面板(流程未初始化或演练模式)",
            });
          }
          response.writeHead(200, {
            "content-type": name.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/html; charset=utf-8",
          });
          return response.end(readFileSync(file));
        }
      }
      return json(response, 404, { error: "未知路径" });
    } catch (error) {
      if (error instanceof StateConflictError) {
        // 先到决定生效:后到的提交必须知道自己没生效,不能静默吞掉。
        return json(response, 409, { error: `任务状态已变化: ${error.message}` });
      }
      if (error instanceof TaskControlError) {
        return json(response, 409, { error: error.message });
      }
      if (error instanceof NotFoundError) {
        return json(response, 404, { error: error.message });
      }
      if (error instanceof AnnotationPermissionError) {
        return json(response, 403, { error: error.message });
      }
      if (error instanceof AnnotationError) {
        return json(response, 400, { error: error.message });
      }
      return json(response, 500, { error: String(error) });
    }
  });
}

function canOperate(
  viewer: AuthUser | undefined,
  taskAccount: string | undefined,
  authEnabled: boolean,
): boolean {
  if (!authEnabled) return true;
  return viewer?.role === "admin"
    || (!!viewer && !!taskAccount && viewer.username === taskAccount);
}

function sessionCookie(
  token: string,
  request: import("node:http").IncomingMessage,
  expired = false,
): string {
  const secure = request.headers["x-forwarded-proto"] === "https"
    ? "; Secure"
    : "";
  const age = expired ? 0 : 8 * 60 * 60;
  return `mae_flow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; `
    + `SameSite=Strict; Max-Age=${age}${secure}`;
}

/** webRoot 内定位静态文件:/ → index.html。resolve 后必须仍在
 * webRoot 里——路径穿越不是 404 的一种,是攻击,直接不认。 */
function staticFile(
  webRoot: string,
  pathname: string,
): string | undefined {
  const root = resolve(webRoot);
  const target = resolve(
    join(root, pathname === "/" ? "index.html" : pathname));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return existsSync(target) && statSync(target).isFile()
    ? target
    : undefined;
}

/** SSE:先重放事件日志,再轮询追加行;客户端断开即停。
 *
 * 增量读:按字节偏移只取新增部分——整文件重读在长日志下是
 * O(n²) 读放大(run7 现场几百 KB,每 300ms 全量读一遍)。
 * 事件行必须完整推送:尾部没换行的半行(写入方还在写)连同
 * 可能被读界切开的 UTF-8 多字节字符一起留在 carry(按字节存,
 * 提前解码就是乱码),凑齐换行才出手。 */
function streamEvents(
  service: TaskService,
  id: string,
  response: import("node:http").ServerResponse,
): void {
  streamJsonlAsSse(service, id, response, () => service.eventLogPath(id));
}

/** 推送前验证事件流:路径每拍重解析——修复轮产生新 HEAD 会开新一轮
 * 目录,路径一变就从头放新一轮,客户端不用自己发现换轮。 */
function streamPrepushEvents(
  service: TaskService,
  id: string,
  response: import("node:http").ServerResponse,
): void {
  streamJsonlAsSse(service, id, response,
    () => service.prePushEventLogPath(id));
}

function streamJsonlAsSse(
  service: TaskService,
  id: string,
  response: import("node:http").ServerResponse,
  resolvePath: () => string | undefined,
): void {
  if (!service.get(id)) {
    return json(response, 404, { error: `任务 ${id} 不存在` });
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  let activePath: string | undefined;
  let offset = 0;
  let carry = Buffer.alloc(0);
  let closed = false;
  response.on("close", () => (closed = true));
  const push = () => {
    if (closed) return;
    const path = resolvePath();
    if (path !== activePath) {
      // 换文件(prepush 换轮)= 新的一份日志,从头放;半行缓存作废。
      activePath = path;
      offset = 0;
      carry = Buffer.alloc(0);
    }
    if (path && existsSync(path) && statSync(path).size > offset) {
      const fd = openSync(path, "r");
      let read = 0;
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(statSync(path).size - offset);
        read = readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      offset += read;
      carry = Buffer.concat([carry, chunk.subarray(0, read)]);
      const cut = carry.lastIndexOf(0x0a);
      if (cut >= 0) {
        const complete = carry.subarray(0, cut).toString("utf-8");
        carry = Buffer.from(carry.subarray(cut + 1));
        for (const line of complete.split("\n")) {
          if (line.trim()) response.write(`data: ${line}\n\n`);
        }
      }
    }
    const status = service.get(id)?.status;
    if (status === "completed" || status === "failed" || status === "canceled") {
      response.end();
      return;
    }
    setTimeout(push, 300);
  };
  push();
}
