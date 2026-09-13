import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from starlette.requests import Request
from starlette.responses import JSONResponse
from app.main import app, internal_write_boundary, paper_order, PaperOrderRequest


async def call_boundary(method, path, headers=None, next_handler=None):
    request = Request({"type": "http", "method": method, "path": path, "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()], "scheme": "http", "server": ("127.0.0.1", 8766), "query_string": b""})
    async def unexpected(_):
        raise AssertionError("Denied request reached the executor")
    return await internal_write_boundary(request, next_handler or unexpected)


class InternalIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_quant_all_write_routes_require_credentials_before_execution(self):
        with patch.dict(os.environ, {"QUANT_INTERNAL_TOKEN": "test-only-token"}):
            for route in app.routes:
                for method in getattr(route, "methods", set()) & {"POST", "PUT", "PATCH", "DELETE"}:
                    path = route.path.replace("{order_id}", "test-order")
                    for headers in ({}, {"Authorization": "Bearer wrong"}):
                        self.assertEqual((await call_boundary(method, path, headers)).status_code, 401, path)

    async def test_valid_quant_credential_reaches_only_fake_executor(self):
        async def fake_route(_):
            return JSONResponse(paper_order(PaperOrderRequest(code="000001", side="buy", quantity=100, limit_price=10)))
        with patch.dict(os.environ, {"QUANT_INTERNAL_TOKEN": "test-only-token"}), patch("app.main.place_paper_order", return_value={"fake": True}) as executor:
            response = await call_boundary("POST", "/paper/orders", {"Authorization": "Bearer test-only-token"}, fake_route)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.body, b'{"fake":true}')
            executor.assert_called_once()

    async def test_missing_configuration_never_allows_anonymous_write(self):
        with patch.dict(os.environ, {"QUANT_INTERNAL_TOKEN": ""}):
            self.assertEqual((await call_boundary("POST", "/paper/orders")).status_code, 401)

    def test_wechat_rejects_missing_and_invalid_credentials(self):
        path = Path(__file__).resolve().parents[2] / "wechat-desktop-service" / "server.py"
        spec = importlib.util.spec_from_file_location("test_wechat_identity", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        with patch.object(sys, "path", [str(path.parent), *sys.path]):
            spec.loader.exec_module(module)
        service = object.__new__(module.WeChatDesktopService)  # No real desktop adapter.
        service.auth_token = None
        with self.assertRaises(module.ServiceError): service.require_auth({})
        service.auth_token = "test-only-token"
        for headers in ({}, {"Authorization": "Bearer wrong"}):
            with self.assertRaises(module.ServiceError): service.require_auth(headers)
        service.require_auth({"Authorization": "Bearer test-only-token"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
