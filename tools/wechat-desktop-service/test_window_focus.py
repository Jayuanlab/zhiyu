import importlib.util
import sys
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("wechat_service_under_test", Path(__file__).with_name("server.py"))
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)


class WindowFocusTests(unittest.TestCase):
    def make_client(self):
        client = service.WindowAutomationWeChatClient()
        modules = {name: Mock() for name in (
            "pythoncom", "win32api", "win32clipboard", "win32con", "win32gui", "win32process"
        )}
        modules["win32gui"].GetForegroundWindow.return_value = 999
        modules["win32gui"].IsIconic.return_value = False
        modules["win32gui"].IsWindow.return_value = False
        client._import_windows_modules = Mock(return_value=modules)
        client._find_wechat_window = Mock(return_value=123)
        client._activate_window = Mock()
        client._get_clipboard_text = Mock(return_value="")
        client._set_clipboard_text = Mock()
        client._paste_text = Mock()
        client._send_hotkey = Mock()
        client._send_key = Mock()
        return client, modules

    def test_no_input_when_activation_does_not_leave_wechat_foreground(self):
        client, _ = self.make_client()
        with patch.object(service.time, "sleep"):
            with self.assertRaises(service.ServiceError):
                client._send_via_window("recipient", "message")
        client._paste_text.assert_not_called()
        client._send_hotkey.assert_not_called()
        client._send_key.assert_not_called()

    def test_focus_loss_before_enter_does_not_submit_to_other_window(self):
        client, modules = self.make_client()
        modules["win32gui"].GetForegroundWindow.side_effect = [999, 123, 123, 123, 123, 999]
        with patch.object(service.time, "sleep"):
            with self.assertRaises(service.ServiceError):
                client._send_via_window("recipient", "message")
        self.assertEqual(client._send_hotkey.call_count, 3)
        client._send_key.assert_not_called()

    def test_powershell_failure_is_not_reported_as_sent(self):
        client, _ = self.make_client()
        with patch.object(service.subprocess, "run", return_value=Mock(returncode=1, stderr="WeChat is not foreground", stdout="")) as run:
            with self.assertRaises(service.ServiceError):
                client._send_via_powershell("recipient", "message")
        self.assertEqual(run.call_args.kwargs["creationflags"], service.subprocess.CREATE_NO_WINDOW)

    def test_powershell_success_minimizes_and_restores_previous_window(self):
        client, modules = self.make_client()
        client._minimize_after_send = True
        modules["win32gui"].IsWindow.return_value = True
        with patch.object(service.subprocess, "run", return_value=Mock(returncode=0)):
            client._send_via_powershell("recipient", "message")
        modules["win32gui"].ShowWindow.assert_called_once_with(123, modules["win32con"].SW_MINIMIZE)
        modules["win32gui"].SetForegroundWindow.assert_called_once_with(999)

    def test_powershell_failure_restores_original_minimized_state(self):
        client, modules = self.make_client()
        modules["win32gui"].IsIconic.return_value = True
        modules["win32gui"].IsWindow.return_value = True
        with patch.object(service.subprocess, "run", side_effect=TimeoutError("test timeout")):
            with self.assertRaises(TimeoutError):
                client._send_via_powershell("recipient", "message")
        modules["win32gui"].ShowWindow.assert_called_once_with(123, modules["win32con"].SW_MINIMIZE)
        modules["win32gui"].SetForegroundWindow.assert_called_once_with(999)


if __name__ == "__main__":
    unittest.main()
