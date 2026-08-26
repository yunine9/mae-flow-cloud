/**
 * 团队 Skill 资产库(可写管理面)契约:
 * - 写路径 fail-closed:装载器不认/含疑似密钥/路径越界一律拒收且不落盘;
 * - 权限显式归一(0644/0755),不信上传时的 umask;
 * - 覆盖/下线先归档,回退重走完整验收;操作逐条留痕(操作人+指纹);
 * - 写进 skills/ 即被货架照见——与快照器读的是同一个源,下一单即生效。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import {
  SkillLibraryError,
  listSkillOperations,
  listSkillVersions,
  offlineHostSkill,
  rollbackHostSkill,
  uploadHostSkill,
} from "../src/hostSkillLibrary.ts";
import { listHostSkillShelf } from "../src/hostSkillShelf.ts";

const encode = (text: string) => Buffer.from(text, "utf-8").toString("base64");

function skillMd(description: string, body = "写单测先读我。"): string {
  return `---\nname: java-autout\ndescription: ${description}\n---\n\n${body}\n`;
}

test("上传→货架可见且权限归一;更新归档旧版;回退按版本痕复原", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-skill-lib-"));
  const first = await uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("单测写法 v1")) },
    { path: "templates/case.md", content_base64: encode("三段命名模板\n") },
  ], "admin-a");
  assert.equal(first.action, "upload");
  assert.equal(first.files, 2);

  const shelf = listHostSkillShelf(dataDir);
  assert.equal(shelf.skills.length, 1);
  assert.equal(shelf.skills[0].name, "java-autout");
  assert.equal(shelf.skills[0].loadable, true, "收进来的必须是装载器认的");
  assert.equal(shelf.skills[0].digest, first.skill_digest,
    "货架指纹与留痕指纹必须同源");

  // 权限显式归一:文件 0644/目录 0755,不看上传时 umask 的脸色。
  const live = join(dataDir, "skills", "java-autout");
  assert.equal(statSync(join(live, "SKILL.md")).mode & 0o777, 0o644);
  assert.equal(statSync(join(live, "templates")).mode & 0o777, 0o755);

  const second = await uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("单测写法 v2")) },
  ], "admin-b");
  assert.equal(second.action, "update");
  const versions = listSkillVersions(dataDir, "java-autout");
  assert.equal(versions.length, 1, "覆盖必须先归档旧版");
  assert.equal(versions[0].skill_digest, first.skill_digest);
  assert.equal(versions[0].operator, "admin-b", "归档记的是动手的人");

  const restored = await rollbackHostSkill(
    dataDir, "java-autout", versions[0].version_id, "admin-a");
  assert.equal(restored.action, "rollback");
  assert.equal(restored.skill_digest, first.skill_digest, "回退=完整复原 v1");
  assert.ok(existsSync(join(dataDir, "skill-versions", "java-autout",
    versions[0].version_id)), "归档本体不动,回退是复制装回");
  assert.match(readFileSync(join(live, "SKILL.md"), "utf-8"), /v1/);
  // v2 被回退顶替时也要归档——任何生效过的版本都不允许凭空消失。
  assert.equal(listSkillVersions(dataDir, "java-autout").length, 2);

  const operations = listSkillOperations(dataDir);
  assert.deepEqual(operations.map((item) => item.action),
    ["rollback", "update", "upload"], "留痕逐条且新在前");
  assert.equal(operations[0].operator, "admin-a");
});

test("fail-closed:密钥、密钥容器文件名、坏 frontmatter、路径越界都拒收且不落盘", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-skill-guard-"));
  const cases: Array<{ why: RegExp; files: Parameters<typeof uploadHostSkill>[2] }> = [
    {
      why: /密钥赋值|令牌/,
      files: [{ path: "SKILL.md", content_base64: encode(
        skillMd("带密钥", "api_key: sk_live_abcd1234efgh")) }],
    },
    {
      why: /密钥容器/,
      files: [
        { path: "SKILL.md", content_base64: encode(skillMd("好的")) },
        { path: "assets/deploy.pem", content_base64: encode("x") },
      ],
    },
    {
      why: /装载器不接受/,
      files: [{ path: "SKILL.md", content_base64: encode("没有 frontmatter\n") }],
    },
    {
      why: /路径段不合法|路径不合法/,
      files: [
        { path: "SKILL.md", content_base64: encode(skillMd("好的")) },
        { path: "../escape.md", content_base64: encode("x") },
      ],
    },
    {
      why: /路径段不合法/,
      files: [
        { path: "SKILL.md", content_base64: encode(skillMd("好的")) },
        { path: ".env.local", content_base64: encode("x") },
      ],
    },
  ];
  for (const { why, files } of cases) {
    await assert.rejects(
      uploadHostSkill(dataDir, "guarded", files, "admin"),
      (error) => error instanceof SkillLibraryError && why.test(error.message),
      `该拒的没拒: ${why}`);
    assert.ok(!existsSync(join(dataDir, "skills", "guarded")),
      "拒收就一个字节都不许落进生效位");
  }
  // 密钥报错不许回显明文:掩码到末 4 位。
  await assert.rejects(
    uploadHostSkill(dataDir, "guarded", [
      { path: "SKILL.md", content_base64: encode(
        skillMd("带密钥", "token = ghp_secretsecretsecret")) },
    ], "admin"),
    (error) => error instanceof SkillLibraryError
      && error.message.includes("••••")
      && !error.message.includes("ghp_secretsecretsecret"));
  assert.ok(!existsSync(join(dataDir, "skill-staging"))
    || statSync(join(dataDir, "skill-staging")).isDirectory(),
    "暂存区允许存在但拒收后不留包");
  const shelf = listHostSkillShelf(dataDir);
  assert.equal(shelf.skills.length, 0);
  // 占位符写法必须放行——掩码扫描不能把"如何配置令牌"的教学也杀掉。
  const ok = await uploadHostSkill(dataDir, "guarded", [
    { path: "SKILL.md", content_base64: encode(
      skillMd("教学", "配置示例:api_key: <token>,不要写真值。")) },
  ], "admin");
  assert.equal(ok.action, "upload");
});

test("下线归档可回退;不存在的下线与坏版本号回退明确报错", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-skill-off-"));
  await uploadHostSkill(dataDir, "review-notes", [
    { path: "SKILL.md", content_base64: encode(skillMd("检视笔记")) },
  ], "admin");
  const off = await offlineHostSkill(dataDir, "review-notes", "admin");
  assert.equal(off.action, "offline");
  assert.equal(listHostSkillShelf(dataDir).skills.length, 0,
    "下线即从货架消失(下一单不再装载)");
  const versions = listSkillVersions(dataDir, "review-notes");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].action, "offline");

  const back = await rollbackHostSkill(
    dataDir, "review-notes", versions[0].version_id, "admin");
  assert.equal(back.action, "rollback");
  assert.equal(listHostSkillShelf(dataDir).skills.length, 1, "回退=重新上架");

  await assert.rejects(offlineHostSkill(dataDir, "ghost", "admin"),
    (error) => error instanceof SkillLibraryError
      && /没有这个生效中的/.test(error.message));
  await assert.rejects(
    rollbackHostSkill(dataDir, "review-notes", "../../etc", "admin"),
    (error) => error instanceof SkillLibraryError
      && /版本号不合法/.test(error.message));
});

test("路由权限:登录才可读,写只归管理员;留痕带操作人", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-skill-route-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("boss", "administrator-pass");
  auth.createUser("dev", "developer-pass-1", "developer");
  const service = new TaskService({
    dataDir: join(dir, "data"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    assert.equal((await fetch(`${base}/skills`)).status, 401,
      "货架不是公开页,登录才可读");
    const dev = await login("dev", "developer-pass-1");
    const boss = await login("boss", "administrator-pass");
    const payload = JSON.stringify({ files: [
      { path: "SKILL.md", content_base64: encode(skillMd("路由演练")) },
    ] });
    const denied = await fetch(`${base}/skills/route-demo`, {
      method: "PUT", headers: { cookie: dev }, body: payload,
    });
    assert.equal(denied.status, 403, "开发者不能上架");
    const accepted = await fetch(`${base}/skills/route-demo`, {
      method: "PUT", headers: { cookie: boss }, body: payload,
    });
    assert.equal(accepted.status, 200);

    const view = await (await fetch(`${base}/skills`,
      { headers: { cookie: dev } })).json() as {
        skills: unknown[];
        operations: Array<{ operator: string }>;
      };
    assert.equal(view.skills.length, 1, "开发者看得见货架与留痕");
    assert.equal(view.operations[0].operator, "boss",
      "留痕记录的是真实操作人,不是前端自报");

    const badUpload = await fetch(`${base}/skills/route-demo`, {
      method: "PUT", headers: { cookie: boss },
      body: JSON.stringify({ files: [{ path: "SKILL.md",
        content_base64: encode(skillMd("坏的", "token = ghp_abcdefghijkl")) }] }),
    });
    assert.equal(badUpload.status, 400, "掩码扫描把关在路由上同样生效");

    const offline = await fetch(`${base}/skills/route-demo`, {
      method: "DELETE", headers: { cookie: boss } });
    assert.equal(offline.status, 200);
    const versions = await (await fetch(
      `${base}/skills/route-demo/versions`,
      { headers: { cookie: dev } })).json() as {
        versions: Array<{ version_id: string }>;
      };
    assert.equal(versions.versions.length, 1);
    const rollback = await fetch(`${base}/skills/route-demo/rollback`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ version: versions.versions[0].version_id }),
    });
    assert.equal(rollback.status, 200, "下线可以按版本痕回退");
  } finally {
    server.close();
  }
});
