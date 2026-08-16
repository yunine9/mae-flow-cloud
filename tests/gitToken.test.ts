/**
 * 个人 Git 令牌(每用户 PAT)的契约:
 * - 存储沿用密钥模板:只写不读,公开视图/网络响应只有掩码;
 *   明文只住 0600 的 auth.json,消费口(gitCredential)是唯一出口;
 * - 注入走 credential helper:.git/config 只记脚本路径,
 *   明文永不进 config 或远端 URL——令牌拼 URL 会原样留在 config 里;
 * - 缺凭据不挂死:GIT_TERMINAL_PROMPT=0,克隆就地失败、错误如实上浮。
 *
 * 消费证明用真件:dumb-HTTP git 服务器带 Basic 鉴权,凭据对了才发码。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

const TOKEN = "glpat-secret-8642";

// 本机常开代理(实测 502):git 会拿 http_proxy 去撞 127.0.0.1 的
// 测试服务器。让回环地址绕开代理——代理策略是部署环境的事,产品不管。
process.env.no_proxy = "127.0.0.1,localhost";
process.env.NO_PROXY = "127.0.0.1,localhost";
// 掐掉系统/全局 git 配置:macOS 自带 osxkeychain helper,会把上一次
// 成功的凭据存进钥匙串再替下一次"无凭据"克隆作答(实测:负例假绿)。
// 测试裁的是我们的 helper,不是开发机的钥匙串。
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

test("存储:只写不读,掩码可看,消费口给明文,禁用即失效", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-gt-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("zhang", "zhang-password-1", "developer");

  auth.setGitToken("zhang", TOKEN);
  assert.equal(auth.gitTokenHint("zhang"), "••••8642");
  // 公开视图永远没有令牌的影子
  assert.ok(!JSON.stringify(auth.listUsers()).includes(TOKEN));
  // 消费口:git 用户名默认=登录账号
  assert.deepEqual(auth.gitCredential("zhang"),
    { username: "zhang", password: TOKEN, email: undefined });
  // 平台 git 用户名/邮箱可以另配;邮箱是署名(平台按它认 commit)
  auth.setGitToken("zhang", TOKEN, "zhang.san", "zhang@corp.example");
  assert.equal(auth.gitCredential("zhang")!.username, "zhang.san");
  assert.equal(auth.gitCredential("zhang")!.email, "zhang@corp.example");
  // 回显口:掩码+非密的用户名/邮箱,没有明文
  const profile = auth.gitProfile("zhang");
  assert.deepEqual(profile, {
    git_token_hint: "••••8642",
    git_username: "zhang.san",
    git_email: "zhang@corp.example",
  });
  // 邮箱格式不对当场打回
  assert.throws(() => auth.setGitToken("zhang", TOKEN, "z", "不是邮箱"),
    /邮箱格式/);
  // 重启(重新加载文件)后令牌还在——auth.json 是真相
  const revived = new LocalAuth(join(dir, "auth.json"));
  assert.equal(revived.gitCredential("zhang")!.password, TOKEN);
  // 空串=删除,署名一起清
  auth.setGitToken("zhang", "");
  assert.equal(auth.gitCredential("zhang"), undefined);
  assert.equal(auth.gitTokenHint("zhang"), undefined);
  assert.deepEqual(auth.gitProfile("zhang"), {});
  // 没配的、不存在的账号都安静返回 undefined
  assert.equal(auth.gitCredential("admin"), undefined);
  assert.equal(auth.gitCredential(undefined), undefined);
});

const SCRIPT: Scene[] = [{ text: "完成。" }];

test("路由:登录者改自己的令牌,响应只带掩码,明文不出网", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-gt-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "dev", password: "dev-password-11" }),
    });
    const cookie =
      String(login.headers.get("set-cookie") ?? "").split(";")[0];

    const put = await fetch(`${base}/auth/me/git-token`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ token: TOKEN, git_email: "dev@corp.example" }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.text();
    assert.ok(!putBody.includes(TOKEN), "PUT 响应带出了明文令牌");
    assert.match(putBody, /••••8642/);

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } })
      .then((r) => r.text());
    assert.ok(!me.includes(TOKEN), "/auth/me 带出了明文令牌");
    assert.match(me, /••••8642/);
    assert.match(me, /dev@corp\.example/, "署名邮箱该回显给表单确认");
    // 消费口拿到的是登录者本人的凭据
    assert.equal(auth.gitCredential("dev")!.password, TOKEN);

    // 未登录不能写
    const anonymous = await fetch(`${base}/auth/me/git-token`, {
      method: "PUT", body: JSON.stringify({ token: "x" }),
    });
    assert.equal(anonymous.status, 401);
  } finally {
    server.close();
    await model.stop();
  }
});

/** 带 Basic 鉴权的 dumb-HTTP git 服务器:真 git 协议、真 401。
 * 凭据不对不发码——克隆成功本身就是"helper 真被 git 调了"的证明。
 *
 * 必须开在子进程:cloneRepo 用 spawnSync,会把本进程事件循环卡住;
 * 服务器同进程的话 git 永远等不到响应,直接死锁(实测挂死 3 分钟)。 */
