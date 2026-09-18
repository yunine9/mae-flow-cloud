import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { exportKnowledge } from "../src/knowledgeExport.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { knowledgeDocumentRoute } from "../src/knowledgeDocumentRoutes.ts";

test("ZIP 可被标准解压器读取：中文同名、Windows 路径、正文元数据、停用与草稿隔离", () => {
  const dir=mkdtempSync(join(tmpdir(),"knowledge-export-"));
  try {
    const content="---\nlanguage: cpp\n---\n# 句柄\n使用后释放\n";
    const a=saveKnowledgeDocument(dir,{title:"../CON:组件.md",content,technologies:["cpp"],when_to_use:"文件句柄释放",scope:"repository",repositories:["https://code.example/a.git"],source:{repository:"https://code.example/a.git",branch:"main",path:"docs/a.md",revision:"abc"}},"alice");
    const b=saveKnowledgeDocument(dir,{title:a.title,content:"# 第二篇",research_source:{job_id:"cr-example",repository:"https://code.example/b.git",branch:"main",path:"src"}},"bob");
    const disabled=saveKnowledgeDocument(dir,{title:"停用",content:"不导出",active:false},"alice");
    mkdirSync(join(dir,"component-research","draft"),{recursive:true});writeFileSync(join(dir,"component-research","draft","record.json"),JSON.stringify({draft:"不导出草稿"}));
    const zip=join(dir,"export.zip");writeFileSync(zip,exportKnowledge(dir));
    const entries=JSON.parse(execFileSync("python3",["-c","import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist()}))",zip],{encoding:"utf8"}));
    assert.equal(Object.keys(entries).length,2);
    assert.equal(new Set(Object.keys(entries)).size,2);
    for(const name of Object.keys(entries)){assert.match(name,/^knowledge\/doc-/);assert.ok(!name.includes("../"));assert.ok(!/[<>:"\\|?*]/.test(name));}
    const first=Object.values(entries).find(v=>(v as string).startsWith(content)) as string;
    assert.ok(first);assert.match(first,/文件句柄释放/);assert.match(first,/docs\/a.md/);assert.match(first,/cpp/);
    assert.ok(Object.values(entries).some(v=>(v as string).includes("cr-example")));
    assert.throws(()=>exportKnowledge(dir,[disabled.id]),/停用/);
    assert.throws(()=>exportKnowledge(dir,["..\/secret"]),/不存在/);
    assert.throws(()=>exportKnowledge(dir,[]),/没有/);
    writeFileSync(zip,exportKnowledge(dir,[b.id,b.id]));
    assert.equal(execFileSync("python3",["-c","import zipfile,sys; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))",zip],{encoding:"utf8"}).trim(),"1");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("导出接口返回 ZIP 下载头，非法选择返回可读错误", async () => {
  const dir=mkdtempSync(join(tmpdir(),"knowledge-export-http-"));
  try {
    const doc=saveKnowledgeDocument(dir,{title:"规范",content:"# 正文"},"alice");
    let status=0, headers:any, data:any;
    const response:any={writeHead:(s:number,h:any)=>{status=s;headers=h;},end:(d:any)=>data=d};
    const invoke=(ids:unknown)=>knowledgeDocumentRoute({method:"POST"} as any,response,["knowledge-documents","export"],{options:{dataDir:dir}} as any,"alice",async()=>({ids}),(_r,s,v)=>{status=s;data=v;});
    await invoke([doc.id]);assert.equal(status,200);assert.equal(headers["Content-Type"],"application/zip");assert.match(headers["Content-Disposition"],/attachment/);assert.ok(Buffer.isBuffer(data));
    await invoke(["missing"]);assert.equal(status,400);assert.match((data as unknown as {error:string}).error,/不存在/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
