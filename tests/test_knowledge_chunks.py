import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'harness'))
from knowledge_chunks import split_markdown

class ChunksTests(unittest.TestCase):
    def assert_ranges(self, text, chunks):
        lines = text.splitlines()
        for c in chunks:
            self.assertEqual(c.content, '\n'.join(lines[c.start_line-1:c.end_line]))
        covered = {n for c in chunks for n in range(c.start_line, c.end_line+1)}
        self.assertEqual(len(covered), sum(c.end_line-c.start_line+1 for c in chunks))

    def test_rule_example_and_exception_stay_together(self):
        text = '# 文件组件\n\n## 写文件\n必须释放资源。\n\n### 示例\n```cpp\n# not a heading\n\nwrite();\n```\n\n### 例外\n调用者借用句柄时不要释放。\n\n## 读文件\n只读。'
        chunks = split_markdown(text)
        target = next(c for c in chunks if 'write();' in c.content)
        self.assertIn('必须释放', target.content)
        self.assertIn('不要释放', target.content)
        self.assertEqual(target.heading, '文件组件 > 写文件')
        self.assert_ranges(text, chunks)

    def test_long_topic_splits_outside_fences_and_preserves_every_line(self):
        text = '# 手册\n\n## 组件\n' + ('正文一段。\n\n' * 30) + '~~~cpp\n# 假标题\n\n' + 'code();\n' * 30 + '~~~\n\n例外不得遗漏。\n'
        chunks = split_markdown(text, max_chars=80)
        block = next(c for c in chunks if '~~~cpp' in c.content)
        self.assertEqual(block.content.count('~~~'), 2)
        self.assertIn('code();', block.content)
        self.assert_ranges(text, chunks)
        covered = {n for c in chunks for n in range(c.start_line,c.end_line+1)}
        self.assertTrue(all(i+1 in covered for i,line in enumerate(text.splitlines()) if line.strip()))

    def test_frontmatter_setext_crlf_and_unclosed_code(self):
        text = '---\r\nproduct_versions: ["2.7B"]\r\n---\r\n手册\r\n====\r\n\r\n接口\r\n----\r\n\r\n```cpp\r\n# 假标题\r\nend'
        chunks = split_markdown(text, max_chars=10)
        self.assert_ranges(text, chunks)
        self.assertTrue(all(c.start_line >= 4 for c in chunks))
        self.assertTrue(any(c.heading == '手册 > 接口' for c in chunks))
        self.assertTrue(any('```cpp\n# 假标题\nend' in c.content for c in chunks))

    def test_indented_code_and_table_are_not_cut_at_soft_budget(self):
        text = '# 手册\n\n## 示例\n\n    first();\n\n    second();\n\n说明。\n\n| 参数 | 含义 |\n| --- | --- |\n| id | 标识 |\n\n结束。'
        chunks = split_markdown(text, max_chars=12)
        block = next(c for c in chunks if 'first();' in c.content)
        self.assertIn('second();', block.content)
        table = next(c for c in chunks if '| 参数' in c.content)
        self.assertIn('| id |', table.content)
        self.assert_ranges(text, chunks)

if __name__ == '__main__': unittest.main()
