/**
 * 拉取日志的递归清单 / 深路径读取 / 压缩包解压契约(#47)。
 *
 * 四块钉死:
 * 1. listLogs 递归成扁平条目(path 相对、type 分目录文件、archive 按扩展
 *    名),条数/深度封顶如实标注 truncated——fetch-logs 抓的是完整目录
 *    结构,平铺清单对子目录无能为力;
 * 2. readLog 任意深度可读,resolve 后必须严格落在 local-logs 内(../ 穿越
 *    与绝对路径拒绝),超长照旧读尾;
 * 3. extractLog 走系统 tar/unzip(数组参数,无 shell 拼接),解到同目录
 *    <去扩展名>-extracted/,重复解压幂等;含 ../ 条目的档案在动手前拒绝
 *    (zip-slip);属主交接参数注入后产物归容器用户;
 * 4. 真路由:GET log 支持子目录,POST log-extract 幂等 + 恶意包 400 人话。
 *
 * 档案都是现场造的真包:tar.gz 用系统 tar(与解压端同款真件),恶意包与
 * 超限包用 python3 tarfile/zipfile 造(tar 命令在创建期会消毒成员名,只有
 * 手工构造才进得了"读档案"这一侧)。unzip 缺失的宿主(本机实况)zip 解
 * 压用例显式 skip 并说明;对应的"缺 unzip 给人话"分支只在缺失时可达,
 * 同样显式 skip。4GB 总字节封顶不真造 4GB 包(测试时间不允许),防线由
 * 条数封顶(有测)+ 120s 超时 + 代码审查兜底,如实记录。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLog,
  listLogs,
  readLog,
} from "../src/issueFlow/materials.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";

const HAS_TAR = !!execFileSync("sh", ["-c", "command -v tar || true"])
  .toString().trim();
const HAS_UNZIP = !!execFileSync("sh", ["-c", "command -v unzip || true"])
  .toString().trim();
const HAS_PYTHON = !!execFileSync("sh", ["-c", "command -v python3 || true"])
  .toString().trim();
const SKIP_TAR = !HAS_TAR && "宿主无 tar 命令:解压端无法验证";
const SKIP_UNZIP_MISSING = HAS_UNZIP && "宿主已装 unzip:缺失分支不可达";
const SKIP_ZIP_EXTRACT = !HAS_UNZIP
  && "宿主未装 unzip(本机实况):zip 解压端无法验证;造包用 python3 zipfile,与解压端无关";
const SKIP_PYTHON = !HAS_PYTHON
  && "宿主无 python3:恶意/超限档案无法现场构造(tar 创建期会消毒成员名)";

function stageDir(): string {
  return mkdtempSync(join(tmpdir(), "mfc-issue-logs-"));
}

function cleanup(...paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** 造包真件:系统 tar 打 tar.gz/tar(与 extractLog 的解压端同款命令)。 */
function makeTar(
  archivePath: string,
  stage: string,
  members: string[],
  compress = true,
): void {
  execFileSync("tar", [compress ? "-czf" : "-cf", archivePath, "-C", stage,
    ...members]);
}

/** python3 造任意成员名的 tar.gz(tar 命令创建期会消毒 ../,恶意包只能
 * 手工构造;读档案侧的预检才是被测对象)。 */
function makeEvilTarGz(archivePath: string, member: string): void {
  execFileSync("python3", ["-c", `
import tarfile, io, sys
t = tarfile.open(sys.argv[1], "w:gz")
data = b"pwned"
info = tarfile.TarInfo(sys.argv[2])
info.size = len(data)
t.addfile(info, io.BytesIO(data))
t.close()
`, archivePath, member]);
}

/** python3 造真 zip(宿主没有 zip 命令时的真件来源)。 */
function makeZip(archivePath: string, entries: Array<[string, string]>): void {
  execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_STORED) as z:
    names = sys.argv[2::2]
    bodies = sys.argv[3::2]
    for i in range(len(names)):
        z.writestr(names[i], bodies[i])
`, archivePath, ...entries.flat()]);
}

/** python3 造超条目数的 tar.gz(解压炸弹形态:海量小条目;-tf 列表
 * 一条一行的口径是条数封顶的依据,与压缩格式无关)。 */
function makeTarBomb(archivePath: string, entries: number): void {
  execFileSync("python3", ["-c", `
