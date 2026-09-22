#!/usr/bin/env python3
"""Extract task materials with source locations; never run document macros."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
import importlib.util


def parse(path):
    suffix = path.suffix.lower()
    if suffix == ".zip":
        spec = importlib.util.spec_from_file_location("knowledge_zip", pathlib.Path(__file__).with_name("parse-knowledge-zip.py"))
        bundle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bundle)
        try:
            return bundle.parse_bundle(path)
        except bundle.BundleError as error:
            return json.dumps({"error": str(error)}, ensure_ascii=False)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError):
            return json.dumps({"error": "ZIP 损坏、加密或压缩格式不受支持，请重新打包"}, ensure_ascii=False)
    sections = []

    def add(location, text):
        # Bound each tool read while retaining a stable location within the source.
        for offset in range(0, len(text), 12000):
            if text[offset:offset + 12000].strip():
                sections.append({"location": f"{location} · 字符 {offset + 1}", "text": text[offset:offset + 12000]})

    if suffix in (".md", ".txt"):
        text = path.read_text(encoding="utf-8-sig")
        if "\x00" in text:
            raise ValueError("not text")
        for start in range(0, len(text.splitlines()), 100):
            add(f"行 {start + 1}–{start + 100}", "\n".join(text.splitlines()[start:start + 100]))
    elif suffix == ".pdf":
        with tempfile.TemporaryDirectory(prefix="parse-pdf-", dir=path.parent) as folder:
            output = pathlib.Path(folder) / "text.txt"
            subprocess.run([os.environ.get("MAE_FLOW_PDFTOTEXT_BIN", "pdftotext"), "-layout", str(path), str(output)], check=True, timeout=45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if output.stat().st_size > 6 * 1024 * 1024:
                raise ValueError("extracted text too large")
            for i, page in enumerate(output.read_text().split("\f")):
                add(f"第 {i + 1} 页", page)
    else:
        with zipfile.ZipFile(path) as archive:
            if len(archive.infolist()) > 10000 or sum(info.file_size for info in archive.infolist()) > 100 * 1024 * 1024:
                raise ValueError("expanded archive too large")

            def xml(name):
                data = archive.read(name)
                if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
                    raise ValueError("XML entities not supported")
                return ET.fromstring(data)

            def texts(node):
                return "".join(e.text or "" for e in node.iter() if e.tag.rsplit("}", 1)[-1] == "t")

            if suffix == ".docx":
                doc = xml("word/document.xml")
                ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
                paragraph, table = 0, 0
                for block in doc.find(f"{ns}body"):
                    if block.tag == f"{ns}p":
                        paragraph += 1
                        add(f"段落 {paragraph}", texts(block))
                    elif block.tag == f"{ns}tbl":
                        table += 1
                        for row, tr in enumerate(block.findall(f"{ns}tr"), 1):
                            values = []
                            for column, cell in enumerate(tr.findall(f"{ns}tc"), 1):
                                value = " / ".join(texts(p) for p in cell.iter(f"{ns}p"))
                                values.append(f"列 {column}: {value}")
                            add(f"表格 {table} · 行 {row}", " | ".join(values))
            elif suffix == ".pptx":
                names = sorted((n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=lambda n: int(re.search(r"(\d+)\.xml", n).group(1)))
                for name in names:
                    number = re.search(r"(\d+)\.xml", name).group(1)
                    add(f"幻灯片 {number}", "\n".join(texts(p) for p in xml(name).iter("{http://schemas.openxmlformats.org/drawingml/2006/main}p")))
            elif suffix == ".xlsx":
                ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
                shared = [texts(si) for si in xml("xl/sharedStrings.xml").findall(f"{ns}si")] if "xl/sharedStrings.xml" in archive.namelist() else []
                rels = {e.attrib["Id"]: e.attrib["Target"] for e in xml("xl/_rels/workbook.xml.rels")}
                for sheet in xml("xl/workbook.xml").iter(f"{ns}sheet"):
                    target = rels[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
                    target = target.lstrip("/") if target.startswith("/") else "xl/" + target
                    for row in xml(target).iter(f"{ns}row"):
                        values = []
                        for cell in row.findall(f"{ns}c"):
                            value = cell.findtext(f"{ns}v", "")
                            if cell.attrib.get("t") == "s": value = shared[int(value)] if value else ""
                            elif cell.attrib.get("t") == "inlineStr": value = texts(cell)
                            formula = cell.findtext(f"{ns}f")
                            values.append(f"{cell.attrib.get('r', '?')}: {value}" + (f"（公式：{formula}；值为文件缓存）" if formula else ""))
                        add(f"工作表 {sheet.attrib['name']} · 行 {row.attrib.get('r', '?')}", " | ".join(values))
            else:
                raise ValueError("unsupported format")
    output = json.dumps(sections, ensure_ascii=False)
    if len(output.encode()) > 6 * 1024 * 1024:
        raise ValueError("extracted text too large")
    return output


if __name__ == "__main__":
    print(parse(pathlib.Path(sys.argv[1])))
