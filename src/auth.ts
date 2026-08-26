/**
 * 本地账号与会话。
 *
 * 用户文件只保存 scrypt 加盐哈希，权限 0600；会话仅驻内存，
 * 服务重启即失效。认证只负责"谁在操作"，任务事实仍归 TaskService。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export type UserRole = "admin" | "developer";

export interface AuthUser {
  username: string;
  role: UserRole;
  /** 可被任务责任人主动邀请检视。它是能力标记，不是第三种角色。 */
  committer?: boolean;
}

/** 登录后交给界面的本人视图。密钥原文永不离开服务端，只暴露能让
 * 用户确认“已经配置、末四位是什么”的掩码。 */
export interface AuthSessionUser extends AuthUser {
  git_token_hint?: string;
  git_email?: string;
  luban_token_hint?: string;
  moonlight: boolean;
  push_confirmation: boolean;
}

interface StoredUser extends AuthUser {
  password_hash: string;
  created_at: string;
  disabled: boolean;
  /** 个人 Git 平台令牌(PAT)。密码是哈希,这个必须明文存——git 要用
   * 原文;所以只许住在 0600 的本文件里,永不进公开视图/日志/URL。 */
  git_token?: string;
  /** 个人通知令牌(小鲁班):该接口以令牌对应的人的身份发消息,
   * 所以按人存,不是服务级配一个。 */
  luban_token?: string;
  /** 平台侧的 git 用户名,PAT 的搭档;不填默认用登录账号名。 */
  git_username?: string;
  /** 平台邮箱:commit 署名用。平台(CodeHub,类比 GitHub)判定
   * "这个 commit 是谁的"按 commit email 映射账号——令牌只管推送
   * 鉴权,署名归这里。不是密钥,可以回显。 */
  git_email?: string;
  /** 月光模式(免审批):开着时本人任务的人工节点由系统代答放行,
   * 事后复盘。随时可开可关,是持续状态不是下单时的一次性选择。 */
  moonlight?: boolean;
  /** push 前人工确认(交付清单过目):与 moonlight 合成"人工介入
   * 程度"的两个正交轴——月光管过程节点停不停,这个管交付内容出门
   * 前给不给人看。个人级默认、**缺省即开**(用户 2026-08-26 拍板:
   * 默认开启、不做任务粒度),所以只落盘显式的 false。 */
  push_confirmation?: boolean;
}

interface UserFile {
  version: 1;
  users: StoredUser[];
  /** 已删除账号永久占用用户名，避免后来同名账号继承旧任务操作权。 */
  retired_usernames?: string[];
}

interface FailureWindow {
  attempts: number;
  startedAt: number;
}

