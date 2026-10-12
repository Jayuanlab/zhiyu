"""Explicit installer-only empty account bootstrap, with a restricted SQL role."""
from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .install_paths import installation_mode, installation_paths, resource_directory, config_directory
from .paper_ledger_model import PaperLedgerError, canonical, digest, number, state_digest, validate_state

TABLE_PERMISSIONS = {
    "paper_accounts": "SELECT,INSERT,UPDATE",
    "paper_orders": "SELECT,INSERT,UPDATE",
    "paper_position_lots": "SELECT,INSERT,UPDATE",
    "paper_fills": "SELECT,INSERT",
    "paper_commands": "SELECT,INSERT",
    "paper_events": "SELECT,INSERT",
    "paper_imports": "SELECT,INSERT",
    "paper_recovery_reviews": "SELECT,INSERT",
    "paper_recovery_decisions": "SELECT,INSERT",
}
FUNCTIONS = ("public.paper_assert_execution(uuid,uuid,uuid,text,integer,text)",
             "public.paper_recovery_source(uuid,timestamptz)")
DEPENDENCIES = {"fastapi": "fastapi", "uvicorn": "uvicorn", "pydantic": "pydantic", "httpx": "httpx",
                "akshare": "akshare", "tushare": "tushare", "pywencai": "pywencai", "psycopg": "psycopg"}


