#!/usr/bin/env python3
"""Evaluate real memsearch section retrieval on an unchanged Google C++ manual.

Input is Markdown converted from Google's official cppguide.html (markdownify
1.2.3, heading_style=ATX, scripts/styles removed). No production corpus is used.
Run with the memsearch venv and HF_HUB_OFFLINE=1; --output keeps review artifacts.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import re
from contextlib import nullcontext
import time
from pathlib import Path
from types import SimpleNamespace
from knowledge_chunks import split_markdown

spec = importlib.util.spec_from_file_location('sidecar', Path(__file__).with_name('memsearch-sidecar.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
CASES = [
 ('对象所有权转移时应该使用哪种智能指针？', 'Ownership and Smart Pointers'),
 ('std::unique_ptr shared_ptr ownership', 'Ownership and Smart Pointers'),
 ('C++ 能不能用异常处理错误？有什么例外？', 'Exceptions'),
 ('C++ 头文件是否应该自己包含所需依赖？', 'Self-contained Headers'),
 ('头文件 include 的顺序是什么？', 'Names and Order of Includes'),
 ('C++ 类型转换 static_cast reinterpret_cast 使用规范', 'Casting'),
 ('函数内局部变量什么时候可以用 auto 推导类型？', 'Local variable type deduction'),
 ('C++ 类的成员变量应该如何命名？', 'Variable Names'),
 ('一行代码最多多少字符？超长字符串怎么办？', 'Line Length'),
 ('thread_local 变量初始化和析构有什么限制？', 'thread\\_local Variables'),
 ('构造函数里面能不能调用虚函数？', 'Doing Work in Constructors'),
 ('什么时候可以使用预处理宏？有没有替代方案？', 'Preprocessor Macros'),
 ('C++ 整数类型如何选择？', 'Integer Types'),
 ('可以直接 using namespace 导入整个命名空间吗？', 'Namespaces'),
]

async def main(args):
 if args.google:
  from urllib.request import urlopen
  from bs4 import BeautifulSoup
  from markdownify import markdownify
  html = urlopen('https://raw.githubusercontent.com/google/styleguide/gh-pages/cppguide.html', timeout=60).read().decode()
  soup = BeautifulSoup(html, 'html.parser')
  for tag in soup(['script', 'style']): tag.decompose()
  text = markdownify(str(soup), heading_style='ATX', code_language='cpp')
 else:
  text = args.document.read_text()
 chunks = split_markdown(text)
 args.output = args.output.resolve()
 args.output.mkdir(parents=True, exist_ok=True)
 (args.output/'google-cppguide.md').write_text(text)
 manifest = [dict(start_line=c.start_line, end_line=c.end_line, heading=c.heading, chars=len(c.content), content=c.content) for c in chunks]
 (args.output/'chunks.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
 lines = text.splitlines()
 covered = set()
 for c in chunks:
  assert c.content == '\n'.join(lines[c.start_line-1:c.end_line])
  assert not covered.intersection(range(c.start_line,c.end_line+1))
  covered.update(range(c.start_line,c.end_line+1))
 assert all(i+1 in covered for i,line in enumerate(lines) if line.strip())
 boundaries = {c.end_line for c in chunks}
 fence = None
 for number, line in enumerate(lines, 1):
  marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
  if marker:
   if fence and marker[1][0] == fence[0] and len(marker[1]) >= fence[1] and not marker[2].strip(): fence = None
   elif not fence: fence = (marker[1][0], len(marker[1]))
  assert number not in boundaries or not fence, f'Code fence cut at {number}'
 report = {'code_fences_intact': True, 'source': 'https://google.github.io/styleguide/cppguide.html', 'license': 'CC BY 3.0 Google',
  'sha256': hashlib.sha256(text.encode()).hexdigest(), 'lines': len(lines), 'chunks':len(chunks),
  'max_chunk_chars':max(len(c.content) for c in chunks), 'exact_source_ranges':True, 'queries':[]}
 with nullcontext(str(args.output/'index-work')) as tmp:
  corpus=Path(tmp)/'corpus'; corpus.mkdir(parents=True,exist_ok=True)
  doc=corpus/'google.md'
  doc.write_text('---\nknowledge_id: "google-cpp"\nasset_status: published\n---\n'+text)
  side=m.Sidecar(SimpleNamespace(corpus=str(corpus), milvus=str(Path(tmp)/'index.db'), provider='onnx',model=''))
  start=time.perf_counter(); report['index']=await side.ingest({'path':str(doc)}); report['index_seconds']=round(time.perf_counter()-start,2)
  for query, expected in CASES:
   start=time.perf_counter()
   hits=(await side.search({'query':query,'sources':[{'id':'google-cpp','path':str(doc)}],'limit':5}))['hits']
   row={'query':query,'expected_heading':expected,'pass':any(expected == h['heading'].split(' > ')[-1] for h in hits),
    'milliseconds':round((time.perf_counter()-start)*1000), 'hits':[{k:h.get(k) for k in ('heading','start_line','end_line','semantic_score')} for h in hits]}
   for h in hits:
    assert 1 <= h['start_line'] <= h['end_line'] <= len(doc.read_text().splitlines())
   report['queries'].append(row); print(json.dumps(row,ensure_ascii=False),flush=True)
  report['unrelated_queries'] = []
  for query in ['办公室盆栽多久浇一次水？', '如何预订下周去北京的机票？']:
   hits=(await side.search({'query':query,'sources':[{'id':'google-cpp','path':str(doc)}],'limit':5}))['hits']
   report['unrelated_queries'].append({'query': query, 'empty': not hits, 'headings': [h['heading'] for h in hits]})
  # A separate small fixture checks replacement without discarding the manual's
  # reusable index. This makes query refinements reproducible without reembedding.
  revision_doc=corpus/'revision.md'
  revision_doc.write_text('---\nknowledge_id: "revision-test"\nasset_status: published\n---\n# Old revision\nObsoleteRuleToken must disappear after replacement.\n')
  await side.ingest({'path':str(revision_doc)})
  old_hashes=side.ms._store.hashes_by_source(str(revision_doc))
  revision_doc.write_text('---\nknowledge_id: "revision-test"\nasset_status: published\n---\n# Replacement\nThis replaces the old manual completely.\n')
  await side.ingest({'path':str(revision_doc)})
  new_hashes=side.ms._store.hashes_by_source(str(revision_doc))
  report['stale_chunks_removed']=bool(new_hashes) and not old_hashes.intersection(new_hashes)
 report['passed']=sum(r['pass'] for r in report['queries']); report['total']=len(CASES)
 (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps({k:v for k,v in report.items() if k!='queries'},ensure_ascii=False),flush=True)
 if report['passed'] != report['total'] or not report['stale_chunks_removed'] or not all(q['empty'] for q in report['unrelated_queries']):
  raise SystemExit(1)

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 source=parser.add_mutually_exclusive_group(required=True)
 source.add_argument('--document',type=Path); source.add_argument('--google',action='store_true')
 parser.add_argument('--output',type=Path,required=True)
 asyncio.run(main(parser.parse_args()))
