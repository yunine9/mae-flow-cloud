import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { saveKnowledgeDocument, readKnowledgeDocument } from '../src/knowledgeDocuments.ts';
import { collectSearchableKnowledge, KnowledgeSearch } from '../src/knowledgeSearch.ts';
import { knowledgeDocumentCatalog } from '../src/knowledgeDocumentCatalog.ts';
import { MemoryStore } from '../src/taskMemory.ts';
import { createBusinessModule } from '../src/businessModuleLibrary.ts';
import { readRepositoryKnowledgeFile } from '../src/repositorySkills.ts';
import { TaskService } from '../src/taskService.ts';
import { createTaskServer } from '../src/server.ts';
const context={repo:'repo',repositories:['https://code.example/team/repo.git'],moduleIds:[],productVersion:'2.7B'};
test('手册发布进入统一知识检索；模块、仓库、版本范围生效；修改和停用留痕',()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-documents-'));
 try {
  createBusinessModule(dir,{id:'module',name:'模块',description:'示例模块',owner:'owner',repositories:context.repositories},'owner');
  const doc=saveKnowledgeDocument(dir,{title:'规范.md',content:'# 规范\n## 文件\n释放资源',scope:'module',module_ids:['module'],technologies:['cpp'],product_versions:['2.7B']},'member');
  assert.ok(collectSearchableKnowledge(dir,context).assets.some(a=>a.id===doc.id));
  assert.equal(collectSearchableKnowledge(dir,{...context,productVersion:'2.6B'}).assets.length,0);
  assert.equal(collectSearchableKnowledge(dir,{...context,repositories:[]}).assets.length,0);
  const updated=saveKnowledgeDocument(dir,{content:'# 修订\n借用句柄不释放'},'another',doc.id);
  assert.notEqual(updated.revision,doc.revision);assert.equal(updated.history.at(-1)?.action,'替换文档');
  saveKnowledgeDocument(dir,{active:false},'member',doc.id);
  assert.equal(collectSearchableKnowledge(dir,context).assets.length,0);
  assert.equal(readKnowledgeDocument(dir,doc.id).history.length,3);
  assert.throws(()=>saveKnowledgeDocument(dir,{title:'坏文档',content:'x\0'},'member'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('真实 Git 按分支读取指定文件并保留 SHA，拒绝符号链接与路径穿越',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-git-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
 try{
  git('init','-q','-b','main');git('config','user.name','test');git('config','user.email','test@example.com');
  writeFileSync(join(dir,'manual.md'),'# main');symlinkSync('manual.md',join(dir,'link.md'));git('add','.');git('commit','-qm','first');
  git('checkout','-qb','release');writeFileSync(join(dir,'manual.md'),'# release\n规则');git('commit','-qam','release');
  const sha=git('rev-parse','HEAD');git('checkout','-q','main');
  const result=await readRepositoryKnowledgeFile({repository:dir,baseline:'release',path:'manual.md'});
  assert.equal(result.content,'# release\n规则');assert.equal(result.revision,sha);
  await assert.rejects(()=>readRepositoryKnowledgeFile({repository:dir,baseline:'main',path:'link.md'}));
  await assert.rejects(()=>readRepositoryKnowledgeFile({repository:dir,baseline:'main',path:'../manual.md'}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('索引排队、进行、失败、重试、就绪均来自实际索引作业；单文档试搜不串文档',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-status-'));
 try{
  const a=saveKnowledgeDocument(dir,{title:'a.md',content:'# 规则\n内容'},'member');
  const b=saveKnowledgeDocument(dir,{title:'b.md',content:'# 无关\n其他'},'member');
  let done!:(ok:boolean)=>void;
  let resolveNext=true;
  const sidecar={ingest:()=>resolveNext?new Promise<boolean>(r=>{done=r}):Promise.resolve(true),indexedSections:()=>2,
   search:async({sources}:any)=>{assert.equal(sources.length,1);assert.equal(sources[0].id,a.id);return [{id:a.id,heading:'规则',score:1}];}};
  const search=new KnowledgeSearch(dir,sidecar as any);
  const asset=collectSearchableKnowledge(dir,context).assets.find(x=>x.id===a.id)!;
  assert.equal(search.documentStatus(asset).state,'queued');
  const pending=search.searchDocument(a.id,'规则');await new Promise(r=>setImmediate(r));
  assert.equal(search.documentStatus(asset).state,'indexing');done(false);await pending;
  assert.equal(search.documentStatus(asset).state,'failed');resolveNext=false;
  assert.equal((await search.searchDocument(a.id,'规则')).hits[0].id,a.id);
  assert.equal(search.documentStatus(asset).state,'ready');
  assert.equal(search.documentStatus(collectSearchableKnowledge(dir,context).assets.find(x=>x.id===b.id)!).state,'queued');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('HTTP 上传、修改、停用和试搜接口，无侧车时明确不可用而非虚假成功',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-api-'));
 const service=new TaskService({dataDir:dir,provider:'test',model:'test',modelsJson:{},maxConcurrent:0});
 const server=createTaskServer(service);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as any).port}/knowledge-documents`;
 try{
  const post=(path:string,body:any)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const created=await post('',{title:'规范.md',content:'# 规则\n内容'});assert.equal(created.status,201);const doc=await created.json() as any;
  const list=await (await fetch(url)).json() as any;assert.equal(list.documents[0].indexing.state,'failed');assert.equal(list.documents[0].content,undefined);
  const trial=await (await post(`/${doc.id}/search`,{query:'规则'})).json() as any;assert.equal(trial.available,false);
  assert.equal((await post(`/${doc.id}`,{active:false})).status,200);
  assert.equal((await post(`/${doc.id}/search`,{query:'规则'})).status,400);
  assert.equal((await post('',{title:'x',content:''})).status,400);
 }finally{await service.shutdown();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test('知识库汇总已采纳经验，始终读取原记录，不另复制一份',()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-unified-'));
 try {
  const store=new MemoryStore(dir);
  const row=store.record({source:'agent_note',judged_by:'human',scope:'platform',repo:'r',paths:[],task:'task-1',evidence:'example',trigger:'读取文件',conclusion:'先检查句柄'});
  assert.equal(knowledgeDocumentCatalog(dir).documents.length,0);
  const accepted=store.review(row.id,'member',{decision:'accepted',revision:1});
  let docs=knowledgeDocumentCatalog(dir).documents;
  assert.equal(docs.length,1);assert.equal(docs[0].id,row.id);assert.equal(docs[0].form,'experience');
  store.review(row.id,'member',{decision:'accepted',revision:accepted.revision!,conclusion:'借用句柄不释放'});
  docs=knowledgeDocumentCatalog(dir).documents;assert.match(docs[0].content,/借用句柄不释放/);
  assert.equal(docs.length,1);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