def identity(value: str, error: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise PaperLedgerError(error) from exc


def database_target(value: str):
    try:
        target = urlparse(value)
        if (target.scheme not in {"postgres", "postgresql"} or target.hostname not in {"127.0.0.1", "localhost", "::1"}
                or target.path != "/zhiyu" or target.query or target.fragment or not target.username or not target.password
                or not target.port):
            raise ValueError()
        return target
    except (ValueError, TypeError) as exc:
        raise PaperLedgerError("quant_install_database_target_invalid") from exc


def configuration(*, bootstrap=True):
    if not installation_mode():
        raise PaperLedgerError("quant_install_mode_required")
    _, owned, data = installation_paths()
    resource_directory()
    owner = identity(os.getenv("QUANT_PAPER_OWNER_ID", ""), "paper_owner_required")
    expected = identity(os.getenv("ZHIYU_RUNTIME_OWNER_ID", ""), "paper_install_owner_required")
    if owner != expected:
        raise PaperLedgerError("paper_owner_denied")
    account = identity(os.getenv("QUANT_PAPER_ACCOUNT_ID", ""), "paper_account_required")
    command = os.getenv("QUANT_INSTALL_BOOTSTRAP_COMMAND_ID", "").strip()
    if bootstrap and (not command or len(command) > 200):
        raise PaperLedgerError("invalid_command")
    cash = number(os.getenv("QUANT_INSTALL_INITIAL_CASH", "1000000.00"))
    if cash <= 0:
        raise PaperLedgerError("invalid_balance")
    dedicated = os.getenv("QUANT_PAPER_DATABASE_URL", "")
    target = database_target(dedicated)
    role = os.getenv("QUANT_INSTALL_DATABASE_ROLE", "zhiyu_quant") if bootstrap else unquote(target.username)
    password = os.getenv("QUANT_INSTALL_DATABASE_PASSWORD", "") if bootstrap else unquote(target.password)
    if not re.fullmatch(r"zhiyu_quant(?:_[a-z0-9]{1,32})?", role) or len(password) < 32:
        raise PaperLedgerError("quant_install_database_role_invalid")
    if len(os.getenv("QUANT_INTERNAL_TOKEN", "")) < 32 or len(os.getenv("QUANT_PAPER_SIGNING_KEY", "")) < 32:
        raise PaperLedgerError("paper_identity_not_configured")
    if unquote(target.username) != role or unquote(target.password) != password:
        raise PaperLedgerError("quant_install_database_role_mismatch")
    return {"owned": owned, "data": data, "owner": owner, "account": account, "command": command,
            "cash": cash, "role": role, "password": password, "databaseUrl": dedicated, "target": target}


def check_dependencies():
    if not installation_mode():
        raise PaperLedgerError("quant_install_mode_required")
    root, _, _ = installation_paths()
    resource_directory()
    python = os.getenv("QUANT_PYTHON_BIN", "")
    if not python or not Path(python).is_absolute():
        raise PaperLedgerError("quant_installation_python_required")
    import sys
    if not Path(python).resolve().is_relative_to(root) or Path(python).resolve() != Path(sys.executable).resolve():
        raise PaperLedgerError("quant_installation_python_mismatch")
    versions = {}
    for package, module in DEPENDENCIES.items():
        if importlib.util.find_spec(module) is None:
            raise PaperLedgerError("quant_install_dependency_missing")
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError as exc:
            raise PaperLedgerError("quant_install_dependency_missing") from exc
    for name in ("paper-market-policy.json", f"paper-calendar-{datetime.now(timezone.utc).year}.json"):
        if not (config_directory() / name).is_file():
            raise PaperLedgerError("quant_install_config_missing")
    return {"ok": True, "component": "quant", "mode": "embedded", "dependencies": versions,
            "dataIsolated": True, "identityConfigured": bool(os.getenv("QUANT_PAPER_OWNER_ID") and os.getenv("QUANT_PAPER_SIGNING_KEY"))}


def _safe_role(conn, config):
    role, owner = config["role"], config["owner"]
    marker = f"zhiyu-quant-install-v1:{owner}"
    row = conn.execute("SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
    if row:
        if row["marker"] != marker or any(row[key] for key in ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls")):
            raise PaperLedgerError("quant_install_role_not_owned")
        if conn.execute("SELECT 1 FROM pg_auth_members WHERE member=%s", (row["oid"],)).fetchone():
            raise PaperLedgerError("quant_install_role_membership_denied")
        action = "ALTER"
    else:
        action = "CREATE"
    conn.execute(sql.SQL(action + " ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}").format(sql.Identifier(role), sql.Literal(config["password"])))
    conn.execute(sql.SQL("COMMENT ON ROLE {} IS {}").format(sql.Identifier(role), sql.Literal(marker)))
    conn.execute(sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {}").format(sql.Identifier(role)))
    conn.execute(sql.SQL("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {}").format(sql.Identifier(role)))
    conn.execute(sql.SQL("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM {}").format(sql.Identifier(role)))
    conn.execute(sql.SQL("REVOKE CREATE ON SCHEMA public FROM {}").format(sql.Identifier(role)))
    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role)))
    for table, permissions in TABLE_PERMISSIONS.items():
        conn.execute(sql.SQL("GRANT " + permissions + " ON TABLE public.{} TO {}").format(sql.Identifier(table), sql.Identifier(role)))
    for function in FUNCTIONS:
        conn.execute(sql.SQL("GRANT EXECUTE ON FUNCTION " + function + " TO {}").format(sql.Identifier(role)))
    # Detect inherited/PUBLIC grants rather than treating REVOKE as a denial.
    for row in conn.execute("SELECT c.relname,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')"):
        if row["relname"] not in TABLE_PERMISSIONS and conn.execute("SELECT has_table_privilege(%s,%s,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", (role, row["oid"])).fetchone()["allowed"]:
            raise PaperLedgerError("quant_install_role_unrelated_privilege")
    for table in TABLE_PERMISSIONS:
        if conn.execute("SELECT has_table_privilege(%s,%s,'DELETE,TRUNCATE') AS allowed", (role, f"public.{table}")).fetchone()["allowed"]:
            raise PaperLedgerError("quant_install_role_delete_denied")
    if conn.execute("SELECT has_schema_privilege(%s,'public','CREATE') AS allowed", (role,)).fetchone()["allowed"]:
        raise PaperLedgerError("quant_install_role_schema_create_denied")
    # SECURITY DEFINER functions could bypass table grants even through PUBLIC.
    for function in conn.execute("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef"):
        if function["oid"] not in {conn.execute("SELECT %s::regprocedure::oid AS oid", (name,)).fetchone()["oid"] for name in FUNCTIONS} and conn.execute("SELECT has_function_privilege(%s,%s,'EXECUTE') AS allowed", (role, function["oid"])).fetchone()["allowed"]:
            raise PaperLedgerError("quant_install_role_unrelated_function")


def initialize(config=None, connector=psycopg.connect):
    config = config or configuration()
    admin_url = os.getenv("QUANT_INSTALL_ADMIN_DATABASE_URL", "")
    admin = database_target(admin_url)
    target = config["target"]
    if (admin.hostname, admin.port, admin.path) != (target.hostname, target.port, target.path) or unquote(admin.username) == config["role"]:
        raise PaperLedgerError("quant_install_admin_target_mismatch")
    intent = {"kind": "install_empty_account", "ownerId": config["owner"], "accountId": config["account"], "initialCash": str(config["cash"])}
    payload_hash = digest(intent)
    with connector(admin_url, row_factory=dict_row, connect_timeout=5, options="-c statement_timeout=15000 -c lock_timeout=10000") as conn:
        actual = Path(conn.execute("SELECT current_setting('data_directory') AS path").fetchone()["path"]).resolve()
        if actual != (config["owned"] / "postgres").resolve():
            raise PaperLedgerError("quant_install_cluster_not_owned")
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"quant-install:{config['owner']}",))
        if not conn.execute('SELECT id FROM public."User" WHERE id=%s', (config["owner"],)).fetchone():
            raise PaperLedgerError("paper_owner_denied")
        existing = conn.execute("SELECT id,owner_id,legacy_id,initial_cash FROM public.paper_accounts WHERE id=%s FOR UPDATE", (config["account"],)).fetchone()
        if existing:
            if (str(existing["owner_id"]) != config["owner"] or existing["legacy_id"] != f"installed:{config['account']}" or existing["initial_cash"] != config["cash"]):
                raise PaperLedgerError("quant_install_account_not_owned")
            receipt = conn.execute("SELECT payload_hash,result FROM public.paper_commands WHERE account_id=%s AND command_id=%s AND kind='install_empty_account'", (config["account"], config["command"])).fetchone()
            if not receipt or receipt["payload_hash"] != payload_hash:
                raise PaperLedgerError("command_payload_conflict")
            result = receipt["result"]
        else:
            stamp = datetime.now(timezone.utc).isoformat()
            state = validate_state({"id": f"installed:{config['account']}", "initial_cash": config["cash"], "cash": config["cash"],
                                    "frozen_cash": 0, "realized_pnl": 0, "lots": [], "orders": [], "fills": [], "created_at": stamp, "updated_at": stamp})
            result = {"commandId": config["command"], "version": 1, "result": {"status": "completed", "accountId": config["account"], "initialCash": str(config["cash"]), "freshEmpty": True}}
            conn.execute("""INSERT INTO public.paper_accounts(id,owner_id,legacy_id,version,initial_cash,cash,frozen_cash,realized_pnl,state,created_at,updated_at)
                VALUES(%s,%s,%s,1,%s,%s,0,0,%s,%s,%s)""", (config["account"], config["owner"], state["id"], config["cash"], config["cash"], Jsonb(state, dumps=canonical), stamp, stamp))
            conn.execute("""INSERT INTO public.paper_commands(account_id,command_id,kind,actor,payload_hash,result,version)
                VALUES(%s,%s,'install_empty_account',%s,%s,%s,1)""", (config["account"], config["command"], f"owner:{config['owner']}", payload_hash, Jsonb(result, dumps=canonical)))
            conn.execute("""INSERT INTO public.paper_events(account_id,version,command_id,kind,actor,observation,state_hash)
                VALUES(%s,1,%s,'install_empty_account',%s,%s,%s)""", (config["account"], config["command"], f"owner:{config['owner']}", Jsonb(intent), state_digest(state)))
        _safe_role(conn, config)
    config["data"].mkdir(parents=True, exist_ok=True)
    # Empty configuration is explicit; no development watchlist or old account is imported.
    watchlist = config["data"] / "watchlist.json"
    if not watchlist.exists():
        try:
            with watchlist.open("x", encoding="utf-8") as file:
                file.write('{"codes":[]}\n')
        except FileExistsError:
            pass
    return {"ok": True, "component": "quant", "initialized": True, "accountId": config["account"], "receipt": result, "legacyImported": False}


def health(config=None):
    config = config or configuration(bootstrap=False)
    from .paper_ledger import PaperLedger
    account = PaperLedger(config["databaseUrl"]).read(config["owner"], config["account"])
    state = account["state"]
    if state["id"] != f"installed:{config['account']}":
        raise PaperLedgerError("quant_install_account_not_owned")
    return {"ok": True, "component": "quant", "ownerBound": True, "accountId": config["account"], "version": account["version"],
            "orders": len(state["orders"]), "fills": len(state["fills"]), "lots": len(state["lots"]), "legacyImported": False}
