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
}

interface StoredUser extends AuthUser {
  password_hash: string;
  created_at: string;
  disabled: boolean;
  /** 个人 Git 平台令牌(PAT)。密码是哈希,这个必须明文存——git 要用
   * 原文;所以只许住在 0600 的本文件里,永不进公开视图/日志/URL。 */
  git_token?: string;
  /** 平台侧的 git 用户名,PAT 的搭档;不填默认用登录账号名。 */
  git_username?: string;
}

interface UserFile {
  version: 1;
  users: StoredUser[];
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

  /** 设置/更换/删除个人 Git 令牌。只写不读:调用方拿不回明文,
   * 想看只有掩码(gitTokenHint)。空串=删除。 */
  setGitToken(
    username: string,
    token: string,
    gitUsername?: string,
  ): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const trimmed = token.trim();
    if (!trimmed) {
      delete stored.git_token;
      delete stored.git_username;
    } else {
      if (Buffer.byteLength(trimmed, "utf-8") > 512) {
        throw new Error("令牌过长");
      }
      stored.git_token = trimmed;
      const name = (gitUsername ?? "").trim();
      if (name) stored.git_username = name;
      else delete stored.git_username;
    }
    this.persist();
  }

  /** 掩码提示(••••末4位),给界面确认"配过了、是哪个"用。 */
  gitTokenHint(username: string): string | undefined {
    const token = this.users.get(username)?.git_token;
    if (!token) return undefined;
    return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
  }

  /** 消费口(唯一允许碰明文的出口):任务启动时注入 credential
   * helper 用。git 用户名没配就用登录账号名。 */
  gitCredential(
    username: string | undefined,
  ): { username: string; password: string } | undefined {
    if (!username) return undefined;
    const stored = this.users.get(username);
    if (!stored?.git_token || stored.disabled) return undefined;
    return {
      username: stored.git_username ?? stored.username,
      password: stored.git_token,
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
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    const body: UserFile = { version: 1, users: [...this.users.values()] };
    writeFileSync(temp, JSON.stringify(body, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}

function publicUser(user: StoredUser): AuthUser {
  return { username: user.username, role: user.role };
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
