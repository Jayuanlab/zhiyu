import tempfile
import unittest
import threading
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from send_ledger import SendLedger, SendConflict, SendUnknown
from dispatch_lock import DispatchBusy


class SendLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ledger.sqlite"
        self.ledger = SendLedger(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_replay_survives_restart_and_does_not_reauthorize(self):
        sent = []
        result = self.ledger.execute("one", "recipient", "message", lambda: None, lambda: sent.append(1) or {"sent": True})
        replay = SendLedger(self.path).execute("one", "recipient", "message", lambda: self.fail("reauthorize"), lambda: self.fail("resend"))
        self.assertEqual(result, replay)
        self.assertEqual(sent, [1])
        with self.assertRaises(SendConflict):
            self.ledger.execute("one", "recipient", "changed", lambda: None, lambda: None)

    def test_failure_after_effect_never_dispatches_again(self):
        sent = []
        def send():
            sent.append(1)
            raise TimeoutError("response lost")
        with self.assertRaises(SendUnknown):
            self.ledger.execute("one", "recipient", "message", lambda: None, send)
        with self.assertRaises(SendUnknown):
            SendLedger(self.path).execute("one", "recipient", "message", lambda: None, send)
        self.assertEqual(sent, [1])

    def test_parallel_requests_dispatch_once(self):
        entered = threading.Event()
        release = threading.Event()
        def send():
            entered.set()
            release.wait(5)
            return {"sent": True}
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(self.ledger.execute, "one", "recipient", "message", lambda: None, send)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaises(SendUnknown):
                    SendLedger(self.path).execute("one", "recipient", "message", lambda: None, lambda: self.fail("duplicate"))
            finally:
                release.set()
            self.assertEqual(first.result(), {"sent": True})

    def test_process_exit_leaves_unknown_without_redispatch(self):
        code = "from send_ledger import SendLedger; import os,sys; SendLedger(sys.argv[1]).execute('crash','r','m',lambda:None,lambda:os._exit(23))"
        result = subprocess.run([sys.executable, "-c", code, str(self.path)], cwd=Path(__file__).parent)
        self.assertEqual(result.returncode, 23)
        with self.assertRaises(SendUnknown):
            SendLedger(self.path).execute("crash", "r", "m", lambda: None, lambda: self.fail("redispatch"))
        self.assertEqual(SendLedger(self.path).execute("new-command", "r", "m", lambda: None, lambda: {"sent": True}), {"sent": True})

    def test_authorization_failure_has_no_dispatch_intent(self):
        def deny():
            raise PermissionError("denied")
        with self.assertRaises(PermissionError):
            self.ledger.execute("one", "r", "m", deny, lambda: self.fail("send"))
        self.assertEqual(self.ledger.execute("one", "r", "m", lambda: None, lambda: {"sent": True}), {"sent": True})

    def test_resolution_tombstone_blocks_a_delayed_original_request(self):
        args=("one", "r", "m", "resolution-one", "not_sent", "owner", "Checked conversation after service stopped")
        receipt=self.ledger.resolve(*args)
        self.assertEqual(receipt["status"], "not_sent")
        self.assertEqual(SendLedger(self.path).resolve(*args), receipt)
        with self.assertRaises(SendConflict):
            SendLedger(self.path).execute("one", "r", "m", lambda:self.fail("authorize"), lambda:self.fail("late send"))
        with self.assertRaises(SendConflict):
            self.ledger.resolve("one", "r", "changed", *args[3:])
        with self.assertRaises(SendConflict):
            self.ledger.resolve("one", "r", "m", "resolution-one", "sent", "owner", args[-1])
        self.assertEqual(self.ledger.status("one"), receipt)

    def test_resolution_cannot_overwrite_a_known_sent_receipt(self):
        self.ledger.execute("one", "r", "m", lambda:None, lambda:{"sent":True})
        with self.assertRaises(SendConflict):
            self.ledger.resolve("one", "r", "m", "resolution-one", "not_sent", "owner", "Checked conversation")
        self.assertEqual(self.ledger.status("one")["status"], "sent")

    def test_unknown_can_be_resolved_by_owner_evidence(self):
        def uncertain():
            raise TimeoutError("unknown")
        with self.assertRaises(SendUnknown):
            self.ledger.execute("one", "r", "m", lambda:None, uncertain)
        receipt=self.ledger.resolve("one", "r", "m", "resolution-one", "sent", "owner", "Matched message and recipient in conversation")
        self.assertEqual(receipt["result"]["resolution"]["source"], "owner_attestation")
        self.assertEqual(receipt["result"]["resolution"]["actorId"], "owner")
        self.assertEqual(SendLedger(self.path).status("one"), receipt)
        self.assertEqual(self.ledger.execute("one", "r", "m", lambda:self.fail("authorize"), lambda:self.fail("resend")), receipt["result"])

    def test_resolution_and_gui_dispatch_are_mutually_exclusive(self):
        entered=threading.Event(); release=threading.Event()
        def send():
            entered.set(); release.wait(10); return {"sent":True}
        with ThreadPoolExecutor(1) as pool:
            first=pool.submit(self.ledger.execute,"one","r","m",lambda:None,send)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaises(DispatchBusy):
                    self.ledger.resolve("one","r","m","resolution-one","not_sent","owner","Checked conversation")
                code="from send_ledger import SendLedger; from dispatch_lock import DispatchBusy; import sys\ntry: SendLedger(sys.argv[1]).resolve('one','r','m','resolution-two','not_sent','owner','Checked conversation')\nexcept DispatchBusy: sys.exit(17)"
                result=subprocess.run([sys.executable,"-c",code,str(self.path)],cwd=Path(__file__).parent)
                self.assertEqual(result.returncode,17)
            finally:
                release.set()
            first.result()
        self.assertEqual(self.ledger.status("one")["status"],"sent")

    def test_resolution_receipt_failure_rolls_back_the_tombstone(self):
        with self.ledger._connect() as db:
            db.execute("CREATE TRIGGER fail_resolution BEFORE INSERT ON send_resolutions BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END")
        with self.assertRaises(Exception):
            self.ledger.resolve("one","r","m","resolution-one","not_sent","owner","Checked conversation")
        self.assertEqual(self.ledger.status("one"),{"status":"not_found"})

    def test_different_commands_cannot_dispatch_across_processes(self):
        entered = threading.Event()
        release = threading.Event()
        def send():
            entered.set()
            release.wait(10)
            return {"sent": True}
        with ThreadPoolExecutor(1) as pool:
            first = pool.submit(self.ledger.execute, "one", "r", "m", lambda: None, send)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaises(DispatchBusy):
                    self.ledger.execute("two", "r", "m", lambda: self.fail("must not authorize"), lambda: self.fail("must not send"))
                code = "from send_ledger import SendLedger; from dispatch_lock import DispatchBusy; import sys\ntry: SendLedger(sys.argv[1]).execute('three','r','m',lambda:None,lambda:sys.exit(99))\nexcept DispatchBusy: sys.exit(17)"
                result = subprocess.run([sys.executable, "-c", code, str(self.path)], cwd=Path(__file__).parent)
                self.assertEqual(result.returncode, 17)
                self.assertEqual(self.ledger.status("two"), {"status": "not_found"})
            finally:
                release.set()
            first.result()
        self.assertEqual(self.ledger.execute("two", "r", "m", lambda: None, lambda: {"sent": True}), {"sent": True})


if __name__ == "__main__":
    unittest.main()
