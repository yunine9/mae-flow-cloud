/** Trusted Cloud adapter for Mae-Flow's continuous-review delivery commands. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify as verifySignature,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createSafeGitView } from "./safeGit.ts";

export interface KernelDeliveryHost {
  kernelRoot: string;
  python?: string;
}

export interface KernelFeedbackItem {
  id: string;
  source: string;
  source_id: string;
  source_revision: number;
  kind: string;
  summary: string;
  material?: string;
  verification: string;
  file?: string;
  line?: number;
}

export interface KernelFeedbackBatch {
  schema: "mae-flow-feedback-batch/1";
  batch_id: string;
  task_id: string;
  base_sha: string;
  opened_at: string;
  items: KernelFeedbackItem[];
}

export interface KernelDeliveryRecord {
  schema: "mae-flow-delivery-loop/1";
  idempotent: boolean;
  current?: string;
  batch_id?: string;
  migration_id?: string;
  status?: string;
  event_id?: string;
  sha?: string;
  local_head?: string;
  unpushed_local_commits?: string[];
  unpushed_local_paths?: string[];
}

export interface KernelFeedbackResultItem {
  id: string;
  status: "fixed" | "explained" | "needs_human" | "not_applicable";
  summary: string;
  evidence?: string;
}

export class KernelDeliveryError extends Error {}

export interface KernelHostAuthority {
  schema: "mae-flow-host-authority/1";
  alg: "RS256";
  key_id: string;
  task_id: string;
  n: string;
  e: string;
}

interface StoredKernelHostCapability {
  schema: "mae-flow-host-capability/1";
  authority: KernelHostAuthority;
  private_key: string;
}

interface StoredKernelHostBinding {
  schema: "mae-flow-host-binding/1";
  task_id: string;
  workspace: string;
  cwd: string;
  continuous_review: true;
}

export type KernelHostAction = "feedback-open" | "feedback-result" | "close"
  | "pipeline-record" | "intervention-reconcile";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function capabilityRoot(workspace: string): string {
  const realWorkspace = realpathSync(workspace);
  const root = join(dirname(realWorkspace), ".host-capabilities");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()
      || realpathSync(root) !== root) {
    throw new KernelDeliveryError("持续检视宿主信任根不是可信普通目录");
  }
  if ((info.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new KernelDeliveryError("持续检视宿主信任根权限或属主异常");
  }
  return root;
}

function capabilityPath(workspace: string, taskId: string): string {
  const safeTask = createHash("sha256").update(taskId).digest("hex");
  return join(capabilityRoot(workspace), `${safeTask}.json`);
}

function bindingPath(workspace: string, cwd: string): string {
  const realCwd = realpathSync(cwd);
  const safeCwd = createHash("sha256").update(realCwd).digest("hex");
  return join(capabilityRoot(workspace), `binding-${safeCwd}.json`);
}

function ensureKernelHostBinding(input: {
  workspace: string;
  cwd: string;
  taskId: string;
}): void {
  const binding: StoredKernelHostBinding = {
    schema: "mae-flow-host-binding/1",
    task_id: input.taskId,
    workspace: realpathSync(input.workspace),
    cwd: realpathSync(input.cwd),
    continuous_review: true,
  };
  const path = bindingPath(input.workspace, input.cwd);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()
        || realpathSync(path) !== path || (info.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new KernelDeliveryError("持续检视宿主任务绑定不是可信普通文件");
    }
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(path, "utf-8")); } catch { /* below */ }
    if (canonical(stored) !== canonical(binding)) {
      throw new KernelDeliveryError("持续检视宿主任务绑定与当前工作区不一致");
    }
    return;
  }
  writeFileSync(path, JSON.stringify(binding) + "\n", {
    encoding: "utf-8", mode: 0o600, flag: "wx",
  });
}

/**
 * Agent 工作区里的 execution_contract 只能用于展示，不能决定是否启用
 * Cloud 宿主保护。能力文件位于任务目录之外；只要它存在，这张任务就
 * 必须继续按持续检视契约 fail-closed，哪怕状态文件被删字段或改成
 * false。文件损坏会在后续验签时报错，绝不能被当成“旧任务”降级。
 */
