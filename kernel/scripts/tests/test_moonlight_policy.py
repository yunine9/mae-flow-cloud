#!/usr/bin/env python3
"""Contracts for unattended quality routing."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.moonlight import (  # noqa: E402
    REPAIR_ENTRY,
    can_hard_block,
    step_kind,
)


class MoonlightPolicyTests(unittest.TestCase):
    def test_unified_recompile_is_a_compile_quality_step(self):
        self.assertEqual("compile", step_kind("quality_recompile"))
        self.assertFalse(can_hard_block("quality_recompile"))

    def test_full_repairs_enter_the_unified_quality_corridor(self):
        self.assertEqual("quality_recompile", REPAIR_ENTRY["full"])
        self.assertEqual("quality_recompile", REPAIR_ENTRY["hotfix"])


if __name__ == "__main__":
    unittest.main()
