"""Owned temporary PostgreSQL installer acceptance. No market/model/Web requests."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]
sys.path.insert(0, str(ROOT))
import psycopg
from psycopg.rows import dict_row


def main():
    temporary = Path(tempfile.mkdtemp(prefix="qinst-")).resolve()
    install = temporary / "install"
    data = temporary / "data"
    logs = temporary / "logs"
    resource = install / "components" / "quant"
    for path in [data, logs, resource]: path.mkdir(parents=True)
    (data / ".zhiyu-install-data").write_text("zhiyu-private-install-data-v1\n", encoding="utf-8")
    for folder in ["app", "config", "scripts"]:
        shutil.copytree(ROOT / folder, resource / folder, ignore=shutil.ignore_patterns("__pycache__", ".env"))
    shutil.copyfile(ROOT / "embedded_worker.py", resource / "embedded_worker.py")
    postgres = WORKSPACE / "output" / "windows-toolchain" / "extracted" / "pgsql" / "bin"
    payload = WORKSPACE / "output" / "windows-installer" / "payload-0.5.0"
    node = payload / "vendor" / "node" / "node.exe"
    migration = (payload / "migrations" / "migrate.mjs").resolve()
    owner, account = str(uuid.uuid4()), str(uuid.uuid4())
    password, role_password = secrets.token_hex(24), secrets.token_hex(24)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
    admin = f"postgresql://zhiyu:{password}@127.0.0.1:{port}/zhiyu"
    dedicated = f"postgresql://zhiyu_quant:{role_password}@127.0.0.1:{port}/zhiyu"
    system_root = os.environ.get("SystemRoot", "C:\\Windows")
    env = {"SystemRoot": system_root, "WINDIR": system_root, "TEMP": str(temporary), "TMP": str(temporary),
           "PATH": os.pathsep.join([str(postgres), str(node.parent), str(Path(system_root) / "System32")]),
           "ZHIYU_QUANT_INSTALL_MODE": "1", "ZHIYU_INSTALL_ROOT": str(install), "ZHIYU_INSTALL_DATA_DIR": str(data),
           "ZHIYU_QUANT_RESOURCE_DIR": str(resource), "QUANT_DATA_DIR": str(data / "quant"), "QUANT_TDX_LOCAL_ENABLED": "false",
           "QUANT_PAPER_OWNER_ID": owner, "ZHIYU_RUNTIME_OWNER_ID": owner, "QUANT_PAPER_ACCOUNT_ID": account,
           "QUANT_INSTALL_BOOTSTRAP_COMMAND_ID": "install-init:" + account, "QUANT_INSTALL_DATABASE_ROLE": "zhiyu_quant",
           "QUANT_INSTALL_DATABASE_PASSWORD": role_password, "QUANT_INSTALL_ADMIN_DATABASE_URL": admin,
           "QUANT_PAPER_DATABASE_URL": dedicated, "QUANT_PAPER_SIGNING_KEY": secrets.token_hex(24), "QUANT_INTERNAL_TOKEN": secrets.token_hex(24),
           "POSTGRES_URL": admin, "ZHIYU_BOOTSTRAP_DB_URL": f"postgresql://zhiyu:{password}@127.0.0.1:{port}/postgres", "ZHIYU_BOOTSTRAP_OWNER_ID": owner}
    report = {"directory": str(temporary), "ownerId": owner, "accountId": account, "port": port, "startedAt": datetime.now(timezone.utc).isoformat(), "checks": [], "stopConfirmed": False}
    def save(): (temporary / "quant-installation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    def check(name, **detail): report["checks"].append({"name": name, "passed": True, **detail}); save()
    def command(executable, args, name, timeout=90, accepted=(0,)):
        # PostgreSQL can inherit Windows pipe handles beyond pg_ctl's lifetime.
        # Wait on this exact child, with output going to an owned log file.
        log_path = logs / (name + ".log")
        with log_path.open("w", encoding="utf-8") as log:
            result = subprocess.run([str(executable), *args], cwd=data, env=env, stdout=log, stderr=log, timeout=timeout)
        output = log_path.read_text(encoding="utf-8")
        for secret in [password, role_password, env["QUANT_PAPER_SIGNING_KEY"], env["QUANT_INTERNAL_TOKEN"]]: output = output.replace(secret, "[redacted]")
        log_path.write_text(output, encoding="utf-8")
        if result.returncode not in accepted: raise RuntimeError(name + "_failed")
        return result
    save()
    print(json.dumps({"event": "quant_installation_smoke_started", "directory": str(temporary), "port": port}))
    try:
        password_file = data / "initdb-password"
        password_file.write_text(password, encoding="utf-8")
        command(postgres / "initdb.exe", ["-D", str(data / "postgres"), "--username=zhiyu", "--pwfile=" + str(password_file), "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"], "initdb")
        password_file.unlink()
        command(postgres / "pg_ctl.exe", ["-D", str(data / "postgres"), "-l", str(logs / "postgres.log"), "-w", "-t", "60", "-o", f"-h 127.0.0.1 -p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=", "start"], "postgres-start")
        command(node, ["--conditions=react-server", str(migration)], "migrations", timeout=180)
        with psycopg.connect(admin) as migrated:
            assert str(migrated.execute('SELECT id FROM "User" WHERE id=%s', (owner,)).fetchone()[0]) == owner
            migration_count = migrated.execute("SELECT count(*) FROM drizzle.__drizzle_migrations").fetchone()[0]
        check("owned private cluster full migrations and independent owner", migrationCount=migration_count)
        with patch.dict(os.environ, env, clear=True):
            from app.install_bootstrap import initialize, health
            from app.paper_ledger import PaperLedger
            from app.paper_ledger_model import PaperLedgerError
            from app.paper_commands import PaperActor, PaperTradingService
            first = initialize()
            second = initialize()
            assert first == second
            initial_health = health()
            assert initial_health["version"] == 1 and initial_health["orders"] == initial_health["lots"] == initial_health["fills"] == 0
            check("fresh empty account bootstrap and identical replay", receipt=first, health=initial_health)
            with psycopg.connect(admin, row_factory=dict_row) as conn:
                row = conn.execute("SELECT (SELECT count(*) FROM paper_accounts) AS accounts,(SELECT count(*) FROM paper_commands) AS commands,(SELECT count(*) FROM paper_events) AS events").fetchone()
                assert row == {"accounts": 1, "commands": 1, "events": 1}
                conn.execute('CREATE TABLE quant_unrelated_fixture(id int)')
                capabilities = conn.execute("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='zhiyu_quant'").fetchone()
                assert not any(capabilities.values())
            for statement in ['SELECT * FROM "User"', 'INSERT INTO quant_unrelated_fixture VALUES(1)', 'DELETE FROM paper_accounts', 'CREATE TABLE should_not_exist(id int)']:
                with psycopg.connect(dedicated) as restricted:
                    try: restricted.execute(statement)
                    except psycopg.errors.InsufficientPrivilege: pass
                    else: raise AssertionError("restricted_role_action_allowed")
            check("dedicated role denies User unrelated tables deletion and schema creation", capabilities=capabilities)
            # Fixed observations are injected. No source/model request is possible.
            now = datetime.fromisoformat("2026-09-08T10:00:00+08:00")
            code = "600519.SH"
            snapshot = {"watchlist": [code], "watchlistVersion": "fixture-v1", "watchlistObservedAt": now.isoformat(), "watchlistExpiresAt": (now + timedelta(seconds=30)).isoformat(),
                        "calendar": {"version": "fixture-calendar", "date": "2026-09-08", "source": {"SH": "fixture", "SZ": "fixture", "BJ": "fixture"}, "publishedAt": (now - timedelta(days=1)).isoformat(), "expiresAt": (now + timedelta(days=1)).isoformat(), "isTradingDay": True},
                        "quotePolicy": {"version": "fixture-policy", "sources": {"fixture": {"maxAgeSeconds": 30}}},
                        "quotes": {code: {"code": code, "name": "\u9694\u79bb\u884c\u60c5", "price": "10.000", "previousClose": "10.000", "provider": "fixture", "observedAt": now.isoformat(), "quoteSessionDate": "2026-09-08", "qualityStatus": "ready", "quoteId": "fixture-quote"}}}
            ledger = PaperLedger(dedicated)
            service = PaperTradingService(ledger, lambda: snapshot, clock=lambda: now, control_guard=lambda: None)
            actor = PaperActor(owner, "owner:" + owner, "owner")
            submit = service.submit(actor, account, "fixture-submit", {"code": code, "side": "buy", "quantity": 100, "limit_price": "10.00"})
            assert submit["result"]["status"] == "accepted"
            replay = service.submit(actor, account, "fixture-submit", {"code": code, "side": "buy", "quantity": 100, "limit_price": "10.00"})
            assert submit == replay
            match = service.match_tick(PaperActor(owner, "fixture-scheduler", "scheduler"), account, "fixture-tick")
            assert len(match["result"]["matched"]) == 1
            evolved = ledger.read(owner, account)
            assert len(evolved["state"]["fills"]) == len(evolved["state"]["lots"]) == 1
            check("restricted role owner-domain submit replay and fixed-market match", version=evolved["version"], fills=1, realMarketCalls=0)
            repeated = initialize()
            assert repeated == first and ledger.read(owner, account) == evolved
            (data / "quant" / "watchlist.json").write_text('{"codes":["600519"]}\n', encoding="utf-8")
            initialize()
            assert json.loads((data / "quant" / "watchlist.json").read_text(encoding="utf-8"))["codes"] == ["600519"]
            check("reinitialize preserves accumulated ledger and explicit watchlist")
            with patch.dict(os.environ, {"QUANT_INSTALL_BOOTSTRAP_COMMAND_ID": "changed-command"}):
                try: initialize()
                except PaperLedgerError as error: assert str(error) == "command_payload_conflict"
                else: raise AssertionError("command_change_not_rejected")
            with patch.dict(os.environ, {"QUANT_INSTALL_DATABASE_ROLE": "zhiyu_quant_unknown", "QUANT_PAPER_ACCOUNT_ID": str(uuid.uuid4()), "QUANT_PAPER_DATABASE_URL": dedicated.replace("zhiyu_quant:", "zhiyu_quant_unknown:")}):
                with psycopg.connect(admin) as conn: conn.execute("CREATE ROLE zhiyu_quant_unknown LOGIN")
                try: initialize()
                except PaperLedgerError as error: assert str(error) == "quant_install_role_not_owned"
                else: raise AssertionError("unowned_role_not_rejected")
            with psycopg.connect(admin) as conn:
                assert conn.execute("SELECT count(*) FROM paper_accounts").fetchone()[0] == 1
            check("changed init command and unowned existing role rejected with transaction rollback")
            # Local ASGI requests retain method/body/owner HMAC guards and do not generate.
            import httpx
            from app.main import app
            def headers(path, owner_id=owner, method="GET", body=b""):
                claims = {"ownerId": owner_id, "role": "owner", "actorId": "fixture-owner", "issuedAt": time.time(), "expiresAt": time.time() + 60, "method": method, "path": path, "bodySha256": hashlib.sha256(body).hexdigest()}
                encoded = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).decode().rstrip("=")
                return {"authorization": "Bearer " + env["QUANT_INTERNAL_TOKEN"], "x-zhiyu-paper-context": encoded, "x-zhiyu-paper-signature": hmac.new(env["QUANT_PAPER_SIGNING_KEY"].encode(), encoded.encode(), hashlib.sha256).hexdigest()}
            async def api_checks():
                path = "/paper/v2/accounts/" + account
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated.local") as client:
                    assert (await client.get(path)).status_code == 401
                    valid = await client.get(path, headers=headers(path)); assert valid.status_code == 200
                    assert (await client.get(path, headers=headers(path, str(uuid.uuid4())))).status_code == 403
                    invalid = headers(path); invalid["x-zhiyu-paper-signature"] = "0" * 64
                    assert (await client.get(path, headers=invalid)).status_code == 401
                    order_path = path + "/orders"
                    body = json.dumps({"commandId": "wrong-method", "code": code, "side": "buy", "quantity": 100, "limit_price": "10.00"}).encode()
                    invalid = headers(order_path, method="GET", body=body); invalid["content-type"] = "application/json"
                    assert (await client.post(order_path, headers=invalid, content=body)).status_code == 401
            asyncio.run(api_checks())
            check("ASGI authenticated account read and missing forged wrong-owner wrong-method denial")
            command(sys.executable, ["-I", "-B", "-X", "utf8", "-u", str(resource / "scripts" / "install_bootstrap.py"), "--health"], "health-cli")
            health_event = json.loads((logs / "health-cli.log").read_text(encoding="utf-8"))
            assert health_event["event"] == "quant_install_health" and health_event["ok"] and health_event["ownerBound"]
            check("health CLI fixed event and actual restricted account read", health=health_event)
        report["passed"] = True
    except Exception as error:
        import traceback
        diagnostic = traceback.format_exc()
        for secret in [password, role_password, env["QUANT_PAPER_SIGNING_KEY"], env["QUANT_INTERNAL_TOKEN"]]: diagnostic = diagnostic.replace(secret, "[redacted]")
        (logs / "failure.log").write_text(diagnostic, encoding="utf-8")
        report["passed"] = False
        report["errorType"] = type(error).__name__
    finally:
        if (data / "postgres" / "PG_VERSION").exists():
            command(postgres / "pg_ctl.exe", ["-D", str(data / "postgres"), "-m", "fast", "-w", "-t", "60", "stop"], "postgres-stop", accepted=(0, 1))
            status = command(postgres / "pg_ctl.exe", ["-D", str(data / "postgres"), "status"], "postgres-final-status", accepted=(3,))
            report["stopConfirmed"] = status.returncode == 3
        report["finishedAt"] = datetime.now(timezone.utc).isoformat(); save()
        print(json.dumps({"event": "quant_installation_smoke_finished", "directory": str(temporary), "passed": report.get("passed", False), "checks": len(report["checks"]), "stopConfirmed": report["stopConfirmed"], "errorType": report.get("errorType")}))
    return 0 if report.get("passed") and report["stopConfirmed"] else 1


if __name__ == "__main__": sys.exit(main())
