#!/usr/bin/env python3
"""网关公共层:配置装载、令牌注入、REST/MCP 调用(纯标准库,零依赖)。

照 toolkit 的稳定实现分层(2026-08-28 对比报告):每个取数策略都是
"MCP → REST/CLI"的独立降级链,任何一路失败不影响其他路。本模块只做
取数的地基——HTTP 与 MCP(streamable HTTP,JSON-RPC 2.0 tools/call)。

纪律(与仓宪法一致):
- 令牌只从 token_file 读,永不进日志/输出/异常文本;
- 一切请求带超时(默认 60s),绝无无限等待;
- 失败如实抛 GatewayError 带上下文,由上层决定降级还是聚合上报。
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class GatewayError(RuntimeError):
    pass


_MASK_KEYS = ("token", "w3token", "authorization", "x-auth-token")


def _mask(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "<token>")
    return text


class Gateways:
    """gateways.json 的装载与调用入口。"""

    def __init__(self, config_path: str | None = None):
        path = config_path or os.environ.get("MFC_GATEWAYS") or str(
            Path(__file__).with_name("gateways.json"))
        try:
            self.config = json.loads(Path(path).read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise GatewayError(
                f"网关配置缺席: {path}(从 gateways.example.json 复制并"
                "按内网实况填写)") from error
        self._secrets: list[str] = []
        self.token = self._read_secret("token_file")
        self.w3token = self._read_secret("w3token_file")
        self.timeout = float(self.config.get("timeout_s", 60))
        proxy = str(self.config.get("proxy") or "").strip()
        handlers: list[urllib.request.BaseHandler] = []
        if proxy:
            handlers.append(urllib.request.ProxyHandler(
                {"http": proxy, "https": proxy}))
        # 内网网关常见自签证书:校验开关交给部署(insecure_tls: true),
        # 默认仍校验——静默全关等于把中间人当自己人。
        if self.config.get("insecure_tls") is True:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self.opener = urllib.request.build_opener(*handlers)

    def _read_secret(self, key: str) -> str:
        path = str(self.config.get(key) or "").strip()
        if not path:
            return ""
        try:
            value = Path(path).read_text(encoding="utf-8").strip()
        except OSError as error:
            raise GatewayError(f"{key} 读取失败: {path}({error})") from error
        if value:
            self._secrets.append(value)
        return value

    def _fill_headers(self, headers: dict[str, str]) -> dict[str, str]:
        filled = {}
        for name, value in (headers or {}).items():
            filled[name] = str(value).replace("{token}", self.token) \
                .replace("{w3token}", self.w3token)
            if ("{token}" in str(value) and not self.token) \
                    or ("{w3token}" in str(value) and not self.w3token):
                raise GatewayError(
                    f"请求头 {name} 引用了令牌但 token_file/w3token_file "
                    "没配或为空——不带空令牌去撞网关")
        return filled

    def mask(self, text: str) -> str:
        return _mask(text, self._secrets)

    # ---- REST ----

    def rest(self, url: str, headers: dict[str, str],
             method: str = "GET", body: dict | None = None,
             timeout: float | None = None):
        """一次 REST 调用,返回解析后的 JSON。失败抛 GatewayError
        (状态码+响应前 300 字,令牌打码)。"""
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        for name, value in self._fill_headers(headers).items():
            request.add_header(name, value)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(
                    request, timeout=timeout or self.timeout) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")[:300]
            raise GatewayError(self.mask(
                f"REST {method} {url} -> HTTP {error.code}: {raw}")) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GatewayError(self.mask(
                f"REST {method} {url} 连接失败: {error}")) from None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise GatewayError(self.mask(
                f"REST {method} {url} 响应不是 JSON(前 300 字: "
                f"{raw[:300]})")) from None

    # ---- MCP(streamable HTTP)----

    def mcp(self, gateway: str, tool: str, arguments: dict,
            timeout: float | None = None):
        """调一个 MCP 网关工具(JSON-RPC 2.0 tools/call)。

        协议按 MCP streamable HTTP 标准写;若内网网关是旧 SSE 形态或
        自定义包裹,拿 toolkit 的 callMcpTool 原文来对齐这里(TODO 锚点:
        MCP_PROTOCOL_ALIGNMENT)。返回 result.content 里首个 JSON/文本。
        """
        section = (self.config.get("mcp") or {}).get(gateway)
        if not section or not section.get("url"):
            raise GatewayError(
                f"MCP 网关 {gateway} 未配置(gateways.json 的 mcp.{gateway})")
        payload = {
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        request = urllib.request.Request(
            section["url"], data=json.dumps(payload).encode("utf-8"),
            method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json, text/event-stream")
        for name, value in self._fill_headers(
                section.get("headers") or {}).items():
            request.add_header(name, value)
        try:
            with self.opener.open(
                    request, timeout=timeout or self.timeout) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")[:300]
            raise GatewayError(self.mask(
                f"MCP {gateway}.{tool} -> HTTP {error.code}: {body}")) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GatewayError(self.mask(
                f"MCP {gateway}.{tool} 连接失败: {error}")) from None
        # streamable HTTP 允许 SSE 帧包 JSON:逐帧找 data: 行。
        if raw.lstrip().startswith("event:") or "\ndata:" in raw \
                or raw.lstrip().startswith("data:"):
            frames = [line[5:].strip() for line in raw.splitlines()
                      if line.startswith("data:")]
            raw = frames[-1] if frames else raw
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError:
            raise GatewayError(self.mask(
                f"MCP {gateway}.{tool} 响应不是 JSON(前 300 字: "
                f"{raw[:300]})")) from None
        if envelope.get("error"):
            raise GatewayError(self.mask(
                f"MCP {gateway}.{tool} 报错: "
                f"{json.dumps(envelope['error'], ensure_ascii=False)[:300]}"))
        content = ((envelope.get("result") or {}).get("content")) or []
        for item in content:
            if item.get("type") == "text":
                text = item.get("text", "")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return envelope.get("result")


def repo_path_of(repo_url: str) -> str:
    """仓库 URL → URL 编码的项目路径(CodeHub REST 定位用)。"""
    try:
        path = urllib.parse.urlsplit(repo_url).path
    except ValueError:
        return ""
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return urllib.parse.quote(path, safe="")
