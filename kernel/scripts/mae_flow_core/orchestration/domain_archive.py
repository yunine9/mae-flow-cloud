"""Deterministic, local-first domain archive transaction."""

from dataclasses import asdict, dataclass
import hashlib
import os

from .behavior_baseline import (
    plan_domain_reconciliation,
    render_domain_index,
    validate_domain_document,
)


@dataclass(frozen=True)
class ArchiveCandidate:
    domain: str
    keywords: tuple
    candidate_path: str
    target_path: str
    action: str
    initialized: bool = False

    def to_dict(self, project_root):
        root = os.path.abspath(os.fspath(project_root))
        return {
            **asdict(self),
            "keywords": list(self.keywords),
            "candidate_path": os.path.relpath(self.candidate_path, root).replace("\\", "/"),
        }


def _read(path):
    try:
        with open(path, encoding="utf-8") as stream:
            return stream.read()
    except OSError:
        return ""


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp-%s" % os.getpid()
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def initialize_candidate(project_root, archive_root, domain, template_content):
    result = plan_domain_reconciliation(project_root, domain, "placeholder")
    candidate = os.path.join(os.path.abspath(archive_root), "%s.md" % result.domain)
    if os.path.exists(candidate):
        return ArchiveCandidate(
            result.domain, (), candidate, result.path, "draft", False)
    current = _read(result.absolute_path)
    content = current or str(template_content).replace("<领域名称>", result.domain)
    _write(candidate, content)
    return ArchiveCandidate(result.domain, (), candidate, result.path, "draft", True)


def prepare_candidate(project_root, candidate_path, domain, keywords):
    content = _read(candidate_path)
    errors = validate_domain_document(content)
    if errors:
        raise ValueError("；".join(errors))
    result = plan_domain_reconciliation(project_root, domain, content)
    words = tuple(dict.fromkeys(
        str(keyword).strip() for keyword in keywords if str(keyword).strip()))
    if result.action == "new" and not words:
        raise ValueError("新领域 %s 至少需要一个索引关键词" % result.domain)
    return ArchiveCandidate(
        result.domain, words, os.path.abspath(candidate_path),
        result.path, result.action, False)


def candidate_from_dict(project_root, value):
    root = os.path.abspath(os.fspath(project_root))
    candidate = os.path.abspath(os.path.join(
        root, *str(value["candidate_path"]).replace("\\", "/").split("/")))
    if os.path.commonpath((root, candidate)) != root:
        raise ValueError("领域归档候选路径越出项目目录")
    return ArchiveCandidate(
        domain=str(value["domain"]),
        keywords=tuple(value.get("keywords") or ()),
        candidate_path=candidate,
        target_path=str(value["target_path"]),
        action=str(value["action"]),
        initialized=bool(value.get("initialized", False)),
    )


def input_digest(project_root, input_paths, git_facts, candidates):
    root = os.path.abspath(os.fspath(project_root))
    digest = hashlib.sha256()
    digest.update(str(git_facts or "").encode("utf-8"))
    paths = [os.path.abspath(os.fspath(path)) for path in input_paths]
    paths.append(os.path.join(root, "docs", "specs", "index.md"))
    for entry in candidates:
        paths.append(os.path.abspath(entry.candidate_path))
        relative = entry.target_path.replace("\\", "/")
        paths.append(os.path.join(root, *relative.split("/")))
    for path in sorted(set(paths), key=str.casefold):
        digest.update(os.path.relpath(path, root).replace("\\", "/").encode("utf-8"))
        try:
            with open(path, "rb") as stream:
                digest.update(stream.read())
        except OSError:
            digest.update(b"<missing>")
    return digest.hexdigest()


def require_fresh(expected, actual):
    if not expected or expected != actual:
        raise ValueError(
            "领域归档候选已过期；只需重新执行 domain-archive prepare，"
            "不会回退编码、检视或质量阶段")


def _transaction_write(contents, replacer=os.replace):
    originals = {}
    temporaries = {}
    replaced = []
    try:
        for path, content in contents.items():
            try:
                with open(path, "rb") as stream:
                    originals[path] = stream.read()
            except OSError:
                originals[path] = None
            os.makedirs(os.path.dirname(path), exist_ok=True)
            temporary = path + ".archive-%s" % os.getpid()
            with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
            temporaries[path] = temporary
        for path in sorted(contents, key=str.casefold):
            replacer(temporaries[path], path)
            replaced.append(path)
    except Exception:
        for path in reversed(replaced):
            original = originals[path]
            if original is None:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                continue
            restore = path + ".rollback-%s" % os.getpid()
            with open(restore, "wb") as stream:
                stream.write(original)
            os.replace(restore, path)
        raise
    finally:
        for temporary in temporaries.values():
            try:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            except OSError:
                pass


def apply_candidates(project_root, candidates, replacer=os.replace):
    root = os.path.abspath(os.fspath(project_root))
    entries = tuple(candidates)
    contents = {}
    additions = []
    changed = []
    for entry in entries:
        prepared = prepare_candidate(
            root, entry.candidate_path, entry.domain, entry.keywords)
        if prepared.action == "unchanged":
            continue
        target = os.path.join(root, *prepared.target_path.split("/"))
        contents[target] = _read(prepared.candidate_path)
        changed.append(prepared.target_path)
        additions.append((prepared.domain, prepared.keywords))
    if additions:
        index = os.path.join(root, "docs", "specs", "index.md")
        current_index = _read(index)
        rendered_index = render_domain_index(current_index, additions)
        if rendered_index != current_index:
            contents[index] = rendered_index
            changed.append("docs/specs/index.md")
    if contents:
        _transaction_write(contents, replacer=replacer)
    return tuple(sorted(set(changed), key=str.casefold))
