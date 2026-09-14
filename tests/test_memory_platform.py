"""Exercise the actual sidecar merge/filter path without loading an embedding model."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("sidecar", Path(__file__).parents[1] / "harness/memsearch-sidecar.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlatformMemoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_platform_and_repo_are_searched_separately_and_filtered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = []
            for folder, ident, repo, scope in [
                ("a", "c-a-111", "a", "general"),
                ("ab", "c-b-222", "ab", "general"),
                ("_platform", "c-c-333", "origin", "platform"),
            ]:
                path = root / folder / (ident + ".md")
                path.parent.mkdir(exist_ok=True)
                path.write_text(f'---\nrepo: {repo}\nscope: {scope}\npaths: ["src/x"]\n---\nFact')
                records.append({"source": str(path), "score": 1, "content": ident})
            calls = []

            class Index:
                async def search(self, query, top_k, source_prefix):
                    calls.append(str(source_prefix))
                    # Simulate a prefix index, including the a/ab collision.
                    return [row for row in records if row["source"].startswith(str(source_prefix))]

            sidecar = module.Sidecar.__new__(module.Sidecar)
            sidecar.corpus = root
            sidecar.ms = Index()
            result = await sidecar.search({"query": "current evidence", "repo": "a"})
            self.assertEqual({hit["id"] for hit in result["hits"]}, {"c-a-111", "c-c-333"})
            self.assertEqual(calls, [str(root / "a"), str(root / "_platform")])
            result = await sidecar.search({"query": "current evidence", "repo": "a", "path_prefix": "different"})
            self.assertEqual([hit["id"] for hit in result["hits"]], ["c-c-333"])


if __name__ == "__main__":
    unittest.main()
