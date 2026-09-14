import copy
import os
import sys
import unittest
from unittest import mock
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from mae_flow_core.cli_commands import host_receipts as receipts


class FeedbackPredecessorTests(unittest.TestCase):
    def setUp(self):
        self.state = {"current": "build", "delivery_loop": None}
        projection = receipts.host_projection(self.state, "selection-reconcile", {})
        proof = {"schema": receipts.PROOF_SCHEMA, "task_id": "task-20",
                 "action": "selection-reconcile", "payload_digest": "signed-payload"}
        self.record = {"schema": receipts.RECEIPT_SCHEMA, "proof": proof,
                       "payload_digest": "signed-payload", "projection": projection,
                       "projection_digest": receipts._digest(projection)}
        self.scan = mock.patch.object(receipts, "_scan_receipts", side_effect=lambda state:
                                     iter([({"task_id": "task-20"}, self.record)]))
        self.signature = mock.patch.object(receipts, "_verify_rsa_sha256", return_value=True)
        self.scan.start(); self.signature.start()
        self.addCleanup(self.scan.stop); self.addCleanup(self.signature.stop)

    def test_step_movement_allows_predecessor_but_not_completion_attestation(self):
        self.state["current"] = "external_verify"
        before = copy.deepcopy(self.state)
        self.assertTrue(receipts.trusted_lifecycle_predecessor(self.state, ["selection-reconcile"]))
        self.assertFalse(receipts.trusted_current_lifecycle(self.state, ["selection-reconcile"]))
        self.assertEqual(before, self.state)
        self.assertEqual("build", self.record["projection"]["current"])

    def test_other_projection_changes_and_bad_signatures_stay_rejected(self):
        for field, value in (("delivery_loop", {}), ("user_intervention", {"forged": True}),
                             ("quality", {"external_verification": {"verdict": "PASS"}})):
            with self.subTest(field=field):
                changed = dict(self.state, current="external_verify", **{field: value})
                self.assertFalse(receipts.trusted_lifecycle_predecessor(changed, ["selection-reconcile"]))
        self.assertFalse(receipts.trusted_lifecycle_predecessor(self.state, ["pipeline-record"]))
        with mock.patch.object(receipts, "_verify_rsa_sha256", return_value=False):
            self.assertFalse(receipts.trusted_lifecycle_predecessor(self.state, ["selection-reconcile"]))
        self.record["projection"]["current"] = "external_verify"
        self.assertFalse(receipts.trusted_lifecycle_predecessor(self.state, ["selection-reconcile"]))


if __name__ == "__main__":
    unittest.main()
