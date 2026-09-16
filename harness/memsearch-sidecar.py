#!/usr/bin/env python3
"""任务记忆检索旁路进程(docs/knowledge-memory-design.md §7)。

宿主是 Node,memsearch 是 Python;CLI 每次冷启动要重载 ONNX 模型(内网实测
2.8s、本机 1.4s),所以常驻:宿主起我一次,stdin 一行一个 JSON 请求,stdout
一行一个 JSON 应答,按 id 配对。四个动作:

  {"id":1,"op":"health"}
  {"id":2,"op":"ingest","path":"<md 绝对路径>"}
  {"id":3,"op":"search","query":"...","repo":"notify-service","path_prefix":"src/x","limit":8}
  {"id":4,"op":"expand","memory_id":"c-..."}

纪律:
- 任何一条请求出错只回 {"id","error"},进程不退;stdin 断了才退。
- 不写 stderr 以外的东西到 stdout——stdout 是协议通道。
- 正本是 md 文件,这里只管索引;删掉 milvus.db 由宿主重跑 ingest 全量重建。

用法(宿主拉起):
  <venv>/bin/python harness/memsearch-sidecar.py --corpus <data>/corpus \\
      --milvus <data>/memsearch/milvus.db [--provider onnx] [--model ...]
"""

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from knowledge_retrieval import retrieve, index_document


def log(message: str) -> None:
    sys.stderr.write(f"[memsearch-sidecar] {message}\n")
    sys.stderr.flush()


def reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


MEMORY_ID = re.compile(r"^(c-[a-z0-9]+-[a-f0-9]+)\.md$")


def memory_id_of(source: str) -> str:
    match = MEMORY_ID.match(Path(source).name)
    return match.group(1) if match else ""


