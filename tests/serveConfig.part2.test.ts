/**
 * serveConfig part 2:启动契约与拒启口径:8 核报告/优雅关闭/端口占用/前端过期/命令行压文件/内核模式双拒绝/弃用提示。
 * 共享夹具在 tests/serveConfig.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServe } from "./support/serveProcess.ts";
import {
  run,
} from "./serveConfig.helpers.ts";


test("任务容器默认可用 8 核，并在启动日志报告宿主可用 CPU", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-container-cpus-"));
  const result = await run([
    "--data", join(dir, "tasks"),
    "--port", "0",
    "--isolate-image", "fixture/builder:test",
    "--isolate-user", "1000:1000",
  ], (line) => line.startsWith("[serve] http://127.0.0.1:"));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /memory=8g,cpus=8,pids=512/);
  assert.match(result.output, /host-available-cpus=\d+/);
});



test("容器 npm 源(#75):命令行与 serve.json 都生效,内网形态零配置注入缺省", async () => {
  // 内网容器没有 registry 时 npm 打公网直到超时。配置入口是 --isolate-
  // npm-registry / serve.json "isolate-npm-registry"(键 = flag 去 --);
  // 没配时按部署形态判定:挂载了 Maven settings.xml = 内网镜像部署,
  // 回落内置缺省源,零配置直接可用(2026-09-03 部署反馈:不能指望运维
  // 多配一行);非内网形态维持公网,但启动面要把后果与出路说明。
  const dir = mkdtempSync(join(tmpdir(), "mfc-npm-registry-serve-"));
  const registry = "https://npm.intra.example/repository/npm-group/";
  const intranetDefault = "https://cmc.centralrepo.rnd.huawei.com/npm/";
  const settingsXmlVolume
    = "/etc/mae-flow/maven/settings.xml:/etc/mae-flow/maven/settings.xml:ro";
  const boot = (tag: string, args: string[]) => run([
    "--data", join(dir, tag), "--port", "0",
    "--isolate-image", "fixture/builder:test", ...args,
  ], (line) => line.startsWith("[serve] http://127.0.0.1:"));

  const fromCli = await boot("cli", ["--isolate-npm-registry", registry]);
  assert.equal(fromCli.code, 0, fromCli.output);
  assert.ok(fromCli.output.includes(`容器 npm 源: ${registry}`),
    `命令行 registry 未生效,输出:\n${fromCli.output.slice(0, 800)}`);

  const config = join(dir, "serve.json");
  writeFileSync(config, JSON.stringify({
    "isolate-image": "fixture/builder:test",
    "isolate-npm-registry": registry,
  }));
  const fromFile = await run([
    "--config", config, "--data", join(dir, "file"), "--port", "0",
  ], (line) => line.startsWith("[serve] http://127.0.0.1:"));
  assert.equal(fromFile.code, 0, fromFile.output);
  assert.ok(fromFile.output.includes(`容器 npm 源: ${registry}`),
    `serve.json 键 isolate-npm-registry 未生效,输出:\n${fromFile.output.slice(0, 800)}`);

  const intranet = await boot("intranet", ["--isolate-volume", settingsXmlVolume]);
  assert.equal(intranet.code, 0, intranet.output);
  assert.ok(intranet.output.includes(`容器 npm 源: ${intranetDefault}`),
    "挂了 settings.xml 的内网形态必须零配置注入缺省源");
  assert.ok(intranet.output.includes("内网形态缺省"),
    "缺省注入要亮出来源,运维才知道去哪覆盖");

  const intranetOverride = await boot("intranet-override", [
    "--isolate-volume", settingsXmlVolume, "--isolate-npm-registry", registry,
  ]);
  assert.equal(intranetOverride.code, 0, intranetOverride.output);
  assert.ok(intranetOverride.output.includes(`容器 npm 源: ${registry}`)
    && !intranetOverride.output.includes("内网形态缺省"),
    "显式配置覆盖形态缺省,且来源标注消失");

  const bare = await boot("bare", []);
  assert.equal(bare.code, 0, bare.output);
  assert.ok(bare.output.includes("容器 npm 源: 未注入,npm 将打公网"),
    "非内网形态(无 settings.xml 挂载)维持公网现状,但要把后果与出路说明");
});



test("SIGTERM 走优雅关闭并明确承诺业务状态不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-graceful-stop-"));
  const result = await run([
    "--data", join(dir, "tasks"), "--port", "0",
  ], (line) => line.includes("http://127.0.0.1:"));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /收到 SIGTERM，停止接单并清理/);
  assert.match(result.output, /业务状态保持不变/);
});



test("端口被占:说人话并退出,不甩一段栈", async () => {
  // 内网反复报"server 挂了"里,有一份就是这个:上一次的服务还占着端口,
  // 新起的进程在 listen 上抛 EADDRINUSE。没有处理器时它是未捕获的 error
  // 事件——终端只剩一段栈,人只记得"挂了"。占端口的真件在这儿,不是假件。
  const dir = mkdtempSync(join(tmpdir(), "mfc-cfg-busy-"));
  const squatter = createServer(() => {});
  await new Promise<void>((ready) => squatter.listen(0, "127.0.0.1", ready));
  const port = (squatter.address() as AddressInfo).port;
  try {
    const { code, output } = await run([
      "--port", String(port), "--data", join(dir, "tasks"),
    ], () => false, 20_000);
    assert.equal(code, 2, `应以 2 退出,实际 ${code};输出:\n${output}`);
    assert.match(output, /端口 \d+ 已被占用/);
    assert.match(output, /lsof|ss -lptn/, "要给出查占用的具体命令");
    assert.doesNotMatch(output, /at Server\./, "别把栈甩给用户");
  } finally {
    squatter.close();
  }
});



test("前端构建比源码旧:启动就明说,别让人以为功能坏了", async () => {
  // 内网实测的坑:web/dist 是 gitignore 的,拉了新代码不重新构建,
  // 页面还是旧的——新功能在人眼里就是"点不了/坏了"(他手上那份前端
  // 压根没有这段代码)。页面不会自己声明版本,所以服务启动时说。
  const dir = mkdtempSync(join(tmpdir(), "mfc-staleweb-"));
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html>旧构建</html>");
  // 把构建时间调到 2020 年:比仓里任何源码都旧
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(dist, "index.html"), old, old);
  const { output } = await run(
    ["--web", dist, "--data", join(dir, "tasks"), "--port", "0"],
    (line) => line.includes("前端构建比源码旧"));
  assert.match(output, /前端构建比源码旧/);
  assert.match(output, /npm run build/, "要给出照做就能修好的命令");
});



test("配置文件供值,命令行压过文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-cfg-"));
  const filePort = 18000 + Math.floor(Math.random() * 500);
  const cliPort = filePort + 500;
  const config = join(dir, "serve.json");
  writeFileSync(config, JSON.stringify({
    port: filePort,
    "max-concurrent": 1,
  }));

  // 只用文件:应当听在文件配的端口上
  const fromFile = await run(
    ["--config", config, "--data", join(dir, "t1")],
    (line) => line.includes(`http://127.0.0.1:${filePort}`));
  assert.ok(fromFile.matched,
    `文件端口未生效,输出:\n${fromFile.output.slice(0, 800)}`);

  // 文件 + 命令行:命令行赢
  const fromCli = await run(
    ["--config", config, "--port", String(cliPort),
     "--data", join(dir, "t2")],
    (line) => line.includes(`http://127.0.0.1:${cliPort}`));
  assert.ok(fromCli.matched,
    `命令行未压过文件,输出:\n${fromCli.output.slice(0, 800)}`);
});



test("内核模式没有交付平台 → 拒绝启动,不起一台每单必卡的服务", async () => {
  // 执行契约固定把编译/UT/CodeCheck 交给流水线,流程必然停在
  // external_verify 等宿主递事实。没有平台就没人递:每一单都会卡在
  // 验证中。老的 --verify-via-pipeline 有这条守卫,退役那个开关时被
  // 一并删掉了——契约固定之后它反而更该在,因为没有别的形态可退。
  const dir = mkdtempSync(join(tmpdir(), "mfc-nokernelplat-"));
  const { code, output } = await run(
    ["--kernel-mode", "--data", join(dir, "tasks"), "--port", "0"],
    () => false, 30_000);
  assert.equal(code, 2, `应当拒绝启动,输出:\n${output.slice(0, 800)}`);
  assert.match(output, /内核模式需要交付平台在场/);
  assert.match(output, /--platform|--fake-platform/);
});



test("内核模式没有任务镜像 → 拒绝启动,不允许业务命令回退宿主", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-noisolation-"));
  const { code, output } = await run([
    "--kernel-mode",
    "--platform", "http://127.0.0.1:9",
    "--data", join(dir, "tasks"),
    "--port", "0",
  ], () => false, 30_000);
  assert.equal(code, 2, `应当拒绝启动,输出:\n${output.slice(0, 1200)}`);
  assert.match(output, /内核模式要求统一任务容器/);
  assert.match(output, /--isolate-image/);
  assert.match(output, /拒绝静默回退宿主机/);
});



test("旧 --verify-via-pipeline 仅提示弃用,不再切换执行语义", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-legacy-pipeline-"));
  const { output, matched } = await run(
    ["--verify-via-pipeline", "--data", join(dir, "tasks"), "--port", "0"],
    (line) => line.includes("--verify-via-pipeline 已弃用"));
  assert.ok(matched, `旧参数没有给迁移提示,输出:\n${output.slice(0, 1000)}`);
  assert.match(output, /已弃用并被忽略/);
  assert.doesNotMatch(output, /需要流水线在场/,
    "兼容参数不能再保留旧的条件分支");
});

