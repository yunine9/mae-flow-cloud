#!/usr/bin/env python3
"""Read-only local retrieval spike; creates and removes its own Milvus database.

Run with the memsearch venv Python. Does not open the production corpus.
Requires cached ONNX model; use HF_HUB_OFFLINE=1 to prohibit downloads.
Uses memsearch private APIs only for diagnostic channel comparisons.
"""
import argparse
import asyncio, importlib.util, json, time, tempfile
from pathlib import Path
from types import SimpleNamespace
import importlib.metadata
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
args=parser.parse_args()
spec=importlib.util.spec_from_file_location('sidecar', ROOT/'harness/memsearch-sidecar.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
# Synthetic adversarial cases based on this discussion; not production accuracy evidence.
DATA=[
('ut','repo-a','general','accepted','C++ 首次构建与 UT','先执行 mvn generate-sources -DDT_test=UT 拉取 UT 依赖，再执行 mvn compile -DDT_test=UT，后者同时编译并执行 UT。适用于 repo-a。'),
('callback','_platform','platform','accepted','异步回调对象生命周期','异步回调可能晚于对象销毁执行。使用弱引用并在访问对象前检查有效性；已有明确生命周期保证时不必重复处理。'),
('yaml','_platform','platform','accepted','YAML Consistence Check','出现 YAML content is inconsistent 或 yaml inconsistent 时，不分析和修改 YAML，直接请责任人决定处理方式。'),
('json','repo-a','general','accepted','JSON 配置校验','JSON 配置必须符合 schema，字段名称保持一致。'),
('old','repo-a','general','accepted','2.6B 超时配置','适用版本：2.6B。配置 request_timeout_ms，单位毫秒。此说明不适用于 2.7B。'),
('new','repo-a','general','accepted','2.7B 超时配置','适用版本：2.7B。配置 request_timeout_seconds，单位秒。此说明不适用于 2.6B。'),
('other','repo-b','general','accepted','C++ 首次构建与 UT','repo-b 使用 cmake --build build，再运行 ctest，不使用 Maven。'),
('draft','_platform','platform','pending','C++ 首次构建快速跳过测试','mvn compile -DskipTests=true。此条是未经确认的草稿。'),
('stopped','_archive','general','rejected','旧的 UT 命令','mvn compile -DDT_test=OLD。已停用。'),
('module','module-alarm','general','accepted','告警模块重复事件','告警模块跨仓复用：重复事件按事件 ID 和网元 ID 去重。'),
('symbol','repo-a','general','accepted','查询 FileKey','调用 ResolveFmaFileKey 获取 FMA 文件标识，不能用文件显示名替代。'),
('noise','_platform','platform','accepted','前端按钮布局','Windows 桌面 16:9，按钮必须具有清晰的可点击外观。'),
]
QUERIES=[('ut','repo-a','C++ 首次编译如何拉取并执行单元测试',['ut']),('ut-symbol','repo-a','-DDT_test=UT generate-sources',['ut']),('callback','repo-a','回调还没执行完，持有它的对象已经被释放怎么办',['callback']),('yaml','repo-a','YAML content is inconsistent',['yaml']),('yaml-cn','repo-a','流水线说配置内容不一致，应不应该直接修改配置',['yaml']),('v27','repo-a','2.7B request timeout 配置单位',['new']),('v26','repo-a','2.6B request timeout 配置单位',['old']),('other-repo','repo-b','C++ 首次构建 UT',['other']),('module','repo-a','告警重复事件如何去重',['module']),('symbol','repo-a','ResolveFmaFileKey',['symbol']),('unrelated','repo-a','办公室盆栽多久浇一次水',[]),('missing','repo-a','Rust Tokio 异步任务取消规范',[])]
async def main():
 with tempfile.TemporaryDirectory(prefix='mae-knowledge-probe-') as tmp:
  corpus=Path(tmp)/'corpus'; mapping={}; paths={}
  for i,(key,repo,scope,status,title,body) in enumerate(DATA):
   mid=f'c-probe-{i:06x}'; mapping[mid]=key
   p=corpus/repo/(mid+'.md');p.parent.mkdir(parents=True,exist_ok=True);paths[key]=p
   p.write_text(f'---\nrepo: {repo}\nscope: {scope}\nreview_status: {status}\n---\n# {title}\n{body}\n')
  start=time.perf_counter(); side=m.Sidecar(SimpleNamespace(corpus=str(corpus),milvus=str(Path(tmp)/'index.db'),provider='onnx',model=''))
  result={'memsearch':importlib.metadata.version('memsearch'),'milvus_lite':importlib.metadata.version('milvus-lite'),'pymilvus':importlib.metadata.version('pymilvus'),'model':side.ms._embedder.model_name,'startup_s':round(time.perf_counter()-start,3),'fixtures':'synthetic, based on conversation; no production corpus','queries':[]}
  start=time.perf_counter();result['index']=await side.reindex({});result['index_s']=round(time.perf_counter()-start,3)
  for name,repo,q,expected in QUERIES:
   start=time.perf_counter(); raw=await side.ms.search(q,top_k=8)
   hits=await side.search({'query':q,'repo':repo,'limit':5})
   row={'case':name,'query':q,'expected':expected,'raw': [{'key':mapping.get(m.memory_id_of(x['source'])),'score':round(x['score'],4)} for x in raw[:5]],'current_sidecar':[{'key':mapping[x['id']],'score':round(x['score'],4)} for x in hits['hits']],'two_searches_ms':round((time.perf_counter()-start)*1000)}
   result['queries'].append(row); print(json.dumps(row,ensure_ascii=False),flush=True)
  # Inspect real single-channel scores; RRF scores cannot express no-match.
  channels=[]
  for q in ['回调还没执行完，持有它的对象已经被释放怎么办','办公室盆栽多久浇一次水','-DDT_test=UT generate-sources']:
   vec=(await side.ms._embedder.embed([q]))[0]; store=side.ms._store
   one={'query':q}
   for name,field,data,metric in [('dense','embedding',vec,'COSINE'),('keyword','sparse_vector',q,'BM25')]:
    rows=store._client.search(collection_name=store._collection,data=[data],anns_field=field,search_params={'metric_type':metric},limit=3,output_fields=['source','content'])
    one[name]=[{'key':mapping.get(m.memory_id_of(h['entity']['source'])),'score':h['distance']} for h in rows[0]]
   channels.append(one)
  result['channels']=channels
  # Real repository documents, directly indexed without pretending they are memories.
  docs=corpus/'documents';docs.mkdir()
  for name in ['kernel-simplification','task-patrol']:
   p=docs/(name+'.md');p.write_text((ROOT/'skills'/name/'SKILL.md').read_text());await side.ms.index_file(p)
  result['real_documents']=[]
  for q,want in [('重复审批和 SHA 检查让任务不断返工，如何简化流程','kernel-simplification.md'),('内网 PI 定时巡检生产任务能不能自动修复和推进','task-patrol.md')]:
   hits=await side.ms.search(q,top_k=5)
   result['real_documents'].append({'query':q,'expected':want,'hits':[{'file':Path(h['source']).name,'score':h['score']} for h in hits]})
  # Revision and withdrawal on the actual sidecar API.
  p=paths['symbol'];p.write_text(p.read_text().replace('ResolveFmaFileKey','LookupFmaArtifactKey'));await side.ingest({'path':str(p)})
  revised=await side.search({'query':'LookupFmaArtifactKey','repo':'repo-a','limit':5})
  result['revision_new_text']=any('LookupFmaArtifactKey' in h['snippet'] for h in revised['hits'])
  result['revision_old_text']=any('ResolveFmaFileKey' in h['snippet'] for h in revised['hits'])
  p=paths['ut'];p.write_text(p.read_text().replace('review_status: accepted','review_status: rejected'))
  withdrawn=await side.search({'query':'-DDT_test=UT','repo':'repo-a','limit':5})
  result['withdrawn_returned']=any(mapping[h['id']]=='ut' for h in withdrawn['hits'])
  result['draft_indexed']=any(mapping.get(m.memory_id_of(x['source']))=='draft' for x in await side.ms.search('跳过测试 skipTests',top_k=20))
  args.output.parent.mkdir(parents=True,exist_ok=True)
  args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
  print('RESULT',json.dumps({k:v for k,v in result.items() if k!='queries'},ensure_ascii=False),flush=True)
asyncio.run(main())
