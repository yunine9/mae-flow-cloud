"""Read document bundles without extracting user-controlled paths."""
import hashlib
import json
import pathlib
import re
import stat
import zipfile


class BundleError(ValueError):
    pass


def parse_bundle(path):
    sections, images, warnings = [], [], []
    text_bytes = 0
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 1000 or sum(i.file_size for i in entries) > 100 * 1024 * 1024:
            raise BundleError("ZIP 最多 1000 个条目，解压后总量不能超过 100 MiB")
        seen = set()
        for info in entries:
            name = info.filename
            parts = name.rstrip("/").split("/")
            if (not name or len(name) > 500 or any(p in ("", ".", "..") for p in parts)
                    or re.search(r"[\\:\x00-\x1f\x7f]", name) or info.orig_filename != name
                    or stat.S_ISLNK(info.external_attr >> 16) or name in seen):
                raise BundleError("ZIP 含无效路径、重复条目或符号链接，请重新打包")
            if info.flag_bits & 1:
                raise BundleError("不支持加密 ZIP，请解密后重新上传")
            seen.add(name)
        for info in entries:
            name = info.filename
            if info.is_dir() or name.startswith("__MACOSX/") or pathlib.PurePosixPath(name).name == ".DS_Store":
                continue
            suffix = pathlib.PurePosixPath(name).suffix.lower()
            if suffix not in (".md", ".markdown", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp"):
                warnings.append(f"未解析附件：{name}；ZIP 内支持 Markdown、TXT 和 PNG/JPEG/GIF/WebP 图片")
                continue
            if info.file_size > 10 * 1024 * 1024:
                raise BundleError("ZIP 内单个文档或图片不能超过 10 MiB")
            # Read at most the per-file budget even if the ZIP header is inconsistent.
            with archive.open(info) as entry:
                data = entry.read(10 * 1024 * 1024 + 1)
            if len(data) > 10 * 1024 * 1024:
                raise BundleError("ZIP 内文件超过大小限制")
            if suffix in (".md", ".markdown", ".txt"):
                text_bytes += len(data)
                if text_bytes > 5 * 1024 * 1024:
                    raise BundleError("ZIP 中文本总量不能超过 5 MiB")
                try:
                    text = data.decode("utf-8-sig")
                    if "\x00" in text:
                        raise ValueError()
                except (UnicodeDecodeError, ValueError):
                    warnings.append(f"未解析文档：{name}；请使用 UTF-8 文本")
                    continue
                lines = text.splitlines()
                for start in range(0, len(lines), 100):
                    chunk = "\n".join(lines[start:start + 100])
                    for offset in range(0, len(chunk), 12000):
                        content = chunk[offset:offset + 12000]
                        if content.strip():
                            sections.append({"location": f"{name} · 行 {start + 1}–{min(start + 100, len(lines))} · 字符 {offset + 1}", "text": content})
            else:
                mime = None
                if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 33 and data[12:16] == b"IHDR":
                    mime = "image/png"
                elif data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
                    mime = "image/jpeg"
                elif data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 13:
                    mime = "image/gif"
                elif data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 20:
                    mime = "image/webp"
                if not mime:
                    warnings.append(f"未解析图片：{name}；文件格式无效")
                    continue
                asset_id = hashlib.sha256(name.encode()).hexdigest()
                folder = path.parent / "images"
                folder.mkdir(exist_ok=True, mode=0o700)
                target = folder / asset_id
                target.write_bytes(data)
                target.chmod(0o600)
                images.append({"id": asset_id, "path": name, "mimeType": mime, "bytes": len(data)})
    result = {"sections": sections, "images": images, "warnings": warnings}
    output = json.dumps(result, ensure_ascii=False)
    if len(output.encode()) > 6 * 1024 * 1024:
        raise BundleError("ZIP 解析结果过大，请拆成多个资料包")
    return output
