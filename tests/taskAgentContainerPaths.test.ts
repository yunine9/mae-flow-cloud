import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import type { TaskContainer } from "../src/containerRuntime.ts";
import { repairTaskAgentFileOwnership } from "../src/taskAgentFiles.ts";

const image = process.env.MFC_PATH_CONTAINER_IMAGE;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("真容器：切目录后写回执/MR 回复，读流水线/Build-Fix，与宿主互相可见", {
  skip: image ? false : "需要 MFC_PATH_CONTAINER_IMAGE 指定本机构建镜像",
}, async () => {
  // macOS Docker 的 /var/folders 不是共享目录；在仓内建独立现场，结束删除。
  const dataDir = mkdtempSync(join(process.cwd(), ".agent-path-probe-"));
  const user = process.env.MFC_PATH_CONTAINER_USER ?? "501:20";
  const service: any = new TaskService({ dataDir, maxConcurrent: 0,
    provider: "test", model: "test", modelsJson: {}, isolation: { image: image!, user, cacheRoot: join(dataDir, "cache") } });
  let container: TaskContainer | undefined;
  try {
    const summary = service.create("容器路径互通");
    const task = service.tasks.get(summary.id);
    const workspace = summary.workspace;
    const cwd = join(workspace, "repositories");
    const artifacts = join(cwd, ".mae-flow-work", "task-2");
    mkdirSync(artifacts, { recursive: true });
    task.cwd = cwd;
    task.containerWorkspace = cwd;
    container = await service.startCodingContainer(task) as TaskContainer;
    const receipts = join(workspace, "reviews", "local-receipts.json");
    const replies = join(workspace, "review_replies.md");
    const pipeline = join(workspace, "pipeline", "failure.txt");
    const prepush = join(workspace, "prepush", "failure.txt");
    writeFileSync(pipeline, "pipeline-probe\n");
    writeFileSync(prepush, "prepush-probe\n");
    let output = "";
    const result = await container.exec([
      `cd ${quote(artifacts)}`,
      `printf '%s' '{"receipts":[]}' > ${quote(receipts)}`,
      `printf '%s' '[review-1] done' > ${quote(replies)}`,
      `cat ${quote(pipeline)} ${quote(prepush)}`,
      `test ! -e ${quote(join(workspace, "task.json"))}`,
      `test ! -e ${quote(join(workspace, "pi-agent", "models.json"))}`,
    ].join(" && "), cwd, { timeout: 30, onData: (chunk: Buffer) => { output += chunk.toString(); } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /pipeline-probe/);
    assert.match(output, /prepush-probe/);
    assert.equal(readFileSync(receipts, "utf-8"), '{"receipts":[]}');
    assert.equal(readFileSync(replies, "utf-8"), "[review-1] done");
    // 同一个容器里，宿主 Write 后 Bash 仍能接着写同一份文件。
    writeFileSync(receipts, "host-write");
    repairTaskAgentFileOwnership({ workspace, cwd, path: receipts, user });
    const next = await container.exec(`printf '%s' 'container-write' > ${quote(receipts)}`,
      artifacts, { timeout: 30, onData: () => {} });
    assert.equal(next.exitCode, 0);
    assert.equal(readFileSync(receipts, "utf-8"), "container-write");
  } finally {
    await container?.stop();
    await service.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
