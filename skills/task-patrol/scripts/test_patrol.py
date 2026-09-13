import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


collector, runner = module("collect"), module("run")


class PatrolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        for i in range(8):
            task = self.data / f"task-{i}"
            task.mkdir()
            (task / "task.json").write_text(json.dumps({"summary": {"id": task.name,
                "status": "completed", "updated_at": f"2026-09-{i + 1:02d}T00:00:00Z"}}))
            (task / "waiting.json").write_text('{"records":{}}')
            (task / "events.jsonl").write_text(json.dumps({"eventId": 1, "ts": "2026-09-13T00:00:00Z",
                "kind": "tool_finished", "payload": {"result": "password=abc Bearer xyz", "name": "Bash"}}) + "\n")

    def test_readonly_rotation_and_redaction(self):
        before = {p: p.read_bytes() for p in self.data.rglob("*") if p.is_file()}
        offset, ids = 0, set()
        for _ in range(4):
            report = collector.collect(self.data, 3, offset)
            offset = report["next_offset"]
            ids.update(t["id"] for t in report["tasks"])
            self.assertNotIn("password=abc", json.dumps(report))
            self.assertNotIn("Bearer xyz", json.dumps(report))
        self.assertEqual(len(ids), 8)
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_missing_corrupt_and_truncated_data(self):
        task = self.data / "task-7"
        (task / "events.jsonl").write_text("broken\n" + '\n'.join(json.dumps({"eventId": i, "kind": "turn_finished"}) for i in range(110)))
        (self.data / "task-0" / "task.json").write_text("broken")
        report = collector.collect(self.data)
        self.assertEqual(report["error_count"], 1)
        sampled = next(t for t in report["tasks"] if t["id"] == "task-7")
        self.assertTrue(sampled["events_truncated"])
        self.assertEqual(sampled["malformed_event_lines"], 1)
        self.assertEqual(len(sampled["events"]), 100)

    def test_symlink_task_skipped(self):
        (self.data / "task-symlink").symlink_to(self.data / "task-1", target_is_directory=True)
        self.assertEqual(collector.collect(self.data)["discovered"], 8)

    def test_pi_final_message_not_progress_or_tools(self):
        lines = [{"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "分析中"}]}},
                 {"type": "message_end", "message": {"role": "toolResult", "content": []}},
                 {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": '```json\n{"findings": []}\n```'}]}}]
        self.assertEqual(runner.pi_report('\n'.join(map(json.dumps, lines))), {"findings": []})
        lines[-1]["message"]["stopReason"] = "error"
        with self.assertRaises(ValueError):
            runner.pi_report('\n'.join(map(json.dumps, lines)))

    def fake_pi(self):
        script = self.root / "pi.py"
        script.write_text('''import json,sys,time,fcntl
from pathlib import Path
root=Path(__file__).parent
prompt=sys.stdin.read()
with (root/'concurrency').open('a+') as f:
 fcntl.flock(f,fcntl.LOCK_EX); f.seek(0); v=json.loads(f.read() or '[0,0]'); v[0]+=1; v[1]=max(v); f.seek(0); f.truncate(); json.dump(v,f)
time.sleep(.08)
with (root/'concurrency').open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX); v=json.load(f); v[0]-=1; f.seek(0); f.truncate(); json.dump(v,f)
if (root/'fail-child').exists() and '你是单任务' in prompt and '"id": "task-7"' in prompt: sys.exit(2)
if (root/'bad-summary').exists() and '你是独立审查主 PI' in prompt: print('bad'); sys.exit(0)
report={'coverage':'test','findings':[{'key':'same-cause','category':'hypothesis','title':'test','evidence':['prod/task-7/events.jsonl#1'],'analysis':'test','recommendation':'verify'}]}
if (root/'new-evidence').exists(): report['findings'][0]['evidence']=['prod/task-7/events.jsonl#2']
print(json.dumps({'type':'message_end','message':{'role':'assistant','stopReason':'stop','content':[{'type':'text','text':json.dumps(report)}]}}))
''')
        return [sys.executable, str(script)]

    def test_parallel_partial_dedup_and_failure_preserves_history(self):
        config = self.root / "config.json"
        output = self.root / "output"
        config.write_text(json.dumps({"ssh_host": "fake", "remote_data_dir": str(self.data),
            "output_dir": str(output), "agent_command": self.fake_pi(), "parallel_agents": 3}))
        def ssh(*args, **kwargs):
            return subprocess.CompletedProcess(args, 0, json.dumps(collector.collect(self.data)), "")
        with patch.object(runner.subprocess, "run", side_effect=ssh):
            runner.run(config)
            self.assertGreater(json.loads((self.root / 'concurrency').read_text())[1], 1)
            self.assertEqual(json.loads((output / "last-run.json").read_text())["changed_findings"], 1)
            runner.run(config)
            self.assertEqual(json.loads((output / "last-run.json").read_text())["changed_findings"], 0)
            (self.root / "new-evidence").touch()
            runner.run(config)
            self.assertEqual(json.loads((output / "last-run.json").read_text())["changed_findings"], 1)
            (self.root / "new-evidence").unlink()
            runner.run(config)
            self.assertEqual(json.loads((output / "last-run.json").read_text())["changed_findings"], 0)
            (self.root / "fail-child").touch()
            runner.run(config)
            self.assertEqual(json.loads((output / "last-run.json").read_text())["status"], "partial")
            history = (output / "known-findings.json").read_bytes()
            (self.root / "bad-summary").touch()
            with self.assertRaises(ValueError):
                runner.run(config)
            self.assertEqual(json.loads((output / "last-run.json").read_text())["status"], "failed")
            self.assertEqual(history, (output / "known-findings.json").read_bytes())

    def test_overlap_skips_and_ssh_failure_is_not_healthy(self):
        output = self.root / "output"
        output.mkdir()
        config = self.root / "config.json"
        config.write_text(json.dumps({"ssh_host": "fake", "remote_data_dir": str(self.data),
            "output_dir": str(output), "agent_command": self.fake_pi()}))
        with (output / "run.lock").open("w") as lock:
            runner.fcntl.flock(lock, runner.fcntl.LOCK_EX)
            with patch.object(runner.subprocess, "run", side_effect=AssertionError("must skip")):
                runner.run(config)
            self.assertFalse((output / "last-run.json").exists())
        with patch.object(runner.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 60)):
            with self.assertRaises(subprocess.TimeoutExpired):
                runner.run(config)
        self.assertEqual(json.loads((output / "last-run.json").read_text())["status"], "failed")
        self.assertFalse((output / "known-findings.json").exists())

    def test_timeout_is_not_a_report(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            runner.analyze([sys.executable, "-c", "import time; time.sleep(30)"], "test", self.root / "timed", .1)
        self.assertFalse((self.root / "timed" / "report.json").exists())


if __name__ == "__main__":
    unittest.main()
