"""Durable at-most-once dispatch per command. Unknown GUI outcomes never retry."""
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timezone
from dispatch_lock import dispatch_lock


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


class SendConflict(Exception):
    pass


class SendUnknown(Exception):
    pass


class SendLedger:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sends (command_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            db.execute("CREATE TABLE IF NOT EXISTS send_resolutions (resolution_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def execute(self, command_id, recipient, message, authorize, send):
        # Replays need no GUI lock. New commands acquire the process-shared
        # dispatch lock before consuming authorization or recording an intent.
        with self._connect() as db:
            existing = db.execute("SELECT 1 FROM sends WHERE command_id=?", (command_id,)).fetchone()
        if existing:
            return self._execute(command_id, recipient, message, authorize, send)
        with dispatch_lock(str(self.path) + ".dispatch.lock"):
            return self._execute(command_id, recipient, message, authorize, send)

    def _execute(self, command_id, recipient, message, authorize, send):
        payload_digest = digest([recipient, message])
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload_hash,status,result_json FROM sends WHERE command_id=?", (command_id,)).fetchone()
            if row:
                if row[0] != payload_digest:
                    raise SendConflict("Command payload changed")
                if row[1] == "sent":
                    return json.loads(row[2])
                if row[1] == "not_sent":
                    raise SendConflict("Command was closed as not sent; old commands cannot be dispatched")
                raise SendUnknown("Send result is unknown; do not resend")
            # Authorization failure occurs before durable dispatch intent.
            authorize()
            db.execute("INSERT INTO sends(command_id,payload_hash,status) VALUES (?,?,'started')", (command_id, payload_digest))
        # A process exit anywhere after this commit leaves an unresolved intent.
        try:
            result = send()
            encoded = json.dumps(result, ensure_ascii=False)
            with self._connect() as db:
                db.execute("UPDATE sends SET status='sent',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE command_id=? AND status='started'", (encoded, command_id))
            return result
        except Exception as error:
            with self._connect() as db:
                db.execute("UPDATE sends SET status='unknown',updated_at=CURRENT_TIMESTAMP WHERE command_id=? AND status='started'", (command_id,))
            raise SendUnknown("Send result is unknown; do not resend") from error

    def status(self, command_id):
        with self._connect() as db:
            row = db.execute("SELECT status,result_json FROM sends WHERE command_id=?", (command_id,)).fetchone()
        if not row:
            return {"status": "not_found"}
        # A recorded start cannot prove whether GUI input happened.
        return {"status": row[0] if row[0] in ("sent", "not_sent") else "unknown", "result": json.loads(row[1]) if row[1] else None}

    def resolve(self, command_id, recipient, message, resolution_id, decision, actor_id, evidence):
        """Persist an owner attestation while no GUI dispatch can be in flight.

        A not-found command gets a tombstone too: a delayed original request
        must never turn an owner's not-sent decision into a later GUI send.
        This is human evidence, not an automatically observed GUI receipt.
        """
        if decision not in ("sent", "not_sent") or not actor_id or not resolution_id or not 8 <= len(evidence.strip()) <= 4000:
            raise ValueError("A decision, actor, stable resolution id and evidence are required")
        payload_digest = digest([recipient, message])
        resolution_digest = digest([command_id, payload_digest, decision, actor_id, evidence])
        with dispatch_lock(str(self.path) + ".dispatch.lock"), self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT payload_hash,result_json FROM send_resolutions WHERE resolution_id=?", (resolution_id,)).fetchone()
            if previous:
                if previous[0] != resolution_digest:
                    raise SendConflict("Resolution payload changed")
                return json.loads(previous[1])
            row = db.execute("SELECT payload_hash,status,result_json FROM sends WHERE command_id=?", (command_id,)).fetchone()
            if row and row[0] != payload_digest:
                raise SendConflict("Command payload changed")
            if row and row[1] in ("sent", "not_sent"):
                if row[1] != decision:
                    raise SendConflict("A final send outcome cannot be overwritten")
                result = json.loads(row[2])
            else:
                result = {"ok": True, "recipientName": recipient, "messageHash": hashlib.sha256(message.encode("utf-8")).hexdigest(), "resolution": {"id": resolution_id, "decision": decision, "actorId": actor_id, "evidence": evidence, "resolvedAt": datetime.now(timezone.utc).isoformat(), "source": "owner_attestation"}}
                encoded = json.dumps(result, ensure_ascii=False)
                if row:
                    db.execute("UPDATE sends SET status=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE command_id=?", (decision, encoded, command_id))
                else:
                    db.execute("INSERT INTO sends(command_id,payload_hash,status,result_json) VALUES (?,?,?,?)", (command_id, payload_digest, decision, encoded))
            receipt = {"status": decision, "result": result}
            db.execute("INSERT INTO send_resolutions(resolution_id,command_id,payload_hash,result_json) VALUES (?,?,?,?)", (resolution_id, command_id, resolution_digest, json.dumps(receipt, ensure_ascii=False)))
            return receipt
