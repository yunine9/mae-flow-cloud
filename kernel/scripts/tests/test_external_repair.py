import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.external_repair import (  # noqa: E402
    active_repair_authorization,
    eligible_repair_paths,
    issue_repair_authorization,
)
from mae_flow_core.quality.external_verification import (  # noqa: E402
    PipelineDecision,
)


HEAD = "a" * 40


def red_state():
    return {
        "current": "external_verify",
        "initial_dirty": ["user-before.txt"],
        "quality": {"external_verification": {
            "verdict": "RED", "sha": HEAD,
        }},
    }


class ExternalRepairAuthorizationTests(unittest.TestCase):
    def test_red_issues_failed_sha_bound_window_and_filters_carryover(self):
        state = red_state()
        issue_repair_authorization(
            state, PipelineDecision("RED", "UT failed", {}),
            head=HEAD, at="2026-08-20 12:00:00",
            dirty_paths=("pre-red.txt",))
        self.assertTrue(active_repair_authorization(state, HEAD)[0])
        self.assertFalse(active_repair_authorization(state, "b" * 40)[0])
        self.assertEqual(
            ("src/fix.py", "tests/test_fix.py"),
            eligible_repair_paths(state, HEAD, (
                "user-before.txt", "pre-red.txt", "src/fix.py",
                "tests/test_fix.py", ".mae-flow.json",
                "docs/review/internal.md")),
        )

    def test_non_red_clears_window(self):
        state = red_state()
        issue_repair_authorization(
            state, PipelineDecision("RED", "failed", {}),
            head=HEAD, at="now")
        issue_repair_authorization(
            state, PipelineDecision("INCOMPLETE", "running", {}),
            head=HEAD, at="later")
        self.assertNotIn("external_repair_authorization", state)


if __name__ == "__main__":
    unittest.main()
