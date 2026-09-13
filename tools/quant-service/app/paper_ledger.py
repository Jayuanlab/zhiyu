"""PostgreSQL paper ledger. No market calls, automatic account creation or JSON fallback."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .paper_ledger_model import PaperLedgerError, canonical, digest, state_digest, validate_state, validate_transition


def _json(value):
    return Jsonb(value, dumps=canonical)


class PaperLedger:
    def __init__(self, database_url: str | None = None):
        # Deliberately do not inherit the unrestricted application's database credential.
        self.database_url = database_url or os.getenv("QUANT_PAPER_DATABASE_URL", "")
        if not self.database_url:
            raise PaperLedgerError("paper_database_not_configured")

    def _connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row, connect_timeout=5,
                               options="-c statement_timeout=15000 -c lock_timeout=10000")

    @staticmethod
    def _identity(owner_id, account_id):
        try:
            return str(uuid.UUID(owner_id)), str(uuid.UUID(account_id))
        except (ValueError, AttributeError, TypeError) as exc:
            raise PaperLedgerError("invalid_account_identity") from exc

    @staticmethod
    def _approved_opening(conn, owner_id, review_id, source_hash):
        row = conn.execute('''SELECT r.review_hash,r.source_hash,r.evidence,d.command_id FROM paper_recovery_reviews r
            JOIN paper_recovery_decisions d ON d.review_id=r.id AND d.owner_id=r.owner_id
            WHERE r.id=%s AND r.owner_id=%s AND d.decision='approved' ''',(review_id,owner_id)).fetchone()
        if not row or row['source_hash'] != source_hash:
            raise PaperLedgerError('approved_recovery_review_required')
        proposal = row['evidence']['review']['openingProposal']
        if proposal['status'] != 'needs_owner_review' or row['evidence']['comparison']['status'] != 'matched':
            raise PaperLedgerError('approved_recovery_review_required')
        return {'reviewId':str(review_id),'reviewHash':row['review_hash'],'sourceHash':source_hash,
                'approvalCommandId':row['command_id'],'opening':proposal['baseline'],
                'historicalPerformanceComplete':False}

    def _load(self, conn, owner_id, account_id, *, lock=False):
        owner_id, account_id = self._identity(owner_id, account_id)
        row = conn.execute("SELECT * FROM paper_accounts WHERE id=%s AND owner_id=%s" +
                           (" FOR UPDATE" if lock else ""), (account_id, owner_id)).fetchone()
        if row is None:
            raise PaperLedgerError("paper_account_not_found")
        state = row["state"]
        for field in ("initial_cash", "cash", "frozen_cash", "realized_pnl"):
            state[field] = row[field]
        state["lots"] = [item["detail"] for item in conn.execute(
            "SELECT detail FROM paper_position_lots WHERE account_id=%s ORDER BY id", (account_id,))]
        state["orders"] = [item["detail"] for item in conn.execute(
            "SELECT detail FROM paper_orders WHERE account_id=%s ORDER BY id", (account_id,))]
        state["fills"] = [item["detail"] for item in conn.execute(
            "SELECT detail FROM paper_fills WHERE account_id=%s ORDER BY id", (account_id,))]
        recovery = state.get('recovery_baseline')
        if recovery is not None and recovery != self._approved_opening(conn,owner_id,recovery['reviewId'],recovery['sourceHash']):
            raise PaperLedgerError('recovery_baseline_mismatch')
        return validate_state(state,opening=recovery['opening'] if recovery else None), row["version"]

    def read(self, owner_id: str, account_id: str):
        with self._connect() as conn:
            # All component reads observe one committed version without taking a writer lock.
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            state, version = self._load(conn, owner_id, account_id)
            return {"state": state, "version": version}

    def receipt(self, owner_id: str, account_id: str, command_id: str):
        owner_id, account_id = self._identity(owner_id, account_id)
        with self._connect() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            row = conn.execute("""SELECT c.result FROM paper_commands c JOIN paper_accounts a ON a.id=c.account_id
                WHERE a.owner_id=%s AND a.id=%s AND c.command_id=%s""", (owner_id, account_id, command_id)).fetchone()
            return row["result"] if row else None

    def replay(self, owner_id, account_id, command_id, kind, actor, payload, expected_version=None):
        """Check intent before external observation; a completed command never needs fresh quotes."""
        owner_id, account_id = self._identity(owner_id, account_id)
        intent = digest({"kind": kind, "actor": actor, "payload": payload, "expectedVersion": expected_version})
        with self._connect() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            if not conn.execute("SELECT 1 FROM paper_accounts WHERE owner_id=%s AND id=%s", (owner_id, account_id)).fetchone():
                raise PaperLedgerError("paper_account_not_found")
            row = conn.execute("""SELECT c.payload_hash,c.result FROM paper_commands c JOIN paper_accounts a ON a.id=c.account_id
                WHERE a.owner_id=%s AND a.id=%s AND c.command_id=%s""", (owner_id, account_id, command_id)).fetchone()
            if row and row["payload_hash"] != intent:
                raise PaperLedgerError("command_payload_conflict")
            return row["result"] if row else None

    def command(self, owner_id: str, account_id: str, command_id: str, kind: str, actor: str,
                payload: dict, apply: Callable[[dict], dict], *, expected_version: int | None = None,
                observation: dict | None = None, transaction_guard=None):
        """apply is an internal, network-free domain function; never supplied by an HTTP caller."""
        if not isinstance(command_id, str) or not 1 <= len(command_id.strip()) <= 200 or not actor or not kind:
            raise PaperLedgerError("invalid_command")
        intent = digest({"kind": kind, "actor": actor, "payload": payload, "expectedVersion": expected_version})
        with self._connect() as conn:
            state, version = self._load(conn, owner_id, account_id, lock=True)
            existing = conn.execute("SELECT payload_hash,result FROM paper_commands WHERE account_id=%s AND command_id=%s",
                                    (account_id, command_id)).fetchone()
            if existing:
                if existing["payload_hash"] != intent:
                    raise PaperLedgerError("command_payload_conflict")
                return existing["result"]
            if expected_version is not None and expected_version != version:
                raise PaperLedgerError("account_version_conflict")
            if transaction_guard:
                transaction_guard(conn)
            opening = state.get('recovery_baseline',{}).get('opening')
            before = validate_state(state,opening=opening)
            result = apply(state)
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            state = validate_state(state,opening=opening)
            validate_transition(before, state)
            version += 1
            self._persist(conn, account_id, state, version)
            receipt = {"commandId": command_id, "version": version, "result": result}
            conn.execute("""INSERT INTO paper_commands(account_id,command_id,kind,actor,payload_hash,result,version)
                VALUES (%s,%s,%s,%s,%s,%s,%s)""", (account_id, command_id, kind, actor, intent, _json(receipt), version))
            conn.execute("""INSERT INTO paper_events(account_id,version,command_id,kind,actor,observation,state_hash)
                VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                         (account_id, version, command_id, kind, actor, _json(observation or {}), state_digest(state)))
            if transaction_guard:
                transaction_guard(conn)
            # Normalize first response to exactly the same representation as a replay.
            return json.loads(canonical(receipt))

    def _persist(self, conn, account_id, state, version):
        header = {k: v for k, v in state.items() if k not in {"lots", "orders", "fills"}}
        conn.execute("""UPDATE paper_accounts SET cash=%s,frozen_cash=%s,realized_pnl=%s,state=%s,
            version=%s,updated_at=%s WHERE id=%s""", (state["cash"], state["frozen_cash"], state["realized_pnl"],
            _json(header), version, state["updated_at"], account_id))
        for row in state["orders"]:
            conn.execute("""INSERT INTO paper_orders(account_id,id,code,side,status,quantity,remaining_quantity,limit_price,detail)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(account_id,id) DO UPDATE
                SET status=EXCLUDED.status,remaining_quantity=EXCLUDED.remaining_quantity,detail=EXCLUDED.detail""",
                (account_id, row["id"], row["code"], row["side"], row["status"], row["quantity"],
                 row["remaining_quantity"], row["limit_price"], _json(row)))
        for row in state["lots"]:
            conn.execute("""INSERT INTO paper_position_lots(account_id,id,code,quantity,remaining_quantity,cost_price,trade_date,detail)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(account_id,id) DO UPDATE
                SET remaining_quantity=EXCLUDED.remaining_quantity,detail=EXCLUDED.detail""",
                (account_id, row["id"], row["code"], row["quantity"], row["remaining_quantity"],
                 row["cost_price"], row["trade_date"], _json(row)))
        for row in state["fills"]:
            conn.execute("""INSERT INTO paper_fills(account_id,id,order_id,execution_key,quantity,price,amount,detail)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(account_id,id) DO NOTHING""",
                (account_id, row["id"], row["order_id"], row.get("execution_key") or f"import:{row['id']}",
                 row["quantity"], row["price"], row["amount"], _json(row)))

    def import_file(self, owner_id: str, source: Path, *, dry_run=True, controllers_stopped=False,
                    backup_dir: Path | None = None, migration_batch_id: str | None = None,
                    recovery_review_id: str | None = None):
        raw = source.read_bytes()
        source_hash = hashlib.sha256(raw).hexdigest()
        owner_id = str(uuid.UUID(owner_id))
        parsed = json.loads(raw.decode('utf-8'))
        if isinstance(parsed,dict) and 'recovery_baseline' in parsed:
            raise PaperLedgerError('source_cannot_supply_recovery_approval')
        recovery = None
        if recovery_review_id:
            recovery_review_id = str(uuid.UUID(recovery_review_id))
            with self._connect() as conn:
                recovery = self._approved_opening(conn,owner_id,recovery_review_id,source_hash)
        state = validate_state(parsed,opening=recovery['opening'] if recovery else None)
        if recovery:
            state['recovery_baseline'] = recovery
        account_id = str(uuid.uuid5(uuid.UUID(owner_id), f"paper:{state['id']}"))
        summary = {"accountId": account_id, "sourceHash": source_hash, "orders": len(state["orders"]),
                   "fills": len(state["fills"]), "lots": len(state["lots"]), "cash": str(state["cash"]),
                   "frozenCash": str(state["frozen_cash"]), "dryRun": dry_run,
                   "recoveryReviewId":recovery_review_id,"historicalPerformanceComplete":not bool(recovery)}
        if dry_run:
            return summary
        if controllers_stopped is not True or backup_dir is None or migration_batch_id is None:
            raise PaperLedgerError("import_requires_stopped_controllers_backup_and_batch")
        migration_batch_id = str(uuid.UUID(migration_batch_id))
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"paper-{source_hash}.json"
        try:
            with backup.open("xb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            pass
        if hashlib.sha256(backup.read_bytes()).hexdigest() != source_hash:
            raise PaperLedgerError("import_backup_hash_mismatch")
        if source.read_bytes() != raw:
            raise PaperLedgerError("import_source_changed")
        with self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"paper-import:{account_id}",))
            if recovery and recovery != self._approved_opening(conn,owner_id,recovery_review_id,source_hash):
                raise PaperLedgerError('recovery_baseline_mismatch')
            previous = conn.execute("SELECT * FROM paper_imports WHERE account_id=%s", (account_id,)).fetchone()
            if previous:
                if previous["source_hash"] != source_hash:
                    raise PaperLedgerError("account_already_imported_from_different_source")
                return {**summary, "migrationBatchId": str(previous["migration_batch_id"]), "replayed": True}
            header = {k: v for k, v in state.items() if k not in {"lots", "orders", "fills"}}
            conn.execute("""INSERT INTO paper_accounts(id,owner_id,legacy_id,initial_cash,cash,frozen_cash,realized_pnl,
                state,created_at,updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (account_id, owner_id,
                state["id"], state["initial_cash"], state["cash"], state["frozen_cash"], state["realized_pnl"],
                _json(header), state["created_at"], state["updated_at"]))
            self._persist(conn, account_id, state, 0)
            conn.execute("INSERT INTO paper_imports(account_id,migration_batch_id,source_hash,backup_path) VALUES (%s,%s,%s,%s)",
                         (account_id, migration_batch_id, source_hash, str(backup.resolve())))
            command_id = f"import:{migration_batch_id}"
            result = {**summary, "migrationBatchId": migration_batch_id, "replayed": False}
            conn.execute("""INSERT INTO paper_commands(account_id,command_id,kind,actor,payload_hash,result,version)
                VALUES (%s,%s,'import',%s,%s,%s,0)""", (account_id, command_id, f"owner:{owner_id}", source_hash, _json(result)))
            conn.execute("""INSERT INTO paper_events(account_id,version,command_id,kind,actor,observation,state_hash)
                VALUES (%s,0,%s,'import',%s,%s,%s)""", (account_id, command_id, f"owner:{owner_id}",
                _json({"sourceHash": source_hash, "backupPath": str(backup.resolve()), "controllersStopped": True,
                       "recoveryReviewId":recovery_review_id}), state_digest(state)))
            if source.read_bytes() != raw:
                raise PaperLedgerError('import_source_changed')
            return result
