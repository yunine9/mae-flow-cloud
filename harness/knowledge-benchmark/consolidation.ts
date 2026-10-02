import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeConsolidation } from '../../src/knowledgeConsolidation.ts';
import { runKnowledgeConsolidationAgent } from '../../src/knowledgeConsolidationAgent.ts';
import { saveKnowledgeDocument } from '../../src/knowledgeDocuments.ts';
import { KnowledgeSearch } from '../../src/knowledgeSearch.ts';
import { createKnowledgeTool } from '../../src/knowledgeTools.ts';
import { consolidationFixtures } from './consolidation-fixtures.ts';
import type { CaseResult } from './scoring.ts';

export async function runConsolidationCases(options:{out:string;models:string;provider:string;model:string;timeoutMs:number;signal:AbortSignal;record:(row:CaseResult)=>void}) {
  for(const fixture of consolidationFixtures) {
    options.signal.throwIfAborted();
    const root=join(options.out,'consolidation',fixture.id),data=join(root,'data');mkdirSync(data,{recursive:true});
    const docs=fixture.documents.map(doc=>saveKnowledgeDocument(data,{...doc,technologies:['cpp']},'benchmark'));
    const search=new KnowledgeSearch(data),context={repo:'shared',repositories:[],moduleIds:[]};
    let failure:unknown,output='',calls=0;
    const controller=new AbortController(),abort=()=>controller.abort();options.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,options.timeoutMs),started=performance.now();
    const service=new KnowledgeConsolidation(data,async input=>{
      calls++;
      const abortRun=()=>{void service.shutdown();};controller.signal.addEventListener('abort',abortRun,{once:true});
      try {controller.signal.throwIfAborted();output=await runKnowledgeConsolidationAgent(input,{choice:{provider:options.provider,model:options.model},json:JSON.parse(readFileSync(options.models,'utf8'))});writeFileSync(join(root,'output.txt'),output);return output;}
      catch(error){failure=error;throw error;}
      finally {controller.signal.removeEventListener('abort',abortRun);rmSync(join(input.root,'agent','models.json'),{force:true});}
    });
    const emit=(id:string,passed:boolean,details:Record<string,unknown>={})=>options.record({id:`consolidation/${fixture.id}/${id}`,kind:'consolidation',passed,elapsed_ms:Math.round(performance.now()-started),...details});
    console.log(`开始 consolidation/${fixture.id}`);
    try {
      service.start('benchmark');
      while(service.view().jobs.some(j=>j.state==='running')) {controller.signal.throwIfAborted();await new Promise(r=>setTimeout(r,50));}
      if(failure) throw failure;
      const topics=service.view().topics.filter(t=>t.pending);
      if(!topics.length) throw new Error('未产生待审专题');
      const text=topics.map(t=>t.pending!.content).join('\n');
      const missing=fixture.facts.filter(f=>!text.includes(f));
      emit('facts-and-conflicts',missing.length===0&&(!fixture.conflict||topics.some(t=>t.pending!.conflicts.length>0)),{missing,review_required:true,topics});
      emit('pending-not-searchable',topics.every(t=>!search.read(context,t.id)));
      // Simulated reviewer adoption exercises the publishing path, not automatic production approval.
      for(const t of topics) service.act(t.id,'adopt',{revision:t.revision,title:t.pending!.title,content:t.pending!.content,covered:t.pending!.sources.filter(s=>s.full).map(s=>s.id)},'benchmark-reviewer');
      emit('published-searchable',topics.every(t=>!!search.read(context,t.id)));
      const dependent=topics.filter(t=>t.pending!.sources.some(s=>s.id===docs[0].id));
      const old=search.read(context,(dependent[0]??topics[0]).id)!;
      saveKnowledgeDocument(data,{content:docs[0].content+'\n新增版本：旧结论需要重新核对。'},'benchmark',docs[0].id);
      emit('source-change-invalidates',dependent.length>0&&dependent.every(t=>!search.read(context,t.id))&&!!search.read(context,docs[0].id));
      const tool:any=createKnowledgeTool({service:()=>search,context:()=>context});
      const stale=await tool.execute('old-topic',{action:'read',id:old.id,revision:old.revision});
      emit('old-topic-not-readable',!stale.details?.id,{response:stale});
      saveKnowledgeDocument(data,{active:false},'benchmark',docs[1].id);
      emit('disabled-source-not-readable',!search.read(context,docs[1].id));
      writeFileSync(join(root,'fixture.json'),JSON.stringify({fixture,document_ids:docs.map(d=>d.id),model_calls:calls},null,2));
    } catch(error) {emit('execution',false,{outcome:'execution_error',error:String(error)});}
    finally {clearTimeout(timer);options.signal.removeEventListener('abort',abort);await service.shutdown();}
  }
}