export function kernelHostCapabilityPresent(input: {
  workspace: string;
  taskId: string;
  cwd: string;
}): boolean {
  const paths = [
    capabilityPath(input.workspace, input.taskId),
    bindingPath(input.workspace, input.cwd),
  ];
  try {
    paths.forEach((path) => lstatSync(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateStoredCapability(
  stored: StoredKernelHostCapability,
  taskId: string,
): void {
  const authority = stored.authority;
  if (stored.schema !== "mae-flow-host-capability/1"
      || authority?.schema !== "mae-flow-host-authority/1"
      || authority.alg !== "RS256"
      || authority.task_id !== taskId
      || !stored.private_key) {
    throw new KernelDeliveryError("持续检视宿主凭据损坏，拒绝执行内核命令");
  }
  const modulus = Buffer.from(authority.n, "base64url");
  const exponent = Buffer.from(authority.e, "base64url");
  const exponentValue = exponent.reduce((value, byte) => value * 256 + byte, 0);
  const keyId = createHash("sha256").update(`${authority.n}.${authority.e}`)
    .digest("hex").slice(0, 24);
  let derived: { n?: string; e?: string };
  try {
    derived = createPublicKey(createPrivateKey(stored.private_key))
      .export({ format: "jwk" });
  } catch {
    throw new KernelDeliveryError("持续检视宿主私钥无法解析，拒绝执行内核命令");
  }
  if (modulus.length < 256 || exponentValue !== 65537
      || authority.key_id !== keyId
      || derived.n !== authority.n || derived.e !== authority.e) {
    throw new KernelDeliveryError("持续检视宿主公私钥不匹配或强度不足");
  }
}

/**
 * The private signing key lives beside task workspaces, never inside the
 * Agent-visible workspace.  The public half is pinned into the kernel state.
 */
export function ensureKernelHostCapability(input: {
  workspace: string;
  taskId: string;
  cwd?: string;
}): KernelHostAuthority {
  const path = capabilityPath(input.workspace, input.taskId);
  if (input.cwd) ensureKernelHostBinding({ ...input, cwd: input.cwd });
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()
        || realpathSync(path) !== path
        || (info.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new KernelDeliveryError("持续检视宿主凭据不是普通文件，拒绝读取");
    }
    let stored: StoredKernelHostCapability;
    try {
      stored = JSON.parse(readFileSync(path, "utf-8")) as
        StoredKernelHostCapability;
    } catch {
      throw new KernelDeliveryError("持续检视宿主凭据损坏，拒绝执行内核命令");
    }
    validateStoredCapability(stored, input.taskId);
    return stored.authority;
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) {
    throw new KernelDeliveryError("无法生成持续检视宿主公钥");
  }
  const authority: KernelHostAuthority = {
    schema: "mae-flow-host-authority/1",
    alg: "RS256",
    key_id: createHash("sha256").update(`${jwk.n}.${jwk.e}`)
      .digest("hex").slice(0, 24),
    task_id: input.taskId,
    n: jwk.n,
    e: jwk.e,
  };
  const stored: StoredKernelHostCapability = {
    schema: "mae-flow-host-capability/1",
    authority,
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  try {
    writeFileSync(path, JSON.stringify(stored) + "\n", {
      encoding: "utf-8", mode: 0o600, flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return ensureKernelHostCapability(input);
  }
  return authority;
}

/** Pin the public authority before the Agent can observe a managed state. */
export function pinKernelHostAuthority(input: {
  cwd: string;
  workspace: string;
  taskId: string;
}): KernelHostAuthority {
  const authority = ensureKernelHostCapability(input);
  const statePath = join(input.cwd, ".mae-flow.json");
  if (!existsSync(statePath)) return authority;
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, any>;
  const contract = state.execution_contract;
  if (!contract || contract.host !== "cloud") {
    throw new KernelDeliveryError("只有 Cloud 执行契约可以固定持续检视宿主公钥");
  }
  const pinned = contract.host_authority as KernelHostAuthority | undefined;
  if (pinned) {
    if (canonical(pinned) !== canonical(authority)) {
      throw new KernelDeliveryError("内核状态绑定了另一把宿主公钥，拒绝替换");
    }
    return authority;
  }
  contract.host_authority = authority;
  const temporary = `${statePath}.host-authority-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf-8", mode: 0o600, flag: "wx",
  });
  renameSync(temporary, statePath);
  return authority;
}

function factsPath(workspace: string, label: string, payload: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  const dir = join(workspace, "kernel-delivery");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${label}-${digest}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function createKernelHostProof(input: {
  cwd: string;
  workspace: string;
  taskId: string;
  action: KernelHostAction;
  payload: unknown;
}): { path: string; cleanup(): void } {
  const authority = pinKernelHostAuthority(input);
  const storedPath = capabilityPath(input.workspace, input.taskId);
  const stored = JSON.parse(readFileSync(storedPath, "utf-8")) as
    StoredKernelHostCapability;
  validateStoredCapability(stored, input.taskId);
  if (canonical(stored.authority) !== canonical(authority)) {
    throw new KernelDeliveryError("持续检视宿主私钥与内核公钥不匹配");
  }
  const proof = {
    schema: "mae-flow-host-proof/1",
    task_id: input.taskId,
    action: input.action,
    payload_digest: createHash("sha256").update(canonical(input.payload))
      .digest("hex"),
    nonce: randomUUID(),
    issued_at: Math.floor(Date.now() / 1000),
  };
  const signature = sign("RSA-SHA256", Buffer.from(canonical(proof)), {
    key: stored.private_key,
  }).toString("base64url");
  const path = join(dirname(storedPath), `proof-${proof.nonce}.json`);
  writeFileSync(path, JSON.stringify({ ...proof, signature }) + "\n", {
    encoding: "utf-8", mode: 0o600, flag: "wx",
  });
  return { path, cleanup: () => rmSync(path, { force: true }) };
}

function invoke(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  action: KernelHostAction;
  payload: unknown;
  args: string[];
}): KernelDeliveryRecord {
  const proof = createKernelHostProof(input);
  const gitView = createSafeGitView(input.cwd);
  try {
    const result = spawnSync(
      input.host.python ?? "python3",
      [join(input.host.kernelRoot, "scripts", "mae-flow.py"),
       "delivery", ...input.args, "--host-proof", proof.path],
      {
        cwd: input.cwd,
        encoding: "utf-8",
        env: gitView.environment(),
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    let record: KernelDeliveryRecord | undefined;
    try { record = JSON.parse(line) as KernelDeliveryRecord; } catch { /* below */ }
    if (result.error || result.status !== 0
        || record?.schema !== "mae-flow-delivery-loop/1") {
      const detail = [result.error?.message, stderr, stdout]
        .filter(Boolean).join("\n").trim();
      throw new KernelDeliveryError(
        `内核持续检视命令失败：${detail || "没有返回结构化结果"}`);
    }
    return record;
  } finally {
    gitView.cleanup();
    proof.cleanup();
  }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof KernelDeliveryError
    && /flow revision 已从 \d+ 变为 \d+/.test(error.message);
}

/**
 * A merged event can race the last in-flight pipeline record after Cloud has
 * stopped the Agent writer. Delivery commands are idempotent, so retry only
 * the kernel's exact optimistic-lock conflict with a fresh state read/proof.
 * Every other failure remains fail-closed.
 */
function invokeAfterRevisionConflict(input: Parameters<typeof invoke>[0]):
    KernelDeliveryRecord {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return invoke(input);
    } catch (error) {
      lastError = error;
      if (!isRevisionConflict(error)) throw error;
    }
  }
  throw lastError;
}

function secureReceipt(path: string): Record<string, any> | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()
        || realpathSync(path) !== path
        || (info.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      return undefined;
    }
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value : undefined;
  } catch { return undefined; }
}

/** Verify a protected state projection against a receipt outside Agent mounts. */
export function trustedKernelHostProjection(input: {
  cwd: string;
  workspace: string;
  taskId: string;
  action: KernelHostAction;
  projection: unknown;
}): boolean {
  try {
    const authority = ensureKernelHostCapability(input);
    const root = capabilityRoot(input.workspace);
    const prefix = `${createHash("sha256").update(input.taskId).digest("hex")}.receipt-`;
    const publicKey = createPublicKey({
      key: { kty: "RSA", n: authority.n, e: authority.e },
      format: "jwk",
    });
    for (const name of readdirSync(root).sort().reverse()) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const receipt = secureReceipt(join(root, name));
      const proof = receipt?.proof;
      if (receipt?.schema !== "mae-flow-host-receipt/1"
          || proof?.schema !== "mae-flow-host-proof/1"
          || proof?.task_id !== input.taskId || proof?.action !== input.action
          || canonical(receipt.projection) !== canonical(input.projection)) continue;
      const unsigned = {
        schema: proof.schema,
        task_id: proof.task_id,
        action: proof.action,
        payload_digest: proof.payload_digest,
        nonce: proof.nonce,
        issued_at: proof.issued_at,
      };
      const payloadDigest = createHash("sha256")
        .update(canonical(receipt.payload)).digest("hex");
      const projectionDigest = createHash("sha256")
        .update(canonical(input.projection)).digest("hex");
      if (payloadDigest !== proof.payload_digest
          || projectionDigest !== receipt.projection_digest) continue;
      if (verifySignature("RSA-SHA256", Buffer.from(canonical(unsigned)),
        publicKey, Buffer.from(String(proof.signature ?? ""), "base64url"))) {
        return true;
      }
    }
  } catch { /* fail closed */ }
  return false;
}

/**
 * 与内核 host_projection 完全同形。收据不只封一条 PASS 或 results，
 * 还封住这次宿主动作落定后的 current、活动批次、完整 delivery_loop
 * 与质量事实，避免 Agent 把几张真的收据和手写生命周期拼成假现场。
 */
export function kernelHostLifecycleProjection(
  state: Record<string, any>,
  action: KernelHostAction,
): Record<string, unknown> {
  const loop = state?.delivery_loop;
  return {
    schema: "mae-flow-host-lifecycle/1",
    action,
    current: state?.current ?? null,
    active_batch_id: loop?.active_batch_id ?? null,
    delivery_loop: loop ?? null,
    external_verification: state?.quality?.external_verification ?? null,
    user_intervention: state?.user_intervention ?? null,
  };
}

/** Verify the current lifecycle as one indivisible host-authenticated fact. */
export function trustedKernelHostLifecycle(input: {
  cwd: string;
  workspace: string;
  taskId: string;
  actions: KernelHostAction[];
  state?: Record<string, any>;
}): boolean {
  let state = input.state;
  try {
    state ??= JSON.parse(readFileSync(
      join(input.cwd, ".mae-flow.json"), "utf-8"));
  } catch {
    return false;
  }
  return input.actions.some((action) => trustedKernelHostProjection({
    cwd: input.cwd,
    workspace: input.workspace,
    taskId: input.taskId,
    action,
    projection: kernelHostLifecycleProjection(state!, action),
  }));
}

/**
 * Agent 修复期间可以通过正常内核命令移动 current，但活动 writer 与批次
 * 内容必须和某张真实宿主收据完全一致。用于回收处理结果，不用于宣布
 * ready/completed；后两者仍要求整份生命周期精确匹配。
 */
export function trustedKernelHostActiveBatch(input: {
  cwd: string;
  workspace: string;
  taskId: string;
  actions: KernelHostAction[];
  state?: Record<string, any>;
}): boolean {
  let state = input.state;
  try {
    state ??= JSON.parse(readFileSync(
      join(input.cwd, ".mae-flow.json"), "utf-8"));
    const loop = state?.delivery_loop;
    const activeId = String(loop?.active_batch_id ?? "");
    const active = Array.isArray(loop?.batches)
      ? loop.batches.find((item: any) => String(item?.batch_id ?? "") === activeId)
      : undefined;
    if (!activeId || !active) return false;
    const root = capabilityRoot(input.workspace);
    const prefix = `${createHash("sha256").update(input.taskId).digest("hex")}.receipt-`;
    for (const name of readdirSync(root).sort().reverse()) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const receipt = secureReceipt(join(root, name));
      const action = String(receipt?.proof?.action ?? "") as KernelHostAction;
      const projection = receipt?.projection;
      const storedLoop = projection?.delivery_loop;
      const storedActive = Array.isArray(storedLoop?.batches)
        ? storedLoop.batches.find(
            (item: any) => String(item?.batch_id ?? "") === activeId)
        : undefined;
      if (!input.actions.includes(action)
          || String(projection?.active_batch_id ?? "") !== activeId
          || canonical(storedActive) !== canonical(active)) continue;
      if (trustedKernelHostProjection({
        cwd: input.cwd,
        workspace: input.workspace,
        taskId: input.taskId,
        action,
        projection,
      })) return true;
    }
  } catch { /* fail closed */ }
  return false;
}

export function openKernelFeedback(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  batch: KernelFeedbackBatch;
}): KernelDeliveryRecord {
  const path = factsPath(input.workspace, "feedback-open", input.batch);
  return invoke({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.batch.task_id, action: "feedback-open", payload: input.batch,
    args: ["feedback-open", "--file", path],
  });
}

export function adoptKernelDeliveryWatch(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  migrationId: string;
  taskId: string;
}): KernelDeliveryRecord {
  const payload = {
    schema: "mae-flow-feedback-batch/1",
    mode: "adopt-watch",
    batch_id: input.migrationId,
  };
  const path = factsPath(input.workspace, "adopt-watch", payload);
  return invoke({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId, action: "feedback-open", payload,
    args: ["feedback-open", "--file", path],
  });
}

export function recordKernelFeedbackResult(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  batchId: string;
  changed: boolean;
  results: KernelFeedbackResultItem[];
}): KernelDeliveryRecord {
  const payload = {
    schema: "mae-flow-feedback-result/1",
    batch_id: input.batchId,
    changed: input.changed,
    results: input.results,
  };
  const path = factsPath(input.workspace, "feedback-result", payload);
  return invoke({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId,
    action: "feedback-result", payload,
    args: ["feedback-result", "--file", path],
  });
}

export function closeKernelDelivery(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  sha: string;
  eventId: string;
}): KernelDeliveryRecord {
  const payload = { reason: "merged", sha: input.sha, event_id: input.eventId };
  return invokeAfterRevisionConflict({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId, action: "close", payload,
    args: ["close", "--reason", "merged", "--sha", input.sha,
      "--event-id", input.eventId],
  });
}
