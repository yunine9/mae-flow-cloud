"""Deterministic boundary tests; actual model quality is tested by the local probe."""
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("retrieval", Path(__file__).parents[1] / "harness/knowledge_retrieval.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class RetrievalTests(unittest.IsolatedAsyncioTestCase):
    async def run_search(self, query, dense, keywords, sources, model=m.BGE_MODEL):
        calls = []
        class Client:
            def get_collection_stats(self, _): return {"row_count": 20}
            def search(self, **kwargs):
                calls.append(kwargs)
                return [dense if kwargs['anns_field'] == 'embedding' else keywords]
        async def embed(_): return [[1, 0]]
        ms = SimpleNamespace(_embedder=SimpleNamespace(model_name=model, embed=embed),
                             _store=SimpleNamespace(_client=Client(), _collection='test'))
        hits = await m.retrieve(ms, query, sources, 5)
        for call in calls:
            self.assertEqual(json.loads(call['filter'].removeprefix('source in ')), list(sources))
        return hits

    def hit(self, source, score, content, chunk='1'):
        return {'distance': score, 'entity': {'source': source, 'content': content,
                                               'heading': '', 'chunk_hash': source + chunk}}

    async def test_irrelevant_nearest_neighbor_is_not_an_answer(self):
        hits = await self.run_search('盆栽浇水', [self.hit('a', .38, 'C++ 回调')], [], {'a': {}})
        self.assertEqual(hits, [])

    async def test_no_cross_scope_rank_tie_and_one_asset_per_result(self):
        dense = [self.hit('global', .8, '正确结论'), self.hit('global', .79, '正确结论的例外', '2'), self.hit('repo', .51, '其他内容')]
        hits = await self.run_search('具体问题', dense, [], {'global': {}, 'repo': {}})
        self.assertEqual([h['source'] for h in hits], ['global', 'repo'])

    async def test_exact_code_identifier_is_not_lost_to_semantic_floor(self):
        row = self.hit('a', .2, 'ResolveFmaFileKey 返回文件标识')
        hits = await self.run_search('ResolveFmaFileKey', [row], [row], {'a': {}})
        self.assertEqual([h['source'] for h in hits], ['a'])
        # A generic English term alone is not a reason to bypass the floor.
        self.assertEqual(await self.run_search('callback', [self.hit('a', .2, 'callback')], [], {'a': {}}), [])

    async def test_other_model_does_not_borrow_bge_threshold(self):
        hits = await self.run_search('问题', [self.hit('a', .4, '候选')], [], {'a': {}}, model='another-model')
        self.assertEqual(len(hits), 1)

if __name__ == '__main__': unittest.main()
