import json
import tempfile
import threading
import unittest
from pathlib import Path
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
import server


class SendHttpTests(unittest.TestCase):
    def test_authenticated_replay_and_unknown_status(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Mock()
            fake.send_message.return_value = {"sent": True}
            with patch.object(server, "create_wechat_client", return_value=fake):
                service = server.WeChatDesktopService("test-secret", 300, "fake", False, {"recipient"}, 100, str(Path(directory) / "ledger.sqlite"))
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(service))
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            def request(path, payload, token="test-secret"):
                connection = HTTPConnection("127.0.0.1", http.server_port, timeout=5)
                try:
                    connection.request("POST", path, json.dumps(payload), {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            try:
                token = service.confirmations.create("recipient", "message")
                body = {"commandId": "one", "recipientName": "recipient", "message": "message", "confirmToken": token}
                first = request("/send", body)
                self.assertEqual(first[0], 200)
                self.assertEqual(request("/send", body), first)
                self.assertEqual(fake.send_message.call_count, 1)
                self.assertEqual(request("/send", {**body, "message": "changed"})[0], 409)
                self.assertEqual(request("/send-status", {"commandId": "one"})[1]["status"], "sent")
                self.assertEqual(request("/send-status", {"commandId": "one"}, "wrong")[0], 401)
                fake.send_message.side_effect = TimeoutError("response lost")
                body = {**body, "commandId": "two", "confirmToken": service.confirmations.create("recipient", "message")}
                self.assertEqual(request("/send", body)[0], 409)
                self.assertEqual(request("/send", body)[0], 409)
                self.assertEqual(fake.send_message.call_count, 2)
                self.assertEqual(request("/send-status", {"commandId": "two"})[1]["status"], "unknown")
                resolution={"commandId":"two","recipientName":"recipient","message":"message","resolutionId":"resolution-two","decision":"not_sent","actorId":"owner","evidence":"Checked conversation with owner"}
                self.assertEqual(request("/resolve-send",resolution,"wrong")[0],401)
                self.assertEqual(request("/resolve-send",{**resolution,"evidence":""})[0],400)
                resolved=request("/resolve-send",resolution)
                self.assertEqual(resolved[0],200)
                self.assertEqual(resolved[1]["status"],"not_sent")
                self.assertEqual(request("/resolve-send",resolution),resolved)
                self.assertEqual(request("/send",body)[0],409)
                self.assertEqual(fake.send_message.call_count,2)
                self.assertEqual(request("/send-status",{"commandId":"two"})[1]["status"],"not_sent")
                self.assertEqual(request("/resolve-send",{**resolution,"decision":"sent"})[0],409)
                service.auth_token=""
                self.assertEqual(request("/resolve-send",resolution)[0],503)
            finally:
                http.shutdown()
                http.server_close()
                thread.join(5)


if __name__ == "__main__":
    unittest.main()
