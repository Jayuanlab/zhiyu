import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
import server


class PackagedBoundaries(unittest.TestCase):
    def test_private_service_health_requires_token_and_disabled_send_never_enters_gui(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = Mock()
            backend.health.return_value = {"backend": "fixture", "loginStatus": "unverified"}
            with patch.object(server, "create_wechat_client", return_value=backend):
                service = server.WeChatDesktopService("fixture-secret", 300, "fixture", False, set(), 6,
                    str(Path(directory) / "send-ledger.sqlite"), send_enabled=False)
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(service))
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()
            def request(method, path, body=None, token=None):
                connection = HTTPConnection("127.0.0.1", http.server_port, timeout=5)
                headers = {"Authorization": "Bearer " + token} if token else {}
                connection.request(method, path, json.dumps(body) if body is not None else None, headers)
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            try:
                self.assertEqual(request("GET", "/health")[0], 401)
                health = request("GET", "/health", token="fixture-secret")
                self.assertEqual(health[0], 200)
                self.assertFalse(health[1]["capabilities"]["send"])
                self.assertFalse(health[1]["capabilities"]["readMessages"])
                self.assertEqual(health[1]["loginStatus"], "unverified")
                preview = request("POST", "/preview", {"recipientName": "fixture", "message": "fixture"}, "fixture-secret")
                send = request("POST", "/send", {"recipientName": "fixture", "message": "fixture", "confirmToken": preview[1]["confirmToken"], "commandId": "fixture-id"}, "fixture-secret")
                self.assertEqual(send[0], 403)
                backend.send_message.assert_not_called()
                service.operation_lock.acquire()
                self.assertEqual(request("POST", "/shutdown", {}, "fixture-secret")[0], 409)
                service.operation_lock.release()
                self.assertEqual(request("POST", "/shutdown", {}, "fixture-secret")[0], 200)
                worker.join(5)
                self.assertFalse(worker.is_alive())
            finally:
                http.shutdown()
                http.server_close()
                worker.join(5)


if __name__ == "__main__":
    unittest.main()