async function serveBareRepo(bare: string, expectAuth: string) {
  const script = join(mkdtempSync(join(tmpdir(), "mfc-gt-srv-")), "srv.mjs");
  const seen = join(dirname(script), "auth-seen.log");
  writeFileSync(script, `
    import { createServer } from "node:http";
    import { appendFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const [bare, expect, seen] = process.argv.slice(2);
    const server = createServer((request, response) => {
      appendFileSync(seen, (request.headers.authorization ?? "(anon)") + "\\n");
      if (request.headers.authorization !== expect) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        return response.end();
      }
      const path = (request.url ?? "").split("?")[0].replace(/^\\/repo\\.git/, "");
      try {
        const body = readFileSync(join(bare, path));
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      console.log(String(server.address().port));
    });
  `);
  const child = spawn(process.execPath, [script, bare, expectAuth, seen]);
  const port = await new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    child.once("exit", () => reject(new Error("git 服务器没起来")));
  });
  return {
    port,
    stop: () => child.kill(),
    authSeen: () => existsSync(seen)
      ? readFileSync(seen, "utf-8").trim().split("\n") : [],
  };
}

test("消费:clone 经 helper 过鉴权;config 只有脚本路径没有明文;缺凭据快败不挂死", async () => {
  // 源仓 → 裸仓 → update-server-info(dumb 协议的索引)
  const source = mkdtempSync(join(tmpdir(), "mfc-gt-src-"));
  git(source, "init", "--quiet", "-b", "master");
  git(source, "config", "user.email", "bot@test");
  git(source, "config", "user.name", "bot");
  writeFileSync(join(source, "README.md"), "# demo\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "init");
  const bare = mkdtempSync(join(tmpdir(), "mfc-gt-bare-"));
  git(source, "clone", "--quiet", "--bare", ".", join(bare, "r.git"));
  git(join(bare, "r.git"), "update-server-info");

  const expectAuth = "Basic "
    + Buffer.from(`zhang.san:${TOKEN}`).toString("base64");
  const remote = await serveBareRepo(join(bare, "r.git"), expectAuth);
  const repoUrl = `http://127.0.0.1:${remote.port}/repo.git`;
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();

  async function settle(service: TaskService, id: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = service.get(id)!.status;
      if (status === "completed" || status === "failed") return status;
      await new Promise((tick) => setTimeout(tick, 100));
    }
    throw new Error("任务没收口(克隆挂住了?)");
  }

  try {
    // 有凭据:克隆过鉴权,任务收口
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-gt-run-"));
    const service = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
      host: { kernelRoot, repoPath: repoUrl, python: "python3" },
      gitCredential: (account) => account === "zhang"
        ? { username: "zhang.san", password: TOKEN,
            email: "zhang@corp.example" }
        : undefined,
    });
    const id = service.create("验证个人令牌注入", { account: "zhang" }).id;
    assert.equal(await settle(service, id), "completed",
      service.get(id)!.detail ?? "");
    assert.ok(remote.authSeen().some((auth) => auth === expectAuth),
      "git 没带上 helper 给的凭据");

    const workspace = service.get(id)!.workspace;
    const clone = join(workspace, "repo");
    // .git/config 只有脚本路径,明文令牌一个字都不能有
    const config = readFileSync(join(clone, ".git", "config"), "utf-8");
    assert.ok(!config.includes(TOKEN), "明文令牌漏进 .git/config");
    assert.match(config, /credential/);
    assert.match(config, /git-credential\.sh/);
    // helper 列表 = [空, 我们的脚本]:空项清掉继承的系统 helper,
    // 令牌既只从脚本来,也不会被钥匙串之流顺手存走(实测踩过)。
    assert.match(config,
      /helper\s*=\s*\n\s*helper\s*=\s*\S*git-credential\.sh/);
    // 远端 URL 干净(没被拼进用户名密码)
    assert.equal(git(clone, "remote", "get-url", "origin"), repoUrl);
    // commit 署名写进了克隆配置:令牌管推送鉴权,"commit 是谁的"
    // 平台按 email 认——两码事,都得对
    assert.equal(git(clone, "config", "user.name"), "zhang.san");
    assert.equal(git(clone, "config", "user.email"), "zhang@corp.example");
    // 凭据文件 0600、脚本 0700
    const agentDir = join(workspace, "pi-agent");
    assert.equal(
      statSync(join(agentDir, "git-credential")).mode & 0o777, 0o600);
    assert.equal(
      statSync(join(agentDir, "git-credential.sh")).mode & 0o777, 0o700);
    // 脚本本身可独立执行:get 出凭据,别的动作安静成功
    const answer = execFileSync(
      join(agentDir, "git-credential.sh"), ["get"], { encoding: "utf-8" });
    assert.match(answer, new RegExp(`password=${TOKEN}`));
    assert.equal(execFileSync(
      join(agentDir, "git-credential.sh"), ["store"],
      { encoding: "utf-8" }), "");

    // 没凭据:git 禁问密码,克隆快败,任务如实 failed 不挂死
    const bald = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-gt-run2-")),
      provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
      host: { kernelRoot, repoPath: repoUrl, python: "python3" },
    });
    const denied = bald.create("无令牌该快败", { account: "zhang" }).id;
    assert.equal(await settle(bald, denied), "failed");
    assert.match(bald.get(denied)!.detail ?? "", /克隆失败/);
  } finally {
    remote.stop();
    await model.stop();
  }
});
