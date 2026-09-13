"""Real PostgreSQL + independent-process fault injection, launched by isolated DB harness."""
import copy
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DAILY_ROOT = (ROOT / "data").resolve()
DAILY_WRITE_ATTEMPTS = []


def deny_daily_file_writes(event, args):
    def protected(value):
        return isinstance(value, (str, bytes, os.PathLike)) and Path(os.fsdecode(value)).resolve().is_relative_to(DAILY_ROOT)
    writing = False
    targets = []
    if event == "open":
        path, mode, flags = args
        writing = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        targets = [path]
    elif event in {"os.rename", "os.remove", "os.rmdir", "os.mkdir", "os.truncate", "os.utime"}:
        writing = True
        targets = args[:2] if event == "os.rename" else args[:1]
    if writing and any(protected(path) for path in targets):
        DAILY_WRITE_ATTEMPTS.append(event)
        raise RuntimeError("TEST_DAILY_PAPER_WRITE_DENIED")


sys.addaudithook(deny_daily_file_writes)
from app.paper_ledger import PaperLedger
from app.paper_ledger_model import PaperLedgerError, canonical, validate_state, state_digest
from app.paper_commands import PaperTradingService, PaperActor

URL = os.environ["QUANT_PAPER_DATABASE_URL"]
if not urlparse(URL).path.startswith("/zhiyu_test_") or urlparse(URL).hostname not in {"127.0.0.1", "localhost"}:
    raise RuntimeError("isolated database required")
OWNER = os.environ["PAPER_TEST_OWNER"]
NOW = "2026-09-08T10:00:00+08:00"


def fresh():
    return {"id": str(uuid.uuid4()), "initial_cash": 1000000, "cash": 1000000, "frozen_cash": 0,
            "realized_pnl": 0, "lots": [], "orders": [], "fills": [], "created_at": NOW, "updated_at": NOW}


def reserve(state, key):
    value = Decimal("95.70")
    state["cash"] -= value
    state["frozen_cash"] += value
    order = {"id": key, "code": "159278.SZ", "side": "buy", "status": "submitted", "quantity": 100,
             "remaining_quantity": 100, "limit_price": Decimal("0.957"), "created_at": NOW, "updated_at": NOW,
             "note": "isolated ledger fixture"}
    state["orders"].append(order)
    return {"orderId": key}


def fill(state, key):
    order = next(row for row in state["orders"] if row["id"] == key)
    if order["status"] != "submitted":
        return {"status": order["status"]}
    state["frozen_cash"] -= Decimal("95.70")
    order.update(status="filled", remaining_quantity=0)
    state["fills"].append({"id": f"fill-{key}", "execution_key": f"tick-{key}", "order_id": key,
        "code": order["code"], "side": "buy", "quantity": 100, "price": Decimal("0.957"),
        "amount": Decimal("95.70"), "filled_at": NOW})
    state["lots"].append({"id": f"lot-{key}", "code": order["code"], "quantity": 100,
        "remaining_quantity": 100, "cost_price": Decimal("0.957"), "trade_date": "2026-09-08", "created_at": NOW})
    return {"filled": key}


def cancel(state, key):
    order = next(row for row in state["orders"] if row["id"] == key)
    if order["status"] != "submitted":
        return {"status": order["status"]}
    order["status"] = "cancelled"
    state["cash"] += Decimal("95.70")
    state["frozen_cash"] -= Decimal("95.70")
    return {"cancelled": key}


class CrashConnection:
    def __init__(self, connection, marker):
        self.connection, self.marker = connection, marker

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, *args):
        return self.connection.__exit__(*args)

    def execute(self, query, params=None):
        result = self.connection.execute(query, params)
        if self.marker in query:
            os._exit(73)
        return result


def child(account_id, action, key, crash=""):
    ledger = PaperLedger(URL)
    if crash:
        connect = ledger._connect
        ledger._connect = lambda: CrashConnection(connect(), crash)
    handler = {"reserve": reserve, "fill": fill, "cancel": cancel}[action]
    ledger.command(OWNER, account_id, f"{action}-{key}", action, "test-owner", {"key": key}, lambda s: handler(s, key))


class LedgerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zhiyu_test_paper_")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "source.json"
        self.raw = fresh()
        self.path.write_text(canonical(self.raw), encoding="utf-8")
        self.ledger = PaperLedger(URL)
        self.batch = str(uuid.uuid4())
        result = self.ledger.import_file(OWNER, self.path, dry_run=False, controllers_stopped=True,
            backup_dir=Path(self.temp.name) / "backup", migration_batch_id=self.batch)
        self.account = result["accountId"]

    def spawn(self, action, key, crash=""):
        return subprocess.Popen([sys.executable, __file__, "child", self.account, action, key, crash],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def joined(self, processes, expected=0):
        for proc in processes:
            try:
                out, err = proc.communicate(timeout=35)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                self.fail("child did not terminate")
            self.assertEqual(proc.returncode, expected, err.decode("utf-8", errors="replace"))


class LedgerTests(LedgerFixture):
    def test_concurrent_reservations_and_cancel_match(self):
        self.joined([self.spawn("reserve", str(i)) for i in range(6)])
        view = self.ledger.read(OWNER, self.account)
        self.assertEqual(len(view["state"]["orders"]), 6)
        self.assertEqual(view["state"]["frozen_cash"], Decimal("574.20"))
        self.assertEqual(view["version"], 6)
        self.joined([self.spawn(action, "0") for action in ("fill", "fill", "cancel")])
        state = self.ledger.read(OWNER, self.account)["state"]
        self.assertLessEqual(len(state["fills"]), 1)
        self.assertEqual(state["frozen_cash"], Decimal("478.50"))
        validate_state(state)

    def test_replay_conflict_owner_and_version(self):
        args = (OWNER, self.account, "same", "reserve", "owner", {"key": "a"})
        result = self.ledger.command(*args, lambda s: reserve(s, "a"), expected_version=0)
        self.assertEqual(result, self.ledger.command(*args, lambda s: self.fail("replay ran callback"), expected_version=0))
        self.assertEqual(self.ledger.receipt(OWNER, self.account, "same"), result)
        with self.assertRaisesRegex(PaperLedgerError, "command_payload_conflict"):
            self.ledger.command(OWNER, self.account, "same", "reserve", "owner", {"key": "b"}, lambda s: reserve(s, "b"))
        with self.assertRaisesRegex(PaperLedgerError, "account_version_conflict"):
            self.ledger.command(OWNER, self.account, "new", "reserve", "owner", {}, lambda s: reserve(s, "b"), expected_version=0)
        stranger = str(uuid.uuid4())
        with self.assertRaisesRegex(PaperLedgerError, "paper_account_not_found"):
            self.ledger.command(stranger, self.account, "other", "reserve", "owner", {}, lambda s: reserve(s, "b"))
        self.assertIsNone(self.ledger.receipt(stranger, self.account, "same"))

    def test_crash_at_every_persisted_phase(self):
        initial = self.ledger.read(OWNER, self.account)
        for marker in ("UPDATE paper_accounts", "INSERT INTO paper_orders", "INSERT INTO paper_commands", "INSERT INTO paper_events"):
            self.joined([self.spawn("reserve", "crash", marker)], expected=73)
            self.assertEqual(self.ledger.read(OWNER, self.account), initial)
            self.assertIsNone(self.ledger.receipt(OWNER, self.account, "reserve-crash"))
        self.joined([self.spawn("reserve", "crash")])
        self.assertEqual(self.ledger.read(OWNER, self.account)["version"], 1)

    def test_reads_do_not_change_version_or_ledger(self):
        first = self.ledger.read(OWNER, self.account)
        for _ in range(5):
            self.assertEqual(first, self.ledger.read(OWNER, self.account))
        with self.ledger._connect() as conn:
            counts = conn.execute("SELECT (SELECT count(*) FROM paper_commands WHERE account_id=%s) AS commands, "
                "(SELECT count(*) FROM paper_events WHERE account_id=%s) AS events", (self.account, self.account)).fetchone()
        self.assertEqual(counts, {"commands": 1, "events": 1})

    def test_import_dry_run_replay_backup_and_invalid(self):
        original = self.path.read_bytes()
        dry = self.ledger.import_file(OWNER, self.path)
        replay = self.ledger.import_file(OWNER, self.path, dry_run=False, controllers_stopped=True,
            backup_dir=Path(self.temp.name) / "backup", migration_batch_id=str(uuid.uuid4()))
        self.assertTrue(dry["dryRun"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["migrationBatchId"], self.batch)
        backup = next((Path(self.temp.name) / "backup").glob("*.json"))
        self.assertEqual(backup.read_bytes(), original)
        bad = dict(self.raw, cash=42)
        self.path.write_text(canonical(bad), encoding="utf-8")
        with self.assertRaisesRegex(PaperLedgerError, "not_conserved"):
            self.ledger.import_file(OWNER, self.path)
        self.assertEqual(self.ledger.read(OWNER, self.account)["version"], 0)

    def test_malformed_and_immutable_history(self):
        for key in ("cash", "lots", "created_at"):
            bad = copy.deepcopy(self.raw)
            del bad[key]
            with self.assertRaises(PaperLedgerError):
                validate_state(bad)
        for value in (float("nan"), float("inf"), True, -1, "1000000.001"):
            with self.assertRaises((PaperLedgerError, ValueError)):
                validate_state(dict(self.raw, cash=value))
        self.ledger.command(OWNER, self.account, "reserve", "reserve", "owner", {}, lambda s: reserve(s, "a"))
        before = self.ledger.read(OWNER, self.account)
        def erase(state):
            state["orders"] = []
            state["cash"] = state["initial_cash"]
            state["frozen_cash"] = Decimal(0)
            return {}
        with self.assertRaisesRegex(PaperLedgerError, "cannot_be_deleted"):
            self.ledger.command(OWNER, self.account, "erase", "erase", "owner", {}, erase)
        self.assertEqual(self.ledger.read(OWNER, self.account), before)

    def test_restricted_database_role(self):
        import psycopg
        for query in ('SELECT * FROM "User"', 'UPDATE workshops SET name=name', 'CREATE TABLE unauthorized_paper_probe(id int)'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with self.ledger._connect() as conn:
                    conn.execute(query)

    def test_nonempty_import_preserves_exact_state(self):
        snapshot = validate_state(fresh())
        reserve(snapshot, "bought")
        fill(snapshot, "bought")
        reserve(snapshot, "open")
        reserve(snapshot, "cancelled")
        cancel(snapshot, "cancelled")
        source = Path(self.temp.name) / "nonempty.json"
        source.write_text(canonical(snapshot), encoding="utf-8")
        result = self.ledger.import_file(OWNER, source, dry_run=False, controllers_stopped=True,
            backup_dir=Path(self.temp.name) / "backup", migration_batch_id=str(uuid.uuid4()))
        restored = self.ledger.read(OWNER, result["accountId"])["state"]
        for key in ("orders", "lots", "fills"):
            snapshot[key].sort(key=lambda row: row["id"])
        self.assertEqual(restored, snapshot)
        with self.assertRaisesRegex(PaperLedgerError, "import_requires"):
            self.ledger.import_file(OWNER, source, dry_run=False)

    def test_invalid_positions_fills_and_completed_history(self):
        self.ledger.command(OWNER, self.account, "buy", "reserve", "owner", {}, lambda s: reserve(s, "bought"))
        self.ledger.command(OWNER, self.account, "fill", "fill", "owner", {}, lambda s: fill(s, "bought"))
        before = self.ledger.read(OWNER, self.account)
        def rewrite(state):
            state["fills"][0]["note"] = "rewritten"
            return {}
        with self.assertRaisesRegex(PaperLedgerError, "cannot_be_rewritten"):
            self.ledger.command(OWNER, self.account, "rewrite", "rewrite", "owner", {}, rewrite)
        for change in ("lot", "fill", "remaining", "cost_basis"):
            bad = copy.deepcopy(before["state"])
            if change == "lot":
                bad["lots"][0]["remaining_quantity"] = 99
            elif change == "fill":
                bad["fills"][0]["amount"] = Decimal("95.71")
            elif change == "cost_basis":
                bad["lots"][0]["cost_price"] = Decimal("0.958")
            else:
                bad["orders"][0]["remaining_quantity"] = 1
            with self.assertRaises(PaperLedgerError):
                validate_state(bad)
        self.assertEqual(before, self.ledger.read(OWNER, self.account))


def market(now):
    return {"watchlistVersion": "fixture-watchlist-v1", "watchlist": ["159278.SZ", "600519.SH"],
        "watchlistObservedAt": (now - timedelta(seconds=1)).isoformat(), "watchlistExpiresAt": (now + timedelta(minutes=1)).isoformat(),
        "calendar": {"version": "fixture-calendar-v1", "source": "isolated official-calendar adapter",
            "publishedAt": (now - timedelta(days=1)).isoformat(), "expiresAt": (now + timedelta(days=1)).isoformat(),
            "date": now.date().isoformat(), "isTradingDay": True},
        "quotePolicy": {"version": "fixture-policy-v1", "sources": {"fixture": {"maxAgeSeconds": 30}}},
        "quotes": {code: {"code": code, "name": code, "price": price, "previousClose": price,
            "provider": "fixture", "qualityStatus": "ready", "quoteId": f"{code}:{now.isoformat()}",
            "observedAt": now.isoformat(), "quoteSessionDate": now.date().isoformat()}
            for code, price in [("159278.SZ", "0.957"), ("600519.SH", "1000.00")]}}


def domain_child(account_id, action, key, crash=""):
    now = datetime.fromisoformat(NOW)
    ledger = PaperLedger(URL)
    if crash:
        connect = ledger._connect
        ledger._connect = lambda: CrashConnection(connect(), crash)
    service = PaperTradingService(ledger, lambda: market(now), clock=lambda: now, control_guard=lambda: None)
    actor = PaperActor(OWNER, "owner", "owner")
    if action == "submit":
        result = service.submit(actor, account_id, key,
            {"code": "600519.SH", "side": "buy", "quantity": 300, "limit_price": "1000.00"})
    elif action == "match":
        result = service.match_tick(PaperActor(OWNER, "scheduler", "scheduler"), account_id, key)
    else:
        result = service.cancel(actor, account_id, f"cancel:{key}", key)
    print(canonical(result))


class DomainTests(LedgerFixture):
    def setUp(self):
        super().setUp()
        self.now = datetime.fromisoformat(NOW)
        self.snapshot = market(self.now)
        self.observations = 0
        self.actor = PaperActor(OWNER, "owner", "owner")
        self.scheduler = PaperActor(OWNER, "scheduler", "scheduler")
        def observe():
            self.observations += 1
            return self.snapshot
        self.service = PaperTradingService(self.ledger, observe, clock=lambda: self.now, control_guard=lambda: None)

    def buy(self, key="buy", **changes):
        return self.service.submit(self.actor, self.account, key,
            {"code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957", **changes})

    def tick(self, key="tick"):
        return self.service.match_tick(self.scheduler, self.account, key)

    def test_real_submit_tick_replay_and_read_event_hash(self):
        thesis = {"summary": "test thesis", "source": "isolated fixture"}
        result = self.buy(trade_thesis=thesis)
        self.assertEqual(result["result"]["status"], "accepted")
        self.assertEqual(self.ledger.read(OWNER, self.account)["state"]["fills"], [])
        tick = self.tick()
        self.assertEqual(len(tick["result"]["matched"]), 1)
        self.service.observe = lambda: self.fail("replayed command fetched quotes")
        self.assertEqual(self.buy(trade_thesis=thesis), result)
        with self.assertRaisesRegex(PaperLedgerError, "command_payload_conflict"):
            self.buy(trade_thesis={"summary": "changed thesis"})
        self.assertEqual(self.tick(), tick)
        state = self.ledger.read(OWNER, self.account)
        self.assertEqual(state["state"]["cash"], Decimal("999904.30"))
        self.assertEqual(state["state"]["frozen_cash"], 0)
        with self.ledger._connect() as conn:
            event = conn.execute("SELECT state_hash FROM paper_events WHERE account_id=%s AND version=%s",
                                 (self.account, state["version"])).fetchone()
        self.assertEqual(event["state_hash"], state_digest(state["state"]))

    def test_t1_sell_and_fifo_cash_conservation(self):
        self.buy(quantity=200)
        self.tick()
        sell = {"code": "159278.SZ", "side": "sell", "quantity": 100, "limit_price": "0.957"}
        result = self.service.submit(self.actor, self.account, "sell-same-day", sell)
        self.assertEqual(result["result"]["reasonCode"], "insufficient_t1_sell_quantity")
        self.now += timedelta(days=1)
        self.snapshot = market(self.now)
        self.assertEqual(self.service.submit(self.actor, self.account, "sell-next-day", sell)["result"]["status"], "accepted")
        sell["quantity"] = 200
        self.assertEqual(self.service.submit(self.actor, self.account, "oversell", sell)["result"]["reasonCode"], "insufficient_t1_sell_quantity")
        self.snapshot["quotes"]["159278.SZ"]["price"] = "0.967"
        self.tick("sell-tick")
        state = self.ledger.read(OWNER, self.account)["state"]
        self.assertEqual(state["realized_pnl"], Decimal("1.00"))
        self.assertEqual(state["cash"], Decimal("999905.30"))
        self.assertEqual(state["lots"][0]["remaining_quantity"], 100)

    def test_denied_roles_controls_and_invalid_inputs(self):
        request = {"code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957"}
        for role in ("hunter", "scheduler", "unknown"):
            with self.assertRaisesRegex(PaperLedgerError, "paper_actor_denied"):
                self.service.submit(PaperActor(OWNER, role, role), self.account, role, request)
        self.assertEqual(self.observations, 0)
        for changes in ({"quantity": 100.1}, {"quantity": 50}, {"limit_price": "NaN"}, {"limit_price": "0.9571"}):
            with self.assertRaises(PaperLedgerError):
                self.buy("invalid", **changes)
        self.service.control_guard = lambda: (_ for _ in ()).throw(PaperLedgerError("paper_trading_disabled"))
        with self.assertRaisesRegex(PaperLedgerError, "paper_trading_disabled"):
            self.buy()
        self.assertEqual(self.ledger.read(OWNER, self.account)["version"], 0)

    def test_actual_sample_provider_guard_blocks_transaction_before_observation(self):
        from app.provider import QuantProviderError
        service = PaperTradingService(self.ledger, lambda: self.fail("sample control fetched market"), clock=lambda: self.now)
        with patch.dict(os.environ, {"QUANT_DATA_PROVIDER": "sample", "QUANT_PAPER_TRADING_ENABLED": "true"}):
            with self.assertRaises(QuantProviderError):
                service.submit(self.actor, self.account, "sample-control", {"code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957"})
        self.assertEqual(self.ledger.read(OWNER, self.account)["version"], 0)

    def test_price_deviation_watchlist_and_cash_caps(self):
        self.assertEqual(self.buy("deviation", planned_price="0.930")["result"]["reasonCode"], "buy_price_exceeds_plan_tolerance")
        self.assertEqual(self.buy("limit", limit_price="1.100")["result"]["reasonCode"], "order_outside_price_limits")
        self.assertEqual(self.buy("large", quantity=400000)["result"]["reasonCode"], "single_order_exceeds_30_percent")
        self.assertEqual(self.buy("no-cash", quantity=2000000)["result"]["reasonCode"], "insufficient_cash")
        self.assertEqual(self.buy("valid", planned_price="0.940")["result"]["status"], "accepted")
        self.snapshot["watchlistExpiresAt"] = (self.now - timedelta(seconds=1)).isoformat()
        self.assertEqual(self.buy("expired-watchlist")["result"]["reasonCode"], "not_in_current_watchlist")
        self.snapshot = market(self.now)
        self.snapshot["watchlist"] = []
        self.assertEqual(self.buy("removed")["result"]["reasonCode"], "not_in_current_watchlist")

    def test_invalid_sessions_and_quotes_never_fill(self):
        self.buy()
        cases = [
            ("weekend", "2026-09-12T10:00:00+08:00", lambda s: None, "market_weekend"),
            ("lunch", "2026-09-08T12:00:00+08:00", lambda s: None, "outside_matching_session"),
            ("holiday", NOW, lambda s: s["calendar"].update(isTradingDay=False), "market_holiday"),
            ("calendar", NOW, lambda s: s.pop("calendar"), "calendar_unknown"),
            ("expired", NOW, lambda s: s["calendar"].update(expiresAt=NOW), "calendar_stale"),
            ("stale", NOW, lambda s: s["quotes"]["159278.SZ"].update(observedAt="2026-09-08T09:59:00+08:00"), "quote_stale"),
            ("future", NOW, lambda s: s["quotes"]["159278.SZ"].update(observedAt="2026-09-08T10:00:01+08:00"), "quote_from_future"),
            ("prior-day", NOW, lambda s: s["quotes"]["159278.SZ"].update(quoteSessionDate="2026-09-07"), "quote_session_mismatch"),
            ("sample", NOW, lambda s: s["quotes"]["159278.SZ"].update(qualityStatus="sample"), "quote_quality_unavailable"),
            ("policy", NOW, lambda s: s.pop("quotePolicy"), "quote_policy_unknown"),
        ]
        for key, at, change, expected in cases:
            self.now = datetime.fromisoformat(at)
            self.snapshot = market(self.now)
            change(self.snapshot)
            result = self.tick(key)
            self.assertEqual(list(result["result"]["waiting"].values()), [expected])
            self.assertEqual(self.ledger.read(OWNER, self.account)["state"]["fills"], [])
        self.now = datetime.fromisoformat(NOW)
        self.snapshot = market(self.now)
        self.assertEqual(len(self.tick("valid")["result"]["matched"]), 1)

    def test_quote_rechecked_after_account_lock_wait(self):
        self.buy()
        original = self.ledger.command
        def delayed(*args, **kwargs):
            self.now += timedelta(seconds=31)
            return original(*args, **kwargs)
        self.ledger.command = delayed
        result = self.tick()
        self.assertEqual(list(result["result"]["waiting"].values()), ["quote_stale"])

    def test_concurrent_real_orders_and_tick_cancel(self):
        def launch(action, key):
            return subprocess.Popen([sys.executable, __file__, "domain-child", self.account, action, key],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.joined([launch("submit", "one"), launch("submit", "two")])
        state = self.ledger.read(OWNER, self.account)["state"]
        self.assertEqual(len(state["orders"]), 1)
        self.assertEqual(state["frozen_cash"], Decimal("300000.00"))
        # The other command is durably rejected by the 40% cap including pending buys.
        receipts = [self.ledger.receipt(OWNER, self.account, key)["result"] for key in ("one", "two")]
        self.assertEqual(sorted(row["status"] for row in receipts), ["accepted", "rejected"])
        self.joined([launch("match", "same-tick"), launch("match", "same-tick"), launch("cancel", state["orders"][0]["id"])])
        state = self.ledger.read(OWNER, self.account)["state"]
        self.assertEqual(state["frozen_cash"], 0)
        self.assertLessEqual(len(state["fills"]), 1)
        validate_state(state)

    def test_cancel_replay_and_closed_window(self):
        order_id = self.buy()["result"]["order"]["id"]
        self.now = datetime.fromisoformat("2026-09-08T14:58:00+08:00")
        refused = self.service.cancel(self.actor, self.account, "closed", order_id)
        self.assertEqual(refused["result"]["reasonCode"], "exchange_cancel_window_closed")
        self.now = datetime.fromisoformat(NOW)
        self.service.control_guard = lambda: (_ for _ in ()).throw(PaperLedgerError("paper_trading_disabled"))
        result = self.service.cancel(self.actor, self.account, "cancel", order_id, reason="owner correction")
        self.assertEqual(self.service.cancel(self.actor, self.account, "cancel", order_id, reason="owner correction"), result)
        with self.assertRaisesRegex(PaperLedgerError, "command_payload_conflict"):
            self.service.cancel(self.actor, self.account, "cancel", order_id, reason="different correction")
        self.assertEqual(self.ledger.read(OWNER, self.account)["state"]["cash"], Decimal("1000000.00"))

    def test_real_matching_crash_rolls_back_fills_lots_and_cash(self):
        self.buy()
        before = self.ledger.read(OWNER, self.account)
        for marker in ("INSERT INTO paper_position_lots", "INSERT INTO paper_fills", "INSERT INTO paper_events"):
            process = subprocess.Popen([sys.executable, __file__, "domain-child", self.account, "match", "crash-tick", marker],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.joined([process], expected=73)
            self.assertEqual(before, self.ledger.read(OWNER, self.account))
            self.assertIsNone(self.ledger.receipt(OWNER, self.account, "crash-tick"))
        self.assertEqual(len(self.tick("crash-tick")["result"]["matched"]), 1)


class ApiTests(LedgerFixture):
    def setUp(self):
        super().setUp()
        from fastapi.testclient import TestClient
        from app.main import app
        self.now = datetime.fromisoformat(NOW)
        self.snapshot = market(self.now)
        self.service = PaperTradingService(self.ledger, lambda: self.snapshot, clock=lambda: self.now, control_guard=lambda: None)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.key = "isolated-paper-signing-key-with-32-characters"
        for context in (patch.dict(os.environ, {"QUANT_INTERNAL_TOKEN": "isolated-token", "QUANT_PAPER_SIGNING_KEY": self.key,
                                                "QUANT_PAPER_OWNER_ID": OWNER}),
                        patch("app.paper_api.service", return_value=self.service),
                        patch("app.paper_api.observe_paper_market", return_value=self.snapshot)):
            context.start()
            self.addCleanup(context.stop)
        self.path = f"/paper/v2/accounts/{self.account}"

    def headers(self, method, path, raw="", *, owner=OWNER, role="owner", changes=None):
        now = time.time()
        claims = {"ownerId": owner, "actorId": "test-actor", "role": role, "issuedAt": now, "expiresAt": now + 60,
                  "method": method, "path": path, "bodySha256": hashlib.sha256(raw.encode()).hexdigest(), **(changes or {})}
        encoded = base64.urlsafe_b64encode(canonical(claims).encode()).decode().rstrip("=")
        signature = hmac.new(self.key.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        return {"Authorization": "Bearer isolated-token", "Content-Type": "application/json",
                "X-Zhiyu-Paper-Context": encoded, "X-Zhiyu-Paper-Signature": signature}

    def post(self, suffix, body, **kwargs):
        raw = canonical(body)
        path = self.path + suffix
        return self.client.post(path, content=raw, headers=self.headers("POST", path, raw, **kwargs))

    def test_owner_migration_review_is_pure_and_role_bound(self):
        source = Path(self.temp.name) / "review.json"
        raw = canonical(self.ledger.read(OWNER, self.account)["state"]).encode()
        source.write_bytes(raw)
        before = source.stat().st_mtime_ns
        path = "/paper/v2/migration/review"
        with patch("app.paper_trading.PAPER_ACCOUNT_PATH", source):
            response = self.client.get(path, headers=self.headers("GET", path))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()["importAllowed"])
            self.assertEqual(response.json()["sourceHash"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(self.client.get(path).status_code, 401)
            self.assertEqual(self.client.get(path, headers=self.headers("GET", path, role="scheduler")).status_code, 403)
            self.assertEqual(self.client.get(path, headers=self.headers("GET", path, owner=str(uuid.uuid4()))).status_code, 403)
            self.assertEqual(source.read_bytes(), raw)
            self.assertEqual(source.stat().st_mtime_ns, before)

    def test_http_submit_replay_tick_and_receipt(self):
        body = {"commandId": "http-buy", "code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957"}
        first = self.post("/orders", body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), self.post("/orders", body).json())
        query = self.path + "/commands/http-buy"
        result = self.client.get(query, headers=self.headers("GET", query))
        self.assertEqual(result.json()["receipt"], first.json())
        self.assertEqual(self.post("/ticks", {"commandId": "http-tick"}).status_code, 403)
        tick = self.post("/ticks", {"commandId": "http-tick"}, role="scheduler")
        self.assertEqual(len(tick.json()["result"]["matched"]), 1)
        before = self.ledger.read(OWNER, self.account)
        response = self.client.get(self.path, headers=self.headers("GET", self.path))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.ledger.read(OWNER, self.account), before)
        path = self.path + "/view"
        with patch.dict(os.environ, {"QUANT_TIMING_LOG_PATH": str(Path(self.temp.name) / "timing.log")}):
            view = self.client.get(path, headers=self.headers("GET", path))
        self.assertEqual(view.status_code, 200, view.text)
        self.assertEqual(view.json()["storage"], "postgres")
        self.assertEqual(view.json()["recent_fills"][0]["price"], 0.957)
        self.assertEqual(self.ledger.read(OWNER, self.account), before)

    def test_real_node_signer_matches_python_for_unicode_body_and_encoded_receipt(self):
        web = ROOT.parents[1] / "apps/web"
        def signed(method, path, body=""):
            payload = {"context": {"ownerId": OWNER, "actorId": "node-owner", "role": "owner"}, "method": method, "path": path, "body": body}
            process = subprocess.run([os.environ["PAPER_TEST_NODE"], "--import", "tsx", "tests/integration/paper-sign.mjs"],
                cwd=web, input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8", timeout=20)
            self.assertEqual(process.returncode, 0, process.stderr)
            return json.loads(process.stdout)
        body = canonical({"commandId": "node:buy", "code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957", "note": "签名回测"})
        response = self.client.post(self.path + "/orders", content=body, headers=signed("POST", self.path + "/orders", body))
        self.assertEqual(response.status_code, 200, response.text)
        path = self.path + "/commands/node%3Abuy"
        receipt = self.client.get(path, headers=signed("GET", path))
        self.assertEqual(receipt.status_code, 200, receipt.text)
        self.assertEqual(receipt.json()["receipt"], response.json())

    def test_http_rejects_cross_owner_body_actor_signature_and_expiry(self):
        body = {"commandId": "denied", "code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957"}
        self.assertEqual(self.post("/orders", body, owner=str(uuid.uuid4())).status_code, 403)
        self.assertEqual(self.post("/orders", {**body, "actor": "owner"}).status_code, 422)
        self.assertEqual(self.post("/orders", body, changes={"expiresAt": time.time() - 1}).status_code, 401)
        path = self.path + "/orders"
        raw = canonical(body)
        headers = self.headers("POST", path, raw)
        self.assertEqual(self.client.post(path, content=raw.replace('"100"', '"200"') + " ", headers=headers).status_code, 401)
        headers["X-Zhiyu-Paper-Signature"] = "wrong"
        self.assertEqual(self.client.post(path, content=raw, headers=headers).status_code, 401)
        self.assertEqual(self.client.get(self.path).status_code, 401)
        self.assertEqual(self.ledger.read(OWNER, self.account)["version"], 0)

    def test_http_changed_intent_and_foreign_account(self):
        body = {"commandId": "idempotent", "code": "159278.SZ", "side": "buy", "quantity": 100, "limit_price": "0.957"}
        self.assertEqual(self.post("/orders", body).status_code, 200)
        self.assertEqual(self.post("/orders", {**body, "quantity": 200}).status_code, 409)
        path = f"/paper/v2/accounts/{uuid.uuid4()}"
        self.assertEqual(self.client.get(path, headers=self.headers("GET", path)).status_code, 404)

    def test_http_database_failure_has_no_json_fallback(self):
        with patch.dict(os.environ, {"QUANT_PAPER_DATABASE_URL": "postgresql://invalid:invalid@127.0.0.1:1/zhiyu_test_unavailable"}):
            response = self.client.get(self.path, headers=self.headers("GET", self.path))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["reasonCode"], "paper_storage_or_control_unavailable")

    def test_legacy_http_reads_are_pure_and_missing_account_is_unavailable(self):
        from app import paper_trading
        legacy = Path(self.temp.name) / "legacy.json"
        legacy.write_text(canonical(fresh()), encoding="utf-8")
        before = legacy.read_bytes(), legacy.stat().st_mtime_ns
        with patch.object(paper_trading, "PAPER_ACCOUNT_PATH", legacy), \
             patch.dict(os.environ, {"QUANT_TIMING_LOG_PATH": str(Path(self.temp.name) / "timing.log")}), \
             patch.object(paper_trading, "_save_account", side_effect=AssertionError("GET saved")), \
             patch.object(paper_trading, "_reconcile_open_orders", side_effect=AssertionError("GET matched")):
            for path in ("/paper/account", "/paper/account/view", "/paper/orders", "/paper/fills"):
                self.assertEqual(self.client.get(path, headers={"Authorization": "Bearer isolated-token"}).status_code, 200)
            self.assertEqual(before, (legacy.read_bytes(), legacy.stat().st_mtime_ns))
            legacy.unlink()
            for path in ("/paper/account", "/paper/orders", "/paper/fills"):
                self.assertEqual(self.client.get(path, headers={"Authorization": "Bearer isolated-token"}).status_code, 503)
            self.assertFalse(legacy.exists())
            response = self.client.post('/paper/orders', json={"code":"159278.SZ","side":"buy","quantity":100,"limit_price":0.957}, headers={"Authorization":"Bearer isolated-token"})
            self.assertEqual(response.status_code, 400)
            self.assertIn('paper_migration_required',response.text)
            self.assertFalse(legacy.exists())


class TraderTests(LedgerFixture):
    def setUp(self):
        super().setUp()
        import psycopg
        admin_url = os.environ["PAPER_TEST_ADMIN_URL"]
        assert urlparse(admin_url).hostname == urlparse(URL).hostname and urlparse(admin_url).path == urlparse(URL).path
        self.admin = psycopg.connect(admin_url, autocommit=True)
        self.addCleanup(self.admin.close)
        self.work, self.run = str(uuid.uuid4()), str(uuid.uuid4())
        self.admin.execute("""INSERT INTO workshops(id,user_id,name,mission,model_config) VALUES (%s,%s,'paper-test','test','{"role":"paper_trader"}')""", (self.work, OWNER))
        self.admin.execute("INSERT INTO workshop_runs(id,workshop_id,status) VALUES (%s,%s,'running')", (self.run, self.work))
        self.admin.execute("""INSERT INTO workshop_execution_leases(workshop_id,run_id,worker_id,token,phase,lease_until)
            VALUES (%s,%s,'test-worker',1,'running',clock_timestamp()+interval '5 minutes')""", (self.work, self.run))
        policy = self.admin.execute("""SELECT md5(jsonb_build_object('modelConfig',model_config,'boundaryPolicy',boundary_policy)::text)
            FROM workshops WHERE id=%s""", (self.work,)).fetchone()[0]
        self.actor = PaperActor(OWNER, f"work:{self.work}", "trader", {"workshopId": self.work, "runId": self.run,
            "workerId": "test-worker", "token": 1, "policyHash": policy})
        now = datetime.fromisoformat(NOW)
        self.service = PaperTradingService(self.ledger, lambda: market(now), clock=lambda: now, control_guard=lambda: None)

    def buy(self, command_id):
        return self.service.submit(self.actor, self.account, command_id,
            {"code": "159278.SZ", "quantity": 100, "side": "buy", "limit_price": "0.957"})

    def test_persistent_recovery_review_owner_replay_and_source_change(self):
        from app.paper_recovery_review import PaperRecoveryReview
        owner = PaperActor(OWNER, 'owner-fixture', 'owner')
        source = Path(self.temp.name) / 'recovery.json'
        state = self.ledger.read(OWNER, self.account)['state']
        state.update(id='restored-fixture',cash=Decimal('999900.00'), realized_pnl=Decimal('-2.00'),
                     restore={'source':'isolated snapshot','restored_at':NOW})
        state['lots'] = [{'id':'recovery-lot','code':'159278.SZ','quantity':100,'remaining_quantity':100,
                          'cost_price':'1.000','trade_date':'2026-09-08','created_at':NOW,'restore_source':'isolated snapshot'}]
        source.write_text(canonical(state),encoding='utf-8')
        self.admin.execute('''INSERT INTO quant_trend_state_snapshots(workshop_id,code,trade_date,lifecycle_state,snapshot,created_at)
            VALUES (%s,'159278','2026-09-08','holding',%s::jsonb,%s)''',
            (self.work,canonical({'position':{'quantity':100,'cost_price':1}}),NOW))
        service = PaperRecoveryReview(self.ledger,source)
        prepared = service.prepare(owner)
        self.assertEqual(prepared,service.prepare(owner))
        with self.assertRaisesRegex(PaperLedgerError,'approved_recovery_review_required'):
            self.ledger.import_file(OWNER,source,recovery_review_id=prepared['reviewId'])
        with self.assertRaisesRegex(PaperLedgerError,'paper_actor_denied'):
            service.prepare(self.actor)
        args = (owner,prepared['reviewId'],'approve',prepared['reviewHash'],'approved')
        with self.assertRaisesRegex(PaperLedgerError,'acknowledgements_required'):
            service.decide(*args,{})
        acknowledgements = {'historicalCashIncomplete':True,'historicalPnlIncomplete':True,'preserveCurrentBalances':True}
        source.write_text(canonical(state)+' ',encoding='utf-8')
        with self.assertRaisesRegex(PaperLedgerError,'import_source_changed'):
            service.decide(*args,acknowledgements)
        source.write_text(canonical(state),encoding='utf-8')
        self.assertFalse(service.decide(*args,acknowledgements)['replayed'])
        self.assertTrue(service.decide(*args,acknowledgements)['replayed'])
        with self.assertRaisesRegex(PaperLedgerError,'command_payload_conflict'):
            service.decide(owner,prepared['reviewId'],'approve',prepared['reviewHash'],'rejected',{})
        self.assertEqual(self.ledger.read(OWNER,self.account)['state']['cash'],Decimal('1000000.00'))
        from fastapi.testclient import TestClient
        from app.main import app
        key = 'isolated-review-key-at-least-32-characters'
        def signed(method,path,body='',role='owner'):
            now = time.time()
            claims={'ownerId':OWNER,'actorId':'owner-fixture','role':role,'issuedAt':now,'expiresAt':now+60,
                    'method':method,'path':path,'bodySha256':hashlib.sha256(body.encode()).hexdigest()}
            encoded=base64.urlsafe_b64encode(canonical(claims).encode()).decode().rstrip('=')
            return {'Authorization':'Bearer review-token','Content-Type':'application/json','X-Zhiyu-Paper-Context':encoded,
                    'X-Zhiyu-Paper-Signature':hmac.new(key.encode(),encoded.encode(),hashlib.sha256).hexdigest()}
        with patch.dict(os.environ,{'QUANT_INTERNAL_TOKEN':'review-token','QUANT_PAPER_SIGNING_KEY':key,'QUANT_PAPER_OWNER_ID':OWNER}), \
             patch('app.paper_api.recovery_service',return_value=service), TestClient(app) as http:
            base='/paper/v2/migration/reviews'
            self.assertEqual(http.post(base,content='{}',headers=signed('POST',base,'{}')).json()['reviewId'],prepared['reviewId'])
            path=base+'/'+prepared['reviewId']
            self.assertEqual(http.get(path,headers=signed('GET',path)).json()['decision'],'approved')
            self.assertEqual(http.get(path,headers=signed('GET',path,role='scheduler')).status_code,403)
            self.assertEqual(http.get(path).status_code,401)
            body=canonical({'commandId':'approve','reviewHash':prepared['reviewHash'],'decision':'approved','acknowledgements':acknowledgements})
            path+='/decision'
            self.assertTrue(http.post(path,content=body,headers=signed('POST',path,body)).json()['replayed'])
            invalid=body.replace('true','"true"')
            self.assertEqual(http.post(path,content=invalid,headers=signed('POST',path,invalid)).status_code,422)
        import_args = {'dry_run':False,'controllers_stopped':True,'backup_dir':Path(self.temp.name)/'recovery-backup',
                       'migration_batch_id':str(uuid.uuid4()),'recovery_review_id':prepared['reviewId']}
        with patch.object(self.ledger,'_persist',side_effect=RuntimeError('isolated import failure')):
            with self.assertRaisesRegex(RuntimeError,'isolated import failure'):
                self.ledger.import_file(OWNER,source,**import_args)
        result = self.ledger.import_file(OWNER,source,**import_args)
        recovered = result['accountId']
        self.assertFalse(result['historicalPerformanceComplete'])
        self.assertTrue(self.ledger.import_file(OWNER,source,**import_args)['replayed'])
        before = self.ledger.read(OWNER,recovered)
        self.assertEqual(before['state']['cash'],Decimal('999900.00'))
        self.assertEqual(before['state']['fills'],[])
        self.assertEqual(before['state']['recovery_baseline']['approvalCommandId'],'approve')
        def erase_baseline(snapshot):
            snapshot.pop('recovery_baseline')
            return {'status':'completed'}
        with self.assertRaisesRegex(PaperLedgerError,'immutable_recovery_baseline'):
            self.ledger.command(OWNER,recovered,'erase-baseline','test','owner-fixture',{},erase_baseline)
        self.assertEqual(self.ledger.read(OWNER,recovered),before)
        self.service.submit(owner,recovered,'recovered-buy',{'code':'159278.SZ','quantity':100,'side':'buy','limit_price':'0.957'})
        self.service.match_tick(PaperActor(OWNER,'scheduler-fixture','scheduler'),recovered,'recovered-tick')
        after = self.ledger.read(OWNER,recovered)['state']
        self.assertEqual(after['cash'],Decimal('999804.30'))
        self.assertEqual(len(after['fills']),1)
        self.assertEqual(sum(lot['remaining_quantity'] for lot in after['lots']),200)

    def test_signed_work_policy_and_original_receipt_replay(self):
        import psycopg
        first = self.buy("first")
        self.assertEqual(first["result"]["status"], "accepted")
        self.admin.execute("UPDATE workshops SET boundary_policy='{" + '"deniedActions":["buy"]' + "}' WHERE id=%s", (self.work,))
        before = self.ledger.read(OWNER, self.account)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.buy("changed-policy")
        self.assertEqual(self.buy("first"), first)
        self.assertEqual(self.ledger.read(OWNER, self.account), before)

    def test_lost_fence_and_wrong_role_cannot_mutate(self):
        import psycopg
        before = self.ledger.read(OWNER, self.account)
        for mutation in ("token=2", "token=1,lease_until=clock_timestamp()-interval '1 second'"):
            self.admin.execute(f"UPDATE workshop_execution_leases SET {mutation} WHERE workshop_id=%s", (self.work,))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.buy("denied")
        self.admin.execute("UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '5 minutes' WHERE workshop_id=%s", (self.work,))
        self.admin.execute("UPDATE workshops SET model_config='{" + '"role":"watchlist_selector"' + "}' WHERE id=%s", (self.work,))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.buy("wrong-role")
        self.assertEqual(self.ledger.read(OWNER, self.account), before)

    def test_expiry_after_persist_rolls_back_account_receipt_and_event(self):
        import psycopg
        before = self.ledger.read(OWNER, self.account)
        persist = self.ledger._persist
        reached = []
        def delayed(*args):
            persist(*args)
            reached.append(True)
            time.sleep(1)
        self.ledger._persist = delayed
        self.admin.execute("UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '750 milliseconds' WHERE workshop_id=%s", (self.work,))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.buy("expired-mid-write")
        self.assertTrue(reached)
        self.assertEqual(self.ledger.read(OWNER, self.account), before)
        self.assertIsNone(self.ledger.receipt(OWNER, self.account, "expired-mid-write"))


class ObservationTests(unittest.TestCase):
    def setUp(self):
        from app import provider
        self.provider = provider
        self.temp = tempfile.TemporaryDirectory(prefix="zhiyu_test_paper_observation_")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.now = datetime.fromisoformat(NOW)
        for context in (patch.object(provider, "WATCHLIST_UNIVERSE_PATH", self.path / "universe.json"),
                        patch.object(provider, "WATCHLIST_CONFIG_PATH", self.path / "config.json")):
            context.start()
            self.addCleanup(context.stop)

    def test_versioned_official_calendar_and_unknown_year(self):
        from app.paper_observation import calendar_fact
        for at, expected in ((NOW, True), ("2026-09-25T10:00:00+08:00", False),
                             ("2026-10-01T10:00:00+08:00", False), ("2026-09-20T10:00:00+08:00", False)):
            result = calendar_fact(datetime.fromisoformat(at))
            self.assertIs(result["isTradingDay"], expected)
            self.assertEqual(set(result["source"]), {"SH", "SZ", "BJ"})
        self.assertIsNone(calendar_fact(datetime.fromisoformat("2027-01-04T10:00:00+08:00"))["isTradingDay"])

    def test_raw_quote_time_preserved_and_configuration_not_written(self):
        from app.paper_observation import observe_paper_market
        path = self.path / "config.json"
        path.write_text('{"codes":["159278.SZ"]}', encoding="utf-8")
        before = path.read_bytes()
        quote = {"code": "159278.SZ", "price": 0.957, "change_pct": 2.24, "updated_at": "2026-09-07T15:00:00+08:00"}
        with patch.object(self.provider, "_tencent_watchlist_quotes", return_value=[quote]):
            result = observe_paper_market(clock=lambda: self.now)
        self.assertEqual(result["quotes"]["159278.SZ"]["observedAt"], quote["updated_at"])
        self.assertEqual(result["quotes"]["159278.SZ"]["quoteSessionDate"], "2026-09-07")
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.path / "universe.json").exists())

    def test_missing_watchlist_and_concurrent_change_are_explicit(self):
        from app.paper_observation import observe_paper_market
        with patch.object(self.provider, "_tencent_watchlist_quotes", side_effect=AssertionError("missing config fetched quotes")):
            result = observe_paper_market(clock=lambda: self.now)
        self.assertIsNone(result["watchlistVersion"])
        path = self.path / "config.json"
        path.write_text('{"codes":["159278.SZ"]}', encoding="utf-8")
        def changed(_):
            path.write_text('{"codes":[]}', encoding="utf-8")
            return []
        with patch.object(self.provider, "_tencent_watchlist_quotes", side_effect=changed):
            result = observe_paper_market(clock=lambda: self.now)
        self.assertEqual(result["warning"], "watchlist_changed_during_quote_fetch")
        self.assertEqual(result["quotes"], {})


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "child":
        child(*sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "domain-child":
        domain_child(*sys.argv[2:])
    else:
        daily = ROOT / "data/paper_account.json"
        before = (hashlib.sha256(daily.read_bytes()).hexdigest(), daily.stat().st_mtime_ns) if daily.exists() else None
        suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(cls) for cls in (LedgerTests, DomainTests, ApiTests, TraderTests, ObservationTests)])
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        after = (hashlib.sha256(daily.read_bytes()).hexdigest(), daily.stat().st_mtime_ns) if daily.exists() else None
        report = {"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "dailyAccountUnchanged": before == after, "dailyFileWriteAttempts": DAILY_WRITE_ATTEMPTS,
                  "dailyFingerprintBefore": before, "dailyFingerprintAfter": after}
        Path(os.environ["PAPER_TEST_REPORT"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        sys.exit(0 if result.wasSuccessful() and before == after else 1)