import tarfile, sys
with tarfile.open(sys.argv[1], "w:gz") as t:
    for i in range(int(sys.argv[2])):
        info = tarfile.TarInfo(f"bomb/file-{i}.txt")
        info.size = 0
        t.addfile(info)
`, archivePath, String(entries)]);
}

test("listLogs 递归多层目录:path 相对、type 分目录文件、archive 按扩展名", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "svc-a", "2026-08-30"), { recursive: true });
    writeFileSync(join(logs, "boot.log"), "top\n");
    writeFileSync(join(logs, "svc-a", "app.log"), "mid\n");
    writeFileSync(join(logs, "svc-a", "2026-08-30", "err.log"), "deep\n");
    writeFileSync(join(logs, "bundle.tar.gz"), "x");
    const listing = listLogs(root);
    assert.equal(listing.truncated, false);
    const byPath = new Map(listing.entries.map((e) => [e.path, e]));
    assert.equal(byPath.get("svc-a")?.type, "dir",
      "子目录本身要在清单里(前端组树的节点)");
    assert.equal(byPath.get("svc-a/2026-08-30")?.type, "dir");
    assert.equal(byPath.get("svc-a/2026-08-30/err.log")?.type, "file");
    assert.equal(byPath.get("svc-a/2026-08-30/err.log")?.archive, false);
    assert.equal(byPath.get("bundle.tar.gz")?.archive, true);
    // 五种档案扩展名全认,大小写不敏感。
    for (const name of ["a.zip", "b.tar", "c.tar.gz", "d.tgz", "e.TAR.BZ2"]) {
      writeFileSync(join(logs, name), "x");
    }
    const archives = listLogs(root).entries
      .filter((e) => e.archive).map((e) => e.path);
    for (const name of ["a.zip", "b.tar", "c.tar.gz", "d.tgz", "e.TAR.BZ2"]) {
      assert.ok(archives.includes(name), `${name} 应标 archive`);
    }
  } finally {
    cleanup(root);
  }
});

test("listLogs 符号链接一律跳过不跟随", () => {
  const root = stageDir();
  const outside = mkdtempSync(join(tmpdir(), "mfc-issue-logs-out-"));
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "real"), { recursive: true });
    writeFileSync(join(logs, "real", "ok.log"), "fine\n");
    writeFileSync(join(outside, "secret"), "x");
    execFileSync("ln", ["-s", outside, join(logs, "link-dir")]);
    execFileSync("ln", ["-s", "/etc/hostname", join(logs, "link-file")]);
    const paths = listLogs(root).entries.map((e) => e.path);
    assert.ok(paths.includes("real/ok.log"));
    assert.equal(paths.some((p) => p.startsWith("link-")), false,
      "链接本身也不进清单(chownTree 同款纪律:不跟随也不展示)");
  } finally {
    cleanup(root, outside);
  }
});

test("listLogs 条数封顶 2000,超限如实标注 truncated", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    mkdirSync(logs, { recursive: true });
    for (let i = 0; i < 2001; i++) {
      writeFileSync(join(logs, `log-${String(i).padStart(5, "0")}.txt`), "x");
    }
    const capped = listLogs(root);
    assert.equal(capped.entries.length, 2000, "清单条数封顶 2000");
    assert.equal(capped.truncated, true, "超限要如实标注");
  } finally {
    cleanup(root);
  }
});

test("listLogs 深度封顶:超深链不进清单,truncated 说话", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    let deep = logs;
    for (let i = 0; i < 25; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "bottom.txt"), "x");
    writeFileSync(join(logs, "top.txt"), "x");
    const listing = listLogs(root);
    assert.equal(listing.truncated, true, "撞深度帽要标注");
    assert.equal(listing.entries.some((e) => e.path.includes("bottom")), false,
      "超过深度帽的条目不出现");
    assert.ok(listing.entries.some((e) => e.path === "top.txt"),
      "帽内条目照常在列");
  } finally {
    cleanup(root);
  }
});

test("readLog 任意深度可读;../ 穿越与绝对路径拒绝;超长读尾", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "svc", "nested"), { recursive: true });
    writeFileSync(join(logs, "svc", "nested", "app.log"), "line-1\nline-2\n");
    const deep = readLog(root, "svc/nested/app.log");
    assert.equal(deep.content, "line-1\nline-2\n");
    assert.equal(deep.truncated, false);
    // 相对表达(含 a/../b)只要 resolve 后仍在 local-logs 内就放行。
    assert.equal(readLog(root, "svc/../svc/nested/app.log").content,
      "line-1\nline-2\n");
    assert.throws(() => readLog(root, "../../issue.json"), /路径不合法/);
    assert.throws(() => readLog(root, "/etc/passwd"), /路径不合法/);
    assert.throws(() => readLog(root, "svc/nested"), /目录/);
    assert.throws(() => readLog(root, "no/such.log"), /不存在/);
    // 超长读尾:只回最后 512KB,标 truncated;头部的独特标记必须被裁掉。
    writeFileSync(join(logs, "svc", "big.log"),
      "HEAD-MARKER\n" + "x".repeat(600 * 1024) + "\nTAIL-MARKER\n");
    const tail = readLog(root, "svc/big.log");
    assert.equal(tail.truncated, true);
    assert.match(tail.content, /TAIL-MARKER/);
    assert.doesNotMatch(tail.content, /HEAD-MARKER/, "读尾不该从头开始");
  } finally {
    cleanup(root);
  }
});

test("extractLog tar.gz:解到 <去扩展名>-extracted/,重复解压幂等,子目录可读",
  { skip: SKIP_TAR }, async () => {
    const root = stageDir();
    try {
      const logs = join(root, "local-logs");
      const stage = join(root, "stage");
      mkdirSync(join(stage, "nested"), { recursive: true });
      writeFileSync(join(stage, "app.log"), "line-1\n");
      writeFileSync(join(stage, "nested", "err.log"), "EACCES\n");
      mkdirSync(logs, { recursive: true });
      makeTar(join(logs, "svc.tar.gz"), stage, ["app.log", "nested"]);
      const first = await extractLog(root, "svc.tar.gz");
      assert.deepEqual(first, { ok: true, path: "svc-extracted", reused: false });
      assert.equal(readFileSync(join(logs, "svc-extracted", "app.log"), "utf-8"),
        "line-1\n");
      assert.equal(
        readFileSync(join(logs, "svc-extracted", "nested", "err.log"), "utf-8"),
        "EACCES\n");
      // 幂等:目录已在直接复用,不重解不覆盖。
      writeFileSync(join(logs, "svc-extracted", "app.log"), "human-edited\n");
      const again = await extractLog(root, "svc.tar.gz");
      assert.equal(again.reused, true);
      assert.equal(readFileSync(join(logs, "svc-extracted", "app.log"), "utf-8"),
        "human-edited\n", "复用不得覆盖既有产物");
      // 子目录里的压缩包:解压目录落在包同目录。
      mkdirSync(join(logs, "batch"), { recursive: true });
      makeTar(join(logs, "batch", "inner.tar.gz"), stage, ["app.log"]);
      const nested = await extractLog(root, "batch/inner.tar.gz");
      assert.equal(nested.path, "batch/inner-extracted");
      assert.ok(existsSync(join(logs, "batch", "inner-extracted", "app.log")));
    } finally {
      cleanup(root);
    }
  });

test("extractLog 恶意档案(../ 条目)在动手前拒绝,无产物落地",
  { skip: SKIP_PYTHON }, async () => {
    const root = stageDir();
    try {
      const logs = join(root, "local-logs");
      mkdirSync(logs, { recursive: true });
      makeEvilTarGz(join(logs, "evil.tar.gz"), "../evil.txt");
      await assert.rejects(
        () => extractLog(root, "evil.tar.gz"),
        /\.\. 穿越/,
        "zip-slip 要在预检拦下,给人话",
      );
      assert.equal(existsSync(join(logs, "evil-extracted")), false,
        "被拒的档案不得留下解压产物");
      // 解压目标撞上同名普通文件:明确报错,不静默覆盖。
      writeFileSync(join(logs, "occupied-extracted"), "not a dir");
      const stage = join(root, "stage");
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, "ok.txt"), "x\n");
      makeTar(join(logs, "occupied.tar"), stage, ["ok.txt"], false);
      await assert.rejects(() => extractLog(root, "occupied.tar"),
        /已存在且不是目录/);
    } finally {
      cleanup(root);
    }
  });

test("extractLog 条数封顶:超过 20000 条目的档案在解压前拒绝",
  { skip: SKIP_PYTHON }, async () => {
    const root = stageDir();
    try {
      const logs = join(root, "local-logs");
      mkdirSync(logs, { recursive: true });
      // 炸弹用 tar 形态:-tf 列表在所有宿主都可达(tar 是解压端真件),
      // zip 形态在缺 unzip 的宿主会先撞 ENOENT 提示,验不到条数这一道。
      makeTarBomb(join(logs, "bomb.tar.gz"), 20001);
      await assert.rejects(() => extractLog(root, "bomb.tar.gz"), /解压炸弹/);
      assert.equal(existsSync(join(logs, "bomb-extracted")), false);
    } finally {
      cleanup(root);
    }
  });

test("extractLog zip 解压到 -extracted/(unzip 在场的宿主才可验)",
  { skip: SKIP_ZIP_EXTRACT }, async () => {
    const root = stageDir();
    try {
      const logs = join(root, "local-logs");
      mkdirSync(logs, { recursive: true });
      makeZip(join(logs, "svc.zip"), [
        ["app.log", "from-zip\n"],
        ["sub/err.log", "zip-deep\n"],
      ]);
      const first = await extractLog(root, "svc.zip");
      assert.deepEqual(first, { ok: true, path: "svc-extracted", reused: false });
      assert.equal(
        readFileSync(join(logs, "svc-extracted", "sub", "err.log"), "utf-8"),
        "zip-deep\n");
      const again = await extractLog(root, "svc.zip");
      assert.equal(again.reused, true);
    } finally {
      cleanup(root);
    }
  });

test("unzip 缺失时 zip 给明确安装提示,不砸出 ENOENT 原始错误",
  { skip: SKIP_UNZIP_MISSING }, async () => {
    const root = stageDir();
    try {
      const logs = join(root, "local-logs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "x.zip"), "PK\n");
      await assert.rejects(() => extractLog(root, "x.zip"), /安装 unzip/);
      assert.equal(existsSync(join(logs, "x-extracted")), false,
        "命令缺失也要清掉空目标目录");
    } finally {
      cleanup(root);
    }
  });

test("extractLog 归容器属主交接:注入 root 形态后产物 uid/gid 归容器用户",
  { skip: SKIP_TAR }, async () => {
    const root = stageDir();
    try {
      const logs = join(root, "local-logs");
      const stage = join(root, "stage");
      mkdirSync(join(stage, "d"), { recursive: true });
      writeFileSync(join(stage, "d", "f.log"), "x\n");
      mkdirSync(logs, { recursive: true });
      makeTar(join(logs, "own.tar.gz"), stage, ["d"]);
      // 非 root 宿主:目标属主取当前 uid/gid(chown 是合法 no-op),代码
      // 路径完整走一遍;真断言(chown 到别人)只在 root 形态生效——
      // 与 containerOwnership.test.ts 同款两栖写法。
      const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
      const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
      await extractLog(root, "own.tar.gz", {
        user: `${uid}:${gid}`,
        runtime: { platform: "linux", effectiveUid: 0 },
      });
      const produced = statSync(join(logs, "own-extracted", "d", "f.log"));
      assert.equal(produced.uid, uid, "产物属主应交接为容器用户");
      assert.equal(produced.gid, gid);
    } finally {
      cleanup(root);
    }
  });

// ---- 真路由(GET log / POST log-extract):手搓请求对象,不养 HTTP 服务器 ----

function issueCall(
  method: "GET" | "POST",
  parts: string[],
  options: { service: IssueFlowService; payload?: unknown; url?: string },
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = method === "GET"
      ? ({ method, url: options.url } as any)
      : (new EventEmitter() as any);
    request.method = method;
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (output?: string | Buffer) => {
          try {
            const text = Buffer.isBuffer(output)
              ? output.toString("utf-8") : output ?? "{}";
            resolve({ status, body: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: options.service, authEnabled: false },
    ).catch(reject);
    if (method !== "GET") {
      request.emit("data", Buffer.from(JSON.stringify(options.payload ?? {})));
      request.emit("end");
    }
  });
}

/** 摆一个挂起会话(材料路由的前置),返回会话工作区根。 */
function seedSessionWithLogs(dataDir: string): string {
  const id = "issue-logs";
  const root = join(dataDir, "issues", id);
  mkdirSync(join(root, "local-logs"), { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev",
    created_at: "2026-08-31T08:00:00Z", updated_at: "2026-08-31T09:00:00Z",
    title: "t", description: "", source: "manual",
    mode: "fixed", scenario: "no_ticket",
    status: "suspended", stage: "conclude", stage_note: "",
    stage_at: "2026-08-31T09:00:00Z",
  }));
  return root;
}

test("路由:materials 清单带递归 logs,GET log 读子目录,穿越给 400 人话", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-logs-route-"));
  const root = seedSessionWithLogs(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "svc"), { recursive: true });
    writeFileSync(join(logs, "svc", "app.log"), "deep-log\n");
    const materials = await issueCall("GET", ["issues", "issue-logs", "materials"],
      { service, url: "/issues/issue-logs/materials" });
    assert.equal(materials.status, 200);
    assert.ok(materials.body.logs.entries.some((e: { path: string }) =>
      e.path === "svc/app.log"), "递归清单要含子目录文件");
    const read = await issueCall("GET", ["issues", "issue-logs", "materials", "log"],
      { service, url: "/issues/issue-logs/materials/log?name=svc%2Fapp.log" });
    assert.equal(read.status, 200);
    assert.equal(read.body.content, "deep-log\n");
    const escape = await issueCall("GET", ["issues", "issue-logs", "materials", "log"],
      { service, url: "/issues/issue-logs/materials/log?name=..%2F..%2Fissue.json" });
    assert.equal(escape.status, 400);
    assert.match(escape.body.error, /路径不合法/);
  } finally {
    await service.shutdown().catch(() => undefined);
    cleanup(dataDir);
  }
});

test("路由:POST log-extract 解压 → 幂等复用;解压产物即读;恶意包/越界 400 人话",
  { skip: SKIP_TAR }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-logs-post-"));
    const root = seedSessionWithLogs(dataDir);
    const service = new IssueFlowService({
      dataDir, provider: "p", model: "m", modelsJson: {},
    });
    try {
      const logs = join(root, "local-logs");
      const stage = join(root, "stage");
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, "a.log"), "route-extract\n");
      makeTar(join(logs, "pkg.tar.gz"), stage, ["a.log"]);
      makeEvilTarGz(join(logs, "evil.tar.gz"), "../evil.txt");
      const first = await issueCall("POST",
        ["issues", "issue-logs", "materials", "log-extract"],
        { service, payload: { path: "pkg.tar.gz" } });
      assert.equal(first.status, 200);
      assert.deepEqual(first.body,
        { ok: true, path: "pkg-extracted", reused: false });
      const again = await issueCall("POST",
        ["issues", "issue-logs", "materials", "log-extract"],
        { service, payload: { path: "pkg.tar.gz" } });
      assert.equal(again.body.reused, true, "重复解压幂等");
      // 解压产物立刻可读(树里可见可点的服务端事实)。
      const produced = await issueCall("GET",
        ["issues", "issue-logs", "materials", "log"],
        { service, url: "/issues/issue-logs/materials/log?name=pkg-extracted%2Fa.log" });
      assert.equal(produced.status, 200);
      assert.equal(produced.body.content, "route-extract\n");
      const malicious = await issueCall("POST",
        ["issues", "issue-logs", "materials", "log-extract"],
        { service, payload: { path: "evil.tar.gz" } });
      assert.equal(malicious.status, 400);
      assert.match(malicious.body.error, /穿越|不安全/);
      const escape = await issueCall("POST",
        ["issues", "issue-logs", "materials", "log-extract"],
        { service, payload: { path: "../../issue.json" } });
      assert.equal(escape.status, 400);
      assert.match(escape.body.error, /路径不合法/);
    } finally {
      await service.shutdown().catch(() => undefined);
      cleanup(dataDir);
    }
  });