const USERNAME = /^[A-Za-z0-9._-]{2,48}$/;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export class LocalAuth {
  private users = new Map<string, StoredUser>();
  private retiredUsernames = new Set<string>();
  private sessions = new Map<string, { username: string; expiresAt: number }>();
  private failures = new Map<string, FailureWindow>();

  constructor(
    readonly file: string,
    private readonly sessionTtlMs = 8 * 60 * 60_000,
  ) {
    this.load();
  }

  hasUsers(): boolean {
    return this.users.size > 0;
  }

  bootstrapAdmin(username: string, password: string): AuthUser {
    if (this.hasUsers()) {
      const existing = this.users.get(username);
      if (!existing) {
        throw new Error("账号库已存在，但引导管理员账号不在其中");
      }
      return publicUser(existing);
    }
    return this.createUser(username, password, "admin");
  }

  listUsers(): AuthUser[] {
    return [...this.users.values()]
      .map(publicUser)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  createUser(
    username: string,
    password: string,
    role: UserRole,
  ): AuthUser {
    const normalized = username.trim();
    validateCredentials(normalized, password);
    if (role !== "admin" && role !== "developer") {
      throw new Error("role 只能是 admin 或 developer");
    }
    if (this.users.has(normalized)) {
      throw new Error(`账号 ${normalized} 已存在`);
    }
    if (this.retiredUsernames.has(normalized)) {
      throw new Error(`账号 ${normalized} 已删除，不能同名重建；历史任务仍归原账号`);
    }
    const user: StoredUser = {
      username: normalized,
      role,
      password_hash: hashPassword(password),
      created_at: new Date().toISOString(),
      disabled: false,
    };
    this.users.set(normalized, user);
    this.persist();
    return publicUser(user);
  }

  /** 管理员删账号。内部平台的口径:人走了账号就清,不搞停用/归档两套
   * 状态。两条底线仍要守——不许删自己(正在用的会话把自己删了,页面
   * 立刻变砖,误触无法挽回),不许删掉最后一个管理员(没人能再进管理
   * 页,只能上服务器改文件)。历史任务不受影响:任务台账记的是账号名
   * 字符串,人没了名字还在,凭据消费口查不到人自然返回空(fail-open)。 */
  deleteUser(username: string, operator: string): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (username === operator) {
      throw new Error("不能删除自己——请让另一位管理员操作");
    }
    if (stored.role === "admin"
        && [...this.users.values()]
          .filter((user) => user.role === "admin" && !user.disabled)
          .length <= 1) {
      throw new Error("这是最后一个管理员账号,删掉就没人能管理平台了");
    }
    this.users.delete(username);
    // 任务归属当前以用户名作为稳定身份。若允许同名重建，新用户会立刻
    // 获得旧用户历史任务的决定/暂停/取消权，因此删除名必须永久保留。
    this.retiredUsernames.add(username);
    // 他手里的活会话一并作废:账号都没了,令牌不该再能用。
    for (const [token, session] of this.sessions) {
      if (session.username === username) this.sessions.delete(token);
    }
    this.persist();
  }

  /** 管理员直接改密码,不验旧密码(内部平台,用户拍板:忘了密码找管理
   * 员重置,不搞自助找回那套)。新密码仍走同一套长度校验;改完把这个
   * 人的活会话全部作废——旧会话若还能用,"重置"就只是半截。 */
  resetPassword(username: string, password: string): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    validateCredentials(stored.username, password);
    stored.password_hash = hashPassword(password);
    for (const [token, session] of this.sessions) {
      if (session.username === username) this.sessions.delete(token);
    }
    this.persist();
  }

  authenticate(
    username: string,
    password: string,
    source: string,
  ): { user?: AuthUser; blockedForMs?: number } {
    const normalized = username.trim();
    const key = `${source}:${normalized}`;
    const now = Date.now();
    const failure = this.failures.get(key);
    if (failure && now - failure.startedAt < FAILURE_WINDOW_MS
        && failure.attempts >= MAX_FAILURES) {
      return {
        blockedForMs: FAILURE_WINDOW_MS - (now - failure.startedAt),
      };
    }
    if (failure && now - failure.startedAt >= FAILURE_WINDOW_MS) {
      this.failures.delete(key);
    }

    const stored = this.users.get(normalized);
    if (!stored || stored.disabled
        || !verifyPassword(password, stored.password_hash)) {
      const current = this.failures.get(key);
      this.failures.set(key, current
        ? { ...current, attempts: current.attempts + 1 }
        : { attempts: 1, startedAt: now });
      return {};
    }
    this.failures.delete(key);
    return { user: publicUser(stored) };
  }

  /** 设置/更换/删除个人 Git 令牌 + 署名邮箱。只写不读:调用方拿不回
   * 明文,想看只有掩码(gitTokenHint)。空令牌=删除(连邮箱一起清)。
   *
   * **邮箱必填**(用户 2026-08-19 拍板):commit 署名要它,内网平台还
   * 按邮箱对人——没有它推上去的提交是无主的。**用户名不另配**:git
   * 用户名就是登录账号名(同一次拍板)——账号由管理员按平台用户名建,
   * 再开一个"平台用户名"字段只会造出两个可以互相不一致的真相。 */
  setGitToken(
    username: string,
    token: string,
    gitEmail?: string,
  ): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const trimmed = token.trim();
    if (!trimmed) {
      delete stored.git_token;
      delete stored.git_username;
      delete stored.git_email;
    } else {
      if (Buffer.byteLength(trimmed, "utf-8") > 512) {
        throw new Error("令牌过长");
      }
      const email = (gitEmail ?? "").trim();
      if (!email) {
        throw new Error("平台邮箱必填:commit 署名与平台对人都要它");
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(`平台邮箱格式不对: ${email}`);
      }
      stored.git_token = trimmed;
      // 旧版遗留的独立 git_username 顺手清掉:用户名以账号名为准。
      delete stored.git_username;
      stored.git_email = email;
    }
    this.persist();
  }

  /** 掩码提示(••••末4位),给界面确认"配过了、是哪个"用。 */
  gitTokenHint(username: string): string | undefined {
    return maskToken(this.users.get(username)?.git_token);
  }

  /** 设置/删除个人通知令牌(小鲁班)。与 Git 令牌同样是"只写不读"。
   *
   * 为什么按人存而不是全服务配一个:那个接口是**以令牌对应的人的
   * 身份发消息**——用服务号统一发,所有人收到的都是同一个机器人;
   * 每人配自己的,普通提醒可自己发给自己,也能主动发给检视人,
   * 不需要额外申请机器人账号
   * (用户 2026-08-18 拍板)。空串=删除。 */
  setLubanToken(username: string, token: string): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const trimmed = token.trim();
    if (!trimmed) {
      delete stored.luban_token;
    } else {
      if (Buffer.byteLength(trimmed, "utf-8") > 512) {
        throw new Error("令牌过长");
      }
      stored.luban_token = trimmed;
    }
    this.persist();
  }

  lubanTokenHint(username: string): string | undefined {
    return maskToken(this.users.get(username)?.luban_token);
  }

  /** 消费口(唯一碰明文的出口):投递通知时按发起人取发送令牌。
   * 停用账号不给——离职/停权的人不该继续以他的身份发消息。 */
  lubanToken(username: string | undefined): string | undefined {
    if (!username) return undefined;
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return undefined;
    return stored.luban_token;
  }

  /** 月光模式开关。开=本人任务免审批(系统代答),关=恢复人工闸。 */
  setMoonlight(username: string, on: boolean): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on) stored.moonlight = true;
    else delete stored.moonlight;
    this.persist();
  }

  /** 管理员维护 Committer 名单；权限校验由 HTTP 边界负责。 */
  setCommitter(username: string, on: boolean): AuthUser {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on) stored.committer = true;
    else delete stored.committer;
    this.persist();
    return publicUser(stored);
  }

  moonlightEnabled(username: string | undefined): boolean {
    if (!username) return false;
    const stored = this.users.get(username);
    return !!stored?.moonlight && !stored.disabled;
  }

  /** push 前人工确认默认值(缺省即开,只落盘显式的关)。改动即时
   * 生效于本人后续到达推送点的任务;已经在等确认的卡不撤——那张卡
   * 是按当时的意愿举的,点一下"确认按清单推送"就走,不存在悬死。 */
  setPushConfirmation(username: string, on: boolean): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on) delete stored.push_confirmation;
    else stored.push_confirmation = false;
    this.persist();
  }

  /** 无账号(未接登录的部署、probe/pilot 演练链)不默认举卡——
   * 那些链路没有"人"在场,默认开只会卡死自动化;默认开只对真人。 */
  pushConfirmationEnabled(username: string | undefined): boolean {
    if (!username) return false;
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return false;
    return stored.push_confirmation !== false;
  }

  /** 登录与 /auth/me 共用同一份本人视图，避免登录响应漏字段后让前端
   * 误以为个人配置丢失。只按传入账号读取，不接受客户端指定目标用户。 */
  sessionView(username: string): AuthSessionUser | undefined {
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return undefined;
    return {
      ...publicUser(stored),
      ...this.gitProfile(username),
      luban_token_hint: this.lubanTokenHint(username),
      moonlight: this.moonlightEnabled(username),
      push_confirmation: this.pushConfirmationEnabled(username),
    };
  }

  /** 给界面回显的非密部分:掩码提示 + 平台用户名/邮箱。 */
  gitProfile(username: string): {
    git_token_hint?: string;
    git_email?: string;
  } {
    const stored = this.users.get(username);
    if (!stored?.git_token) return {};
    return {
      git_token_hint: this.gitTokenHint(username),
      git_email: stored.git_email,
    };
  }

  /** 消费口(唯一允许碰明文的出口):任务启动时注入 credential
   * helper 与 commit 署名用。git 用户名没配就用登录账号名。 */
  gitCredential(
    username: string | undefined,
  ): { username: string; password: string; email?: string } | undefined {
    if (!username) return undefined;
    const stored = this.users.get(username);
    if (!stored?.git_token || stored.disabled) return undefined;
    return {
      // 用户名=账号名(用户拍板):账号由管理员按平台用户名建,不留
      // 第二个可以与之不一致的字段。旧数据里的 git_username 不再读。
      username: stored.username,
      password: stored.git_token,
      email: stored.git_email,
    };
  }

  createSession(user: AuthUser): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      username: user.username,
      expiresAt: Date.now() + this.sessionTtlMs,
    });
    return token;
  }

  sessionUser(token: string | undefined): AuthUser | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    const user = this.users.get(session.username);
    return user && !user.disabled ? publicUser(user) : undefined;
  }

  endSession(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as UserFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.users)) {
      throw new Error(`账号文件格式不受支持: ${this.file}`);
    }
    for (const user of parsed.users) this.users.set(user.username, user);
    for (const username of parsed.retired_usernames ?? []) {
      if (typeof username === "string") this.retiredUsernames.add(username);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    const body: UserFile = {
      version: 1,
      users: [...this.users.values()],
      ...(this.retiredUsernames.size
        ? { retired_usernames: [...this.retiredUsernames].sort() } : {}),
    };
    writeFileSync(temp, JSON.stringify(body, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}

/** 掩码:••••末4位。密钥一律只写不读,界面只用它确认"配过了、是哪个"。 */
function maskToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

function publicUser(user: StoredUser): AuthUser {
  return {
    username: user.username,
    role: user.role,
    ...(user.committer ? { committer: true } : {}),
  };
}

function validateCredentials(username: string, password: string): void {
  if (!USERNAME.test(username)) {
    throw new Error("账号需为 2–48 位字母、数字、点、下划线或短横线");
  }
  if (password.length < 10) {
    throw new Error("密码至少需要 10 个字符");
  }
  if (Buffer.byteLength(password, "utf-8") > 256) {
    throw new Error("密码过长");
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${digest.toString("base64")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, saltText, digestText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText) return false;
  try {
    const expected = Buffer.from(digestText, "base64");
    const actual = scryptSync(password, Buffer.from(saltText, "base64"), 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function cookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
