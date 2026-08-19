/**
 * 正式前端静态托管语义:
 * - 配 webRoot:/ 出 index.html,资产按类型出文件,API 路由不受影响;
 * - 不配 webRoot:零构建演示页兜底——两种形态永远有一个能用;
 * - 路径穿越不是 404 的一种,是攻击:webRoot 外的文件一律不认。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

function startServer(webRoot?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "webhost-"));
  const service = new TaskService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  const server = createTaskServer(service, { webRoot });
  return new Promise<{ base: string; close: () => void }>((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ready({
        base: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

/** 不走 fetch 的原始 HTTP GET:路径原样上线,不被客户端规范化。 */
function rawGet(base: string, path: string): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => done(data));
    socket.on("error", fail);
  });
}

test("配 webRoot:index 与资产按类型出文件,API 与穿越各归各位", async () => {
  const webRoot = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "index.html"), "<title>正式前端</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(webRoot, "..", "secret.txt"), "不该被读到");
  const { base, close } = await startServer(webRoot);
  try {
    const index = await fetch(base + "/");
    assert.equal(index.headers.get("content-type"),
      "text/html; charset=utf-8");
    assert.match(await index.text(), /正式前端/);

    // 入口页必须每次回源。它一个缓存头都不带的时候,浏览器可以按启发式
    // 规则自己缓存;资产名带 hash 也没用——入口页是旧的,它引的就永远是
    // 旧包。前端修了三轮,人看到的可能一直是修之前那版,而且这种"没生效"
    // 完全无声。
    assert.match(index.headers.get("cache-control") ?? "", /no-cache/);

    const asset = await fetch(base + "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"),
      "text/javascript; charset=utf-8");
    // 带 hash 的资产反过来可以长期缓存:改了内容就是新文件名。
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

    // API 路由优先于静态文件,不被前端接管。
    const api = await fetch(base + "/tasks");
    assert.deepEqual(await readJson(api), []);

    // 任务工作台有真正的可刷新子 URL，由 SPA 入口接管；旧通知若仍指向
    // /tasks/:id，浏览器导航会跳到新地址，而 API fetch 仍返回 JSON。
    const work = await fetch(base + "/work/task-7");
    assert.equal(work.status, 200);
    assert.match(await work.text(), /正式前端/);
    const legacy = await fetch(base + "/tasks/task-7", {
      headers: { accept: "text/html" }, redirect: "manual",
    });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/work/task-7");
    const apiDetail = await fetch(base + "/tasks/task-7");
    assert.equal(apiDetail.status, 404);
    assert.match(apiDetail.headers.get("content-type") ?? "", /application\/json/);

    // 穿越:fetch 会在客户端就规范化 "..",测不到服务端——
    // 用裸 socket 发未规范化路径,断言真属性:秘密永不泄露。
    const raw = await rawGet(base, "/assets/../../secret.txt");
    assert.ok(!raw.includes("不该被读到"), "webRoot 外的文件泄露了");
    assert.match(raw, /404/);
    const missing = await fetch(base + "/no-such-file.js");
    assert.equal(missing.status, 404);
  } finally {
    close();
  }
});

test("不配 webRoot:零构建演示页兜底", async () => {
  const { base, close } = await startServer();
  try {
    const page = await fetch(base + "/");
    assert.match(await page.text(), /Mae-Flow 云端任务/);
  } finally {
    close();
  }
});
