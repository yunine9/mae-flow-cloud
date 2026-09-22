"""Memsearch adapter: one candidate set, real cosine evidence, asset deduplication.

Private memsearch access is isolated here (verified with 0.4.19). An incompatible
backend raises and the existing sidecar protocol reports unavailable, never
silently changes search semantics. No task workflow decisions are made here.
"""
import json
import math
import re
from memory_runtime import phase, check_deadline

# Conservative noise floor for the locally evaluated model only; not confidence.
# Other models retain candidates until calibrated instead of borrowing this scale.
BGE_MODEL = "gpahal/bge-m3-onnx-int8"
BGE_NOISE_FLOOR = 0.50


async def retrieve(ms, query, sources, limit, sections=False):
    if not sources:
        return []
    check_deadline()
    with phase("embed_ms"):
        vector = (await ms._embedder.embed([query]))[0]
    check_deadline()
    store = ms._store
    if int(store._client.get_collection_stats(store._collection).get("row_count", 0)) == 0:
        return []
    # Exact source list applies before top-k. Neither another repo nor stale
    # index records can consume the candidate budget. JSON escapes filter values.
    expression = "source in " + json.dumps(list(sources), ensure_ascii=False)
    depth = max(40, limit * 8)
    fields = ["source", "content", "heading", "chunk_hash", "start_line", "end_line"]
    def search(field, data, metric):
        rows = store._client.search(
            collection_name=store._collection, data=[data], anns_field=field,
            search_params={"metric_type": metric}, filter=expression,
            limit=depth, output_fields=fields,
        )
        return rows[0] if rows else []
    while True:
        check_deadline()
        with phase("dense_ms"):
            dense = search("embedding", vector, "COSINE")
        check_deadline()
        with phase("keyword_ms"):
            keyword = search("sparse_vector", query, "BM25")
        unique = {h["entity"]["source"] for h in dense + keyword}
        if len(unique) >= min(limit, len(sources)) or max(len(dense), len(keyword)) < depth or depth >= 2048:
            break
        depth = min(depth * 2, 2048)
    # Rank at document level: a long report must not occupy twenty ranking
    # positions before a short, relevant experience gets its first vote.
    def first_per_source(rows):
        seen = set()
        result = []
        for row in rows:
            source = row["entity"]["source"]
            if source not in seen:
                seen.add(source)
                result.append(row)
        return result
    if not sections:
        dense = first_per_source(dense)
        keyword = first_per_source(keyword)
    def result_key(entity):
        return entity.get("chunk_hash", entity["source"]) if sections else entity["source"]
    # Exact code identifiers/flags survive a weak semantic score; ordinary
    # words and version numbers do not qualify as identifier evidence.
    anchors = [token for token in re.findall(r"[A-Za-z_][A-Za-z0-9_:.-]*", query)
               if len(token) >= 6 and ("_" in token or "-" in token or "::" in token
                                      or re.search(r"[a-z][A-Z]", token))]
    def exact_identifier(entity):
        return any(re.search(r"(?<![\w])" + re.escape(token) + r"(?![\w])", entity.get("content", ""))
                   for token in anchors)
    words = [word.lower() for word in re.findall(r"[A-Za-z_][A-Za-z0-9_:.-]*", query)
             if len(word) >= 3 and word.lower() not in {"cpp", "java", "the", "and", "for", "what", "how", "can", "use", "should", "with", "are"}]
    cjk_pairs = {part[i:i+2] for part in re.findall(r"[\u3400-\u9fff]+", query)
                 for i in range(len(part)-1)}
    def meaningful_keyword(entity):
        content = entity.get("content", "").lower()
        return (exact_identifier(entity)
                or any(re.search(r"(?<![\w])" + re.escape(word) + r"(?![\w])", content) for word in words)
                or any(pair in content for pair in cjk_pairs))
    candidates = {}
    for rank, hit in enumerate(dense, 1):
        entity = hit["entity"]
        score = float(hit["distance"])
        if not math.isfinite(score):
            continue
        if ms._embedder.model_name == BGE_MODEL and score < BGE_NOISE_FLOOR and not exact_identifier(entity):
            continue
        key = result_key(entity)
        candidates[key] = {**entity, "semantic_score": score, "score": 1 / (60 + rank)}
    # Keyword ranking supplements surviving semantic candidates. A BM25 match on
    # a common term alone must not revive unrelated advice rejected above.
    for rank, hit in enumerate(keyword, 1):
        if sections and not meaningful_keyword(hit["entity"]):
            continue
        key = result_key(hit["entity"])
        if key not in candidates and exact_identifier(hit["entity"]):
            candidates[key] = {**hit["entity"], "semantic_score": 0.0, "score": 0.0}
        if key in candidates:
            candidates[key]["score"] += 1 / (60 + rank)
    hits = [hit for hit in candidates.values() if hit["source"] in sources]
    return sorted(hits, key=lambda row: (-row["score"], -row["semantic_score"], row["source"]))[:limit]



async def index_document(ms, path, checkpoint=None):
    """Index meaningful content with its subject; never embed audit frontmatter.

    memsearch's default chunker drops title-only sections. In an experience the
    title is precisely the trigger; losing it turns specific advice into a vague
    'check validity'. Keep short experiences whole, and prefix document chunks
    with their subject. Original Markdown stays untouched.
    """
    from memsearch.chunker import Chunk, compute_chunk_id
    from knowledge_chunks import split_markdown
    text = path.read_text(encoding="utf-8")
    body = re.sub(r"\A---\r?\n.*?\r?\n---(?:\r?\n|$)", "", text, count=1, flags=re.S)
    title_match = re.search(r"^#\s+(.+)$", body, re.M)
    title = title_match.group(1) if title_match else path.stem
    source = str(path)
    if re.fullmatch(r"c-[a-z0-9]+-[a-f0-9]+\.md", path.name):
        chunks = [Chunk(content=f"适用场景：{title}\n{body}", source=source,
                        heading=title, heading_level=1, start_line=1, end_line=len(text.splitlines()))]
    else:
        chunks = [Chunk(content=f"资料主题：{title}\n章节：{c.heading}\n{c.content}", source=source,
                        heading=c.heading or title, heading_level=1,
                        start_line=c.start_line, end_line=c.end_line)
                  for c in split_markdown(text)]
    model = ms._embedder.model_name
    old = ms._store.hashes_by_source(source)
    def ident(chunk):
        return compute_chunk_id(chunk.source, chunk.start_line, chunk.end_line, chunk.content_hash, model)
    current = {ident(c) for c in chunks}
    # Similar lengths share a model batch, avoiding padding every short rule to
    # the longest example in its original document order. IDs/order are stable.
    pending = sorted((c for c in chunks if ident(c) not in old), key=lambda c: len(c.content))
    count = 0
    for offset in range(0, len(pending), 8):
        check_deadline()
        if checkpoint:
            await checkpoint()
        with phase("index_batch_ms"):
            count += await ms._embed_and_store(pending[offset:offset + 8])
    check_deadline()
    # Only remove old chunks after replacement has been successfully indexed.
    stale = old - current
    if stale:
        ms._store.delete_by_hashes(list(stale))
    return count
