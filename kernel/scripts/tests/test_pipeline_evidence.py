#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""流水线证据口:宿主喂平台事实,内核绑 HEAD 裁决并落盘。

为什么有这一档:云端契约把编译/UT"推迟给流水线",此前那三个 deferred
标记只活在内存里——没人落盘、没人事后核销,"推迟"等于一句没人兑现的
承诺。pipeline record 补上兑现侧:事实绑当前 HEAD 裁决(旧绿灯不背书
新代码,mvp 设计 14.5),结论写进 .mae-flow.json 的 quality.pipeline。

判定是纯函数(adjudicate),直插测试;落盘仪式(绑 HEAD、写状态、
末行 JSON)由宿主仓 mae-flow-cloud 的端到端用例吃真件裁判——这里不
装配整个 CLI 运行时去演一遍假的。
"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import host_env  # noqa: E402
from mae_flow_core.cli_commands.pipeline_commands import adjudicate  # noqa: E402
from mae_flow_core import command_dispatch  # noqa: E402
from mae_flow_core import cli_parser  # noqa: E402


HEAD = "a" * 40
OTHER = "b" * 40


class AdjudicateTests(unittest.TestCase):
    def test_success_bound_to_head_passes(self):
        verdict, reason = adjudicate({"sha": HEAD, "status": "success"}, HEAD)
        self.assertEqual(verdict, "PASS")
        self.assertIn("绑定当前 HEAD", reason)

    def test_stale_sha_never_endorses_new_code(self):
        # 红线 14.5:旧绿灯不背书新代码——status 哪怕是 success,
        # SHA 对不上就只能是 STALE,绝不许判 PASS。
        verdict, reason = adjudicate({"sha": OTHER, "status": "success"}, HEAD)
        self.assertEqual(verdict, "STALE")
        self.assertIn("不背书新代码", reason)

    def test_failed_pipeline_is_red_not_pass(self):
        verdict, _ = adjudicate({"sha": HEAD, "status": "failed"}, HEAD)
        self.assertEqual(verdict, "RED")

    def test_missing_or_unknown_facts_are_invalid_not_guessed(self):
        # 诚实纪律:形状不对拒绝登记,不把 running/None 猜成某个结论。
        for facts in ({}, {"sha": HEAD}, {"status": "success"},
                      {"sha": HEAD, "status": "running"},
                      {"sha": "", "status": "success"}):
            verdict, _ = adjudicate(facts, HEAD)
            self.assertEqual(verdict, "INVALID", facts)


class WiringTests(unittest.TestCase):
    def test_pipeline_route_registered(self):
        route = command_dispatch.flow_route("pipeline")
        self.assertIsNotNone(route)
        self.assertEqual(route.handler, "cmd_pipeline")

    def test_parser_accepts_record_and_show(self):
        parser = cli_parser.build_parser()
        args = parser.parse_args(["pipeline", "record", "--file", "f.json"])
        self.assertEqual((args.cmd, args.action, args.file),
                         ("pipeline", "record", "f.json"))
        args = parser.parse_args(["pipeline", "show"])
        self.assertEqual((args.cmd, args.action), ("pipeline", "show"))


class HostEnvTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(host_env.ENV)
        os.environ.pop(host_env.ENV, None)

    def tearDown(self):
        os.environ.pop(host_env.ENV, None)
        if self._saved is not None:
            os.environ[host_env.ENV] = self._saved

    def test_pipeline_adjudicates_only_in_cloud(self):
        # 本地的裁判是本地执行本身,没有第二个裁判。
        self.assertFalse(host_env.pipeline_adjudicates())
        os.environ[host_env.ENV] = "cloud"
        self.assertTrue(host_env.pipeline_adjudicates())


if __name__ == "__main__":
    unittest.main()
