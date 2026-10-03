import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments, listKnowledgeDocumentVersions } from "../src/knowledgeDocuments.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("生产线验收4/F6：第一篇正式记录 rename 后真 kill -9，重启只归档已生效版本", {
  timeout: 35_000,
  skip: !constants.signals.SIGSTOP || !constants.signals.SIGKILL ? "当前系统不支持 POSIX SIGSTOP/SIGKILL，不能执行真 kill -9" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-crash-publish-")), marker = join(dir, "formal-renamed.json");
  const entry = pathToFileURL(fileURLToPath(new URL("../src/domainKnowledgeExtraction.ts", import.meta.url))).href;
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  // 只在测试子进程替换 Node 的文件系统边界，不给生产发布流程增加测试开关。
  const source = `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const dir=${JSON.stringify(dir)},marker=${JSON.stringify(marker)};
let jobId,stopped=false;
const rename=fs.renameSync;
fs.renameSync=function(from,to){
  const result=rename.apply(this,arguments);
  if(!stopped&&/[\\/]knowledge-documents[\\/]kd-[a-f0-9-]{36}\\.json$/.test(String(to))){
    stopped=true;
    const formal=JSON.parse(fs.readFileSync(to,'utf8'));
    fs.writeFileSync(marker,JSON.stringify({job_id:jobId,id:formal.id,revision:formal.revision}));
    process.kill(process.pid,'SIGSTOP');
  }
  return result;
};
syncBuiltinESMExports();
const startup=setTimeout(()=>{console.error('子进程发布超过10秒预算');process.exit(9)},10000);
try{
  const {DomainKnowledgeExtraction}=await import(${JSON.stringify(entry)});
  const service=new DomainKnowledgeExtraction(dir,async input=>{
    for(const id of ['one','two'])input.save({id,title:id==='one'?'第一篇领域规则':'第二篇领域规则',target_id:'domain',path:'domains/'+id+'.md',layer:'domain',content:'# '+id+'\\n有效规则正文',sources:'固定版本源码'}, {revision:'a'.repeat(40),content:null});
    return '研究完成';
  },{publish:async()=>{throw new Error('硬崩溃前不应开始归档')}});
  const job=service.create({title:'订单域',scope:'核对订单规则',issue_no:'REQ-CRASH',issue_description:'订单领域知识归档',repositories:[],knowledge_target:{repository:'https://example.test/knowledge.git',branch:'main',docs_path:'domains'}},'alice');
  jobId=job.id;
  const deadline=Date.now()+5000;
  while(service.get(job.id).status!=='done'){
    if(Date.now()>=deadline)throw new Error('测试研究未在5秒内完成');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  await service.publish(job.id,'alice');
  throw new Error('未在第一篇正式记录写成后暂停');
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1}
finally{clearTimeout(startup)}
`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => { if (output.length < 8192) output += chunk.toString("utf8").slice(0, 8192 - output.length); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);
  let service: DomainKnowledgeExtraction | undefined;
  try {
    await until(() => {
      if (existsSync(marker)) return true;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`子进程未到达正式写入暂停点：${output}`);
      return false;
    }, `未在10秒内达到正式记录 rename 后的暂停点：${output}`);
    assert.ok(child.pid);
    assert.equal(child.kill("SIGKILL"), true);
    assert.equal((await within(closed, 5000, "SIGKILL 后子进程未退出")).signal, "SIGKILL");

    const checkpoint = JSON.parse(readFileSync(marker, "utf8")) as { job_id: string; id: string; revision: string };
    const formal = listKnowledgeDocuments(dir);
    assert.equal(formal.length, 1, "必须真正杀在两篇之间，仅第一篇已生效");
    assert.equal(formal[0].id, checkpoint.id); assert.equal(formal[0].revision, checkpoint.revision);
    assert.equal(formal[0].research_source?.document_id, "one");
    const path = join(dir, "domain-extraction", checkpoint.job_id, "job.json"), disk = JSON.parse(readFileSync(path, "utf8")) as DomainKnowledgeJob;
    for (const document of formal) {
      const exact = (row: { knowledge_document_id?: string; published_revision?: string }) => row.knowledge_document_id === document.id && row.published_revision === document.revision;
      const pending = disk.archive_batches?.filter(batch => ["pending", "running"].includes(batch.state)) ?? [];
      assert.ok(disk.documents.some(exact) || pending.some(batch => batch.documents.some(exact)), `${document.id}@${document.revision} 已生效却没有磁盘发布记录`);
      assert.ok(pending.some(batch => batch.documents.some(row => exact(row) && row.content === document.content)), "每篇已生效正式知识必须有精确版本的可恢复归档批次");
    }
    const versionsBefore = listKnowledgeDocumentVersions(dir, checkpoint.id).map(version => version.document.revision);
    assert.deepEqual(versionsBefore, [checkpoint.revision]);
    const seen: DomainPublication["documents"][] = [];
    let researchCalls = 0;
    service = new DomainKnowledgeExtraction(dir, async () => { researchCalls++; throw new Error("重启不应重新研究"); }, {
      publish: async (job, target) => {
        const documents: DomainPublication["documents"] = job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision }));
        seen.push(documents);
        return { target_id: target.id, branch: "codex/recovered-crash", state: "opened", url: "https://example.test/mr/1", mr_id: 1, documents };
      },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(seen.length, 0, "重启不能自动启动Git/MR");
    const recovered = service.get(checkpoint.job_id);
    assert.equal(recovered.documents.find(document => document.id === "one")?.published_revision, checkpoint.revision);
    assert.equal(recovered.documents.find(document => document.id === "two")?.published_revision, undefined);
    await service.createArchive(checkpoint.job_id, { issue_no: "REQ-CRASH", expected_revisions: service.previewArchive(checkpoint.job_id).expected_revisions }, "alice");
    assert.equal(researchCalls, 0);
    assert.equal(seen.length, 1, "同一已生效版本只归档一次");
    assert.deepEqual(seen[0].map(document => [document.id, document.knowledge_document_id, document.knowledge_revision, document.content]), [["one", checkpoint.id, checkpoint.revision, formal[0].content]], "未写成的第二篇不得在重启后自动入库或归档");
    assert.deepEqual(listKnowledgeDocuments(dir), formal, "重启恢复发布记录，人工归档不重写或丢失正式知识");
    assert.deepEqual(listKnowledgeDocumentVersions(dir, checkpoint.id).map(version => version.document.revision), versionsBefore, "重启不能重复生成正式版本");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await within(closed, 5000, "测试清理期间子进程未退出");
    if (service) await within(service.shutdown(), 5000, "测试清理期间管理器未关停");
    rmSync(dir, { recursive: true, force: true });
  }
});
