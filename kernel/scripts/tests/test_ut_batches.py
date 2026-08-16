#!/usr/bin/env python3
"""Adaptive UT batching stays bounded without per-batch commits."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.ut_batches import (  # noqa: E402
    advance_ut_session,
    accumulated_ut_paths,
    plan_ut_batches,
)


class UtBatchPolicyTests(unittest.TestCase):
    def test_small_scope_uses_one_logical_batch(self):
        plan = plan_ut_batches(["a", "b", "c", "d", "e"])
        self.assertEqual((("a", "b", "c", "d", "e"),), plan.batches)
        self.assertFalse(plan.requires_batch_commit)

    def test_large_scope_balances_three_to_five_targets_per_batch(self):
        plan = plan_ut_batches(["method_%02d" % i for i in range(11)])
        self.assertEqual([4, 4, 3], [len(batch) for batch in plan.batches])
        self.assertEqual(
            ["method_%02d" % i for i in range(11)],
            [target for batch in plan.batches for target in batch],
        )
        self.assertFalse(plan.requires_batch_commit)

    def test_duplicate_targets_are_removed_without_reordering(self):
        plan = plan_ut_batches(["a", "b", "a", "c"])
        self.assertEqual((("a", "b", "c"),), plan.batches)

    def test_same_session_accepts_only_returned_agent_test_outputs(self):
        classify = lambda path: path.startswith("tests/")
        build = lambda path: path == "pom.xml"
        allowed, blocked = accumulated_ut_paths(
            ["tests/a.cpp", "pom.xml", "src/a.cpp"],
            same_step=True,
            prior_returned=True,
            owned_paths=("tests/a.cpp", "pom.xml"),
            is_test=classify,
            is_build=build,
        )
        self.assertEqual(("tests/a.cpp", "pom.xml"), allowed)
        self.assertEqual(("src/a.cpp",), blocked)
        self.assertEqual(
            ((), ("tests/a.cpp",)),
            accumulated_ut_paths(
                ["tests/a.cpp"], same_step=True, prior_returned=False,
                owned_paths=("tests/a.cpp",),
                is_test=classify, is_build=build),
        )

    def test_unowned_test_dirt_is_not_adopted(self):
        allowed, blocked = accumulated_ut_paths(
            ["tests/owned.cpp", "tests/unrelated.cpp"],
            same_step=True, prior_returned=True,
            owned_paths=("tests/owned.cpp",),
            is_test=lambda path: path.startswith("tests/"),
            is_build=lambda _path: False)
        self.assertEqual(("tests/owned.cpp",), allowed)
        self.assertEqual(("tests/unrelated.cpp",), blocked)

    def test_user_review_rework_reauthorizes_only_reviewed_test_paths(self):
        allowed, blocked = accumulated_ut_paths(
            ["tests/revised.cpp", "tests/unrelated.cpp"],
            same_step=False, prior_returned=False,
            owned_paths=("tests/revised.cpp",), review_authorized=True,
            is_test=lambda path: path.startswith("tests/"),
            is_build=lambda _path: False)
        self.assertEqual(("tests/revised.cpp",), allowed)
        self.assertEqual(("tests/unrelated.cpp",), blocked)

    def test_session_assigns_each_batch_then_one_final_run(self):
        batches = (("a", "b", "c"), ("d", "e", "f"))
        first = advance_ut_session({}, batches, False)
        self.assertEqual("generate", first.record["phase"])
        self.assertEqual((batches[0],), first.task_batches)
        second = advance_ut_session(first.record, batches, True)
        self.assertEqual([0], second.record["completed_batches"])
        self.assertEqual((batches[1],), second.task_batches)
        final = advance_ut_session(second.record, batches, True)
        self.assertEqual("final", final.record["phase"])
        self.assertEqual((), final.task_batches)
        complete = advance_ut_session(final.record, batches, True)
        self.assertTrue(complete.complete)


if __name__ == "__main__":
    unittest.main()
