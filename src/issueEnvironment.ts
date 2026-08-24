/**
 * DTS 问题单的环境接缝。
 *
 * 第一版只负责两件事：
 * 1. 把任务级 SSH 凭据放进宿主专用加密文件，任务/模型/API 只看引用；
 * 2. 定义日志、换库、回滚三项适配能力，内网实现无需侵入 TaskService。
 */

import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";

export type IssueEnvironmentPurpose = "logs" | "deploy" | "both";

export interface IssueEnvironmentInput {
  name: string;
  purpose: IssueEnvironmentPurpose;
  host: string;
  port?: number;
  username: string;
  password: string;
}

/** 可安全进入 task.json/API/模型提示的环境信息。 */
export interface IssueEnvironmentRef {
  id: string;
  name: string;
  purpose: IssueEnvironmentPurpose;
  protocol: "ssh";
  host: string;
  port: number;
  username: string;
  credential_state: "stored";
}

export interface IssueEnvironmentCredential {
  username: string;
  password: string;
}

export interface IssueEnvironmentAdapterRequest {
  task_id: string;
  ticket: string;
  requirement: string;
  environment: IssueEnvironmentRef;
  credential: IssueEnvironmentCredential;
  signal: AbortSignal;
}

export interface IssueLogResult {
  content: string;
  source?: string;
  collected_at?: string;
}

export interface IssueDeploymentReceipt {
  receipt_id: string;
  environment_id: string;
  status: "deployed" | "rolled_back";
  at: string;
  summary?: string;
}

/**
 * 内网只需实现这个接口。Cloud 不知道 ssh/scp/专有换库命令的细节，
 * Agent 也永远拿不到 password；适配器输出才会作为普通现场材料入仓。
 */
export interface IssueEnvironmentAdapter {
  fetchLogs?(request: IssueEnvironmentAdapterRequest): Promise<IssueLogResult>;
  deployCandidate?(request: IssueEnvironmentAdapterRequest & {
    repository: string;
    sha: string;
  }): Promise<IssueDeploymentReceipt>;
  rollback?(request: IssueEnvironmentAdapterRequest & {
    deployment: IssueDeploymentReceipt;
  }): Promise<IssueDeploymentReceipt>;
}

interface StoredIssueEnvironment extends IssueEnvironmentRef {
  password: string;
}

interface Envelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

const MAX_ENVIRONMENTS = 8;
const KEY_BYTES = 32;

function requiredText(
  value: unknown,
  label: string,
  max: number,
): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  if (/\0|[\r\n]/.test(text)) throw new Error(`${label}不能含控制字符`);
  return text;
}

function normalize(
  inputs: IssueEnvironmentInput[],
): StoredIssueEnvironment[] {
  if (inputs.length > MAX_ENVIRONMENTS) {
    throw new Error(`每个问题单最多配置 ${MAX_ENVIRONMENTS} 组环境`);
  }
  return inputs.map((input, index) => {
    const purpose = input.purpose;
    if (!(["logs", "deploy", "both"] as const).includes(purpose)) {
      throw new Error(`第 ${index + 1} 组环境用途不合法`);
    }
    const port = input.port === undefined || input.port === null
      ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`第 ${index + 1} 组环境端口必须是 1-65535`);
    }
    const host = requiredText(input.host, `第 ${index + 1} 组环境地址`, 255);
    if (/\s/.test(host) || host.startsWith("-")) {
      throw new Error(`第 ${index + 1} 组环境地址格式不合法`);
    }
    return {
      id: randomUUID(),
      name: requiredText(input.name, `第 ${index + 1} 组环境名称`, 80),
      purpose,
      protocol: "ssh",
      host,
      port,
      username: requiredText(
        input.username, `第 ${index + 1} 组环境用户名`, 128),
      password: requiredText(
        input.password, `第 ${index + 1} 组环境密码`, 4096),
      credential_state: "stored",
    };
  });
}

function publicRef(item: StoredIssueEnvironment): IssueEnvironmentRef {
  const { password: _password, ...safe } = item;
  return safe;
}

/**
 * 这不是外部密钥管理系统的替代品；它解决的是更现实的第一道边界：
 * 密码不能明文混进 task.json、事件、API 或 Agent 上下文。key 与密文
 * 均为宿主 0600，未来接 Vault/KMS 时只需替换本类。
 */
export class IssueEnvironmentVault {
  private readonly root: string;
  private readonly keyPath: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, ".issue-environments");
    this.keyPath = join(this.root, "key.bin");
  }

  store(
    taskId: string,
    inputs: IssueEnvironmentInput[],
  ): IssueEnvironmentRef[] {
    this.validTaskId(taskId);
    const rows = normalize(inputs);
    if (!rows.length) {
      this.remove(taskId);
      return [];
    }
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(rows), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    this.atomicWrite(this.taskPath(taskId), JSON.stringify(envelope));
    return rows.map(publicRef);
  }

  credential(
    taskId: string,
    environmentId: string,
  ): IssueEnvironmentCredential | undefined {
    const row = this.read(taskId).find((item) => item.id === environmentId);
    return row ? { username: row.username, password: row.password } : undefined;
  }

  remove(taskId: string): void {
    this.validTaskId(taskId);
    rmSync(this.taskPath(taskId), { force: true });
  }

  private read(taskId: string): StoredIssueEnvironment[] {
    this.validTaskId(taskId);
    const path = this.taskPath(taskId);
    if (!existsSync(path)) return [];
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("问题单环境凭据文件不能是符号链接");
    }
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Envelope;
    if (envelope.version !== 1) throw new Error("不支持的问题单环境凭据版本");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as StoredIssueEnvironment[];
  }

  private key(): Buffer {
    this.ensureRoot();
    if (!existsSync(this.keyPath)) {
      let descriptor: number | undefined;
      try {
        // 密钥不能走“临时文件 + rename 覆盖”：同一 dataDir 若意外有
        // 两个进程同时首启，后 rename 的进程会把先写入的 key 换掉，
        // 已经用旧 key 加密的任务凭据从此不可恢复。O_EXCL 让第一位
        // 创建者胜出，其余进程只读取既有 key。
        descriptor = openSync(
          this.keyPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
            | constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(descriptor, randomBytes(KEY_BYTES));
        closeSync(descriptor);
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (lstatSync(this.keyPath).isSymbolicLink()) {
      throw new Error("问题单环境密钥文件不能是符号链接");
    }
    chmodSync(this.keyPath, 0o600);
    const key = readFileSync(this.keyPath);
    if (key.length !== KEY_BYTES) throw new Error("问题单环境密钥长度不正确");
    return key;
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) {
      throw new Error("问题单环境凭据目录不能是符号链接");
    }
    chmodSync(this.root, 0o700);
  }

  private atomicWrite(path: string, content: string | Buffer): void {
    this.ensureRoot();
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, content);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private taskPath(taskId: string): string {
    return join(this.root, `${taskId}.json`);
  }

  private validTaskId(taskId: string): void {
    if (!/^task-\d+$/.test(taskId)) throw new Error("任务编号格式不合法");
  }
}