def read_front(path: Path) -> dict:
    """只读 frontmatter 的几个定位键,给检索结果贴标签用;读不动就空。"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}
    front: dict = {}
    for line in text[4:end].splitlines():
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if key in ("repo", "judged_by", "source", "scope", "at", "task", "phase", "review_status", "knowledge_id", "asset_status"):
            front[key] = json.loads(value) if value.startswith('"') else value
        elif key == "paths":
            try:
                front["paths"] = json.loads(value)
            except json.JSONDecodeError:
                front["paths"] = []
        elif key == "line":
            try:
                front["line"] = int(value)
            except ValueError:
                pass
    return front


class Sidecar:
    def __init__(self, args: argparse.Namespace) -> None:
        from memsearch import MemSearch  # 延迟导入:模型加载几秒,先把进程起来

        self.corpus = Path(args.corpus).expanduser().resolve()
        self.corpus.mkdir(parents=True, exist_ok=True)
        Path(args.milvus).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.ms = MemSearch(
            [str(self.corpus)],
            embedding_provider=args.provider,
            embedding_model=args.model or None,
            milvus_uri=args.milvus,
            reranker_model="",
            # 台账与目录摘要不是记忆,归档的不再命中(reindex 时生效)。
            exclude=["index.jsonl", "ledger.jsonl", "_archive/**", "_digests/**"],
        )

    async def health(self, _req: dict) -> dict:
        return {"ok": True, "corpus": str(self.corpus)}

    async def ingest(self, req: dict) -> dict:
        path = Path(str(req.get("path", ""))).expanduser().resolve()
        if not str(path).startswith(str(self.corpus) + os.sep):
            raise ValueError("只索引语料目录里的文件")
        if not path.is_file():
            raise ValueError(f"文件不存在: {path}")
        if not self.indexable(path):
            return {"ok": True, "chunks": 0}
        count = await self.ensure_indexed(path)
        return {"ok": True, "chunks": count}

    async def reindex(self, _req: dict) -> dict:
        # 候选留档不参与向量索引。旧索引命中仍由搜索和 Cloud 正本过滤。
        count = 0
        for path in self.corpus.rglob("*.md"):
            if self.indexable(path):
                count += await self.ensure_indexed(path)
        return {"ok": True, "chunks": count}

    async def ensure_indexed(self, path: Path) -> int:
        stat = path.stat()
        fingerprint = (stat.st_mtime_ns, stat.st_size)
        cache = getattr(self, "_indexed_files", {})
        if cache.get(str(path)) == fingerprint:
            return 0
        count = await index_document(self.ms, path)
        cache[str(path)] = fingerprint
        self._indexed_files = cache
        return count

    def indexable(self, path: Path) -> bool:
        resolved = path.resolve()
        if not resolved.is_relative_to(self.corpus) or "_archive" in resolved.relative_to(self.corpus).parts:
            return False
        front = read_front(resolved)
        return front.get("review_status") == "accepted" or (
            bool(front.get("knowledge_id")) and front.get("asset_status") == "published")

    async def search(self, req: dict) -> dict:
        query = str(req.get("query", "")).strip()
        if not query:
            raise ValueError("query 不能为空")
        limit = max(1, min(int(req.get("limit", 8) or 8), 20))
        repo = str(req.get("repo", "")).strip()
        path_prefix = str(req.get("path_prefix", "")).strip()
        sources = {}
        # Cloud supplies an exact, currently eligible catalog for unified search.
        # Legacy clients use the same retrieval engine with memory-only scope.
        supplied = req.get("sources")
        if supplied is not None and not isinstance(supplied, list):
            raise ValueError("sources 必须是数组")
        paths = [Path(item["path"]) for item in supplied] if supplied is not None else self.corpus.rglob("*.md")
        supplied_ids = {str(Path(item["path"]).resolve()): item["id"] for item in supplied or []}
        for path in paths:
            path = path.resolve()
            if not path.is_file() or not self.indexable(path):
                continue
            front = read_front(path)
            ident = front.get("knowledge_id") or memory_id_of(str(path))
            if not ident:
                continue
            if supplied is not None:
                if supplied_ids.get(str(path)) != ident:
                    continue
            else:
                if front.get("knowledge_id"):
                    continue
                if repo and front.get("repo") != repo and front.get("scope") != "platform":
                    continue
                if path_prefix and front.get("scope") != "platform" and not any(
                    str(p).startswith(path_prefix) for p in front.get("paths", [])
                ):
                    continue
            sources[str(path)] = {"id": ident, **front}
        for source in sources:
            await self.ensure_indexed(Path(source))
        rows = await retrieve(self.ms, query, sources, limit)
        hits = []
        for row in rows:
            source = row["source"]
            # Recheck current status, not just index metadata.
            if not self.indexable(Path(source)):
                continue
            front = sources[source]
            hits.append({
                **{k: front[k] for k in ("id", "repo", "judged_by", "scope", "at", "task", "paths", "line", "phase") if k in front},
                "score": row["score"], "semantic_score": row["semantic_score"],
                "heading": row.get("heading", ""), "snippet": str(row.get("content", ""))[:1200],
                "file": source, "chunk_hash": row.get("chunk_hash", ""),
            })
        return {"ok": True, "hits": hits}

    async def expand(self, req: dict) -> dict:
        memory_id = str(req.get("memory_id", "")).strip()
        if not MEMORY_ID.match(memory_id + ".md"):
            raise ValueError("memory_id 形状不对")
        for path in self.corpus.rglob(f"{memory_id}.md"):
            if path.is_file() and "_archive" not in path.relative_to(self.corpus).parts and read_front(path).get("review_status") == "accepted":
                # 键名别叫 id:应答的 id 是请求配对号,撞了宿主就对不上号。
                return {"ok": True, "memory_id": memory_id,
                        "content": path.read_text(encoding="utf-8", errors="replace")}
        raise ValueError(f"记忆 {memory_id} 不存在")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--milvus", required=True)
    parser.add_argument("--provider", default="onnx")
    parser.add_argument("--model", default="")
    args = parser.parse_args()
    try:
        sidecar = Sidecar(args)
    except Exception as error:  # noqa: BLE001 - 起不来就说清楚再退
        reply({"id": 0, "error": f"sidecar 启动失败: {error!r}"})
        log(f"启动失败: {error!r}")
        sys.exit(2)
    reply({"id": 0, "ok": True, "ready": True})
    ops = {"health": sidecar.health, "ingest": sidecar.ingest, "reindex": sidecar.reindex,
           "search": sidecar.search, "expand": sidecar.expand}
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as error:
            reply({"id": None, "error": f"请求不是 JSON: {error}"})
            continue
        req_id = req.get("id")
        op = ops.get(str(req.get("op", "")))
        if op is None:
            reply({"id": req_id, "error": f"未知操作: {req.get('op')}"})
            continue
        try:
            result = await op(req)
            reply({"id": req_id, **result})
        except Exception as error:  # noqa: BLE001 - 单条失败不许拖死进程
            reply({"id": req_id, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    asyncio.run(main())
