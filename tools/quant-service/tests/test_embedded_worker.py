import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]


class EmbeddedWorkerTest(unittest.TestCase):
    def test_multiple_requests_and_write_guard(self):
        worker = subprocess.Popen(
            [sys.executable, "-u", "embedded_worker.py"],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            env={**os.environ, "QUANT_INTERNAL_TOKEN": "test-token"},
        )
        try:
            for item in [
                {"id": 1, "method": "GET", "path": "/health", "headers": {}, "body": ""},
                {"id": 2, "method": "PUT", "path": "/watchlist/config", "headers": {}, "body": "{}"},
            ]:
                worker.stdin.write(json.dumps(item) + "\n")
            worker.stdin.close()
            result = [json.loads(line) for line in worker.stdout]
            worker.wait(timeout=15)
            self.assertEqual(worker.returncode, 0, worker.stderr.read())
            by_id = {item["id"]: item for item in result}
            self.assertEqual(by_id[1]["status"], 200)
            self.assertEqual(json.loads(by_id[1]["body"])["ok"], True)
            self.assertEqual(by_id[2]["status"], 401)
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)
            worker.stdout.close()
            worker.stderr.close()


if __name__ == "__main__":
    unittest.main()
