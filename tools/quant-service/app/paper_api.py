"""Owner-bound signed paper commands. No ownership or role is accepted from request bodies."""
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictBool
from starlette.concurrency import run_in_threadpool

from .internal_auth import authorized
from .paper_commands import PaperActor, PaperTradingService
from .paper_ledger import PaperLedger
from .paper_ledger_model import PaperLedgerError, canonical
from .paper_observation import observe_paper_market
from .paper_trading import _account_view
from .provider import QuantProviderError

router = APIRouter(prefix="/paper/v2")


class RecoveryDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commandId: str = Field(min_length=1, max_length=200)
    reviewHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    decision: Literal['approved', 'rejected']
    acknowledgements: dict[str, StrictBool]


def recovery_service():
    from .paper_recovery_review import PaperRecoveryReview
    from . import paper_trading
    return PaperRecoveryReview(PaperLedger(), paper_trading.PAPER_ACCOUNT_PATH)


@router.post('/migration/reviews')
async def prepare_recovery_review(request: Request):
    actor = await actor_from_request(request)
    return await respond(lambda: recovery_service().prepare(actor))


@router.get('/migration/reviews/{review_id}')
async def read_recovery_review(review_id: uuid.UUID, request: Request):
    actor = await actor_from_request(request)
    return await respond(lambda: recovery_service().read(actor,str(review_id)))


@router.post('/migration/reviews/{review_id}/decision')
async def decide_recovery_review(review_id: uuid.UUID, command: RecoveryDecision, request: Request):
    actor = await actor_from_request(request)
    return await respond(lambda: recovery_service().decide(actor,str(review_id),command.commandId,command.reviewHash,
        command.decision,command.acknowledgements))


class OrderCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commandId: str = Field(min_length=1, max_length=200)
    expectedVersion: StrictInt | None = Field(default=None, ge=0)
    code: str
    side: Literal["buy", "sell"]
    quantity: StrictInt
    limit_price: str
    planned_price: str | None = None
    max_buy_deviation_pct: str | None = None
    note: str | None = None
    strategy: str | None = None
    trade_thesis: dict | None = None


class CancelCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commandId: str = Field(min_length=1, max_length=200)
    expectedVersion: StrictInt | None = Field(default=None, ge=0)
    reason: str | None = Field(default=None, max_length=8000)


async def actor_from_request(request: Request):
    if not authorized(request.headers.get("authorization")):
        raise HTTPException(401, "internal_credential_required")
    secret = os.getenv("QUANT_PAPER_SIGNING_KEY", "")
    owner = os.getenv("QUANT_PAPER_OWNER_ID", "")
    if len(secret) < 32 or not owner:
        raise HTTPException(503, "paper_identity_not_configured")
    encoded = request.headers.get("x-zhiyu-paper-context", "")
    signature = request.headers.get("x-zhiyu-paper-signature", "")
    if not encoded or len(encoded) > 8192 or not hmac.compare_digest(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).hexdigest(), signature):
        raise HTTPException(401, "invalid_paper_signature")
    try:
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        now = time.time()
        issued, expires = claims["issuedAt"], claims["expiresAt"]
        if isinstance(issued, bool) or isinstance(expires, bool) or not isinstance(issued, (int, float)) or not isinstance(expires, (int, float)):
            raise ValueError()
        if not now - 120 <= issued <= now + 5 or not now < expires <= issued + 120:
            raise ValueError()
        raw_path = request.scope.get("raw_path")
        path = (raw_path.decode("ascii") if raw_path else request.url.path) + (f"?{request.url.query}" if request.url.query else "")
        body = await request.body()
        if claims["method"] != request.method or claims["path"] != path or claims["bodySha256"] != hashlib.sha256(body).hexdigest():
            raise ValueError()
        if str(uuid.UUID(claims["ownerId"])) != str(uuid.UUID(owner)):
            raise HTTPException(403, "paper_owner_denied")
        role, actor_id = claims["role"], claims["actorId"]
        if role not in {"owner", "trader", "scheduler"} or not isinstance(actor_id, str) or not 1 <= len(actor_id) <= 300:
            raise ValueError()
        execution = claims.get("execution") if role == "trader" else None
        if role == "trader":
            if not isinstance(execution, dict):
                raise ValueError()
            for field in ("workshopId", "runId"):
                uuid.UUID(execution[field])
            if (type(execution["token"]) is not int or execution["token"] < 1
                    or not isinstance(execution["workerId"], str) or not execution["workerId"]
                    or not isinstance(execution["policyHash"], str) or len(execution["policyHash"]) != 32):
                raise ValueError()
        return PaperActor(owner, actor_id, role, execution)
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(401, "invalid_paper_context") from exc


def service():
    return PaperTradingService(PaperLedger(), observe_paper_market)


async def respond(action):
    try:
        result = await run_in_threadpool(action)
        return JSONResponse(json.loads(canonical(result)))
    except PaperLedgerError as exc:
        reason = str(exc)
        status = 404 if reason == "paper_account_not_found" else 403 if reason == "paper_actor_denied" else 503 if reason == "paper_database_not_configured" else 409
        return JSONResponse({"status": "rejected", "reasonCode": reason}, status_code=status)
    except psycopg.errors.InsufficientPrivilege:
        return JSONResponse({"status": "rejected", "reasonCode": "paper_execution_denied"}, status_code=403)
    except (psycopg.Error, QuantProviderError):
        # Credentials and provider exception details are not exposed through HTTP.
        return JSONResponse({"status": "unavailable", "reasonCode": "paper_storage_or_control_unavailable"}, status_code=503)


@router.get("/accounts/{account_id}")
async def read_account(account_id: str, request: Request):
    actor = await actor_from_request(request)
    return await respond(lambda: PaperLedger().read(actor.owner_id, account_id))


@router.get("/migration/review")
async def migration_review(request: Request):
    actor = await actor_from_request(request)
    if actor.role != "owner":
        raise HTTPException(403, "paper_actor_denied")
    def review():
        from .paper_import_review import review_file
        from . import paper_trading
        try:
            return review_file(paper_trading.PAPER_ACCOUNT_PATH)
        except OSError:
            raise PaperLedgerError("paper_migration_source_unavailable")
    return await respond(review)


@router.get("/accounts/{account_id}/commands/{command_id}")
async def read_command(account_id: str, command_id: str, request: Request):
    actor = await actor_from_request(request)
    def read():
        result = PaperLedger().receipt(actor.owner_id, account_id, command_id)
        return {"status": "found", "receipt": result} if result else {"status": "not_found", "receipt": None}
    return await respond(read)


@router.get("/accounts/{account_id}/view")
async def account_view(account_id: str, request: Request):
    actor = await actor_from_request(request)
    def view():
        from decimal import Decimal
        def display_numbers(value):
            if isinstance(value, Decimal):
                return float(value)
            if isinstance(value, dict):
                return {k: display_numbers(v) for k, v in value.items()}
            if isinstance(value, list):
                return [display_numbers(v) for v in value]
            return value
        snapshot = PaperLedger().read(actor.owner_id, account_id)
        observation = observe_paper_market()
        result = _account_view(display_numbers(snapshot["state"]), observation.get("quotes") or {})
        result.update(id=account_id, version=snapshot["version"], storage="postgres", migrationRequired=False,
                      stateChangedAt=snapshot["state"]["updated_at"], matching=snapshot["state"].get("matching"),
                      valuation={"fetchedAt": observation.get("fetchedAt"), "warning": observation.get("warning"),
                          "quotes": {code: {"observedAt": row.get("observedAt"), "provider": row.get("provider"),
                              "qualityStatus": row.get("qualityStatus")} for code, row in observation.get("quotes", {}).items()}})
        return result
    return await respond(view)


@router.post("/accounts/{account_id}/orders")
async def submit_order(account_id: str, command: OrderCommand, request: Request):
    actor = await actor_from_request(request)
    return await respond(lambda: service().submit(actor, account_id, command.commandId,
        command.model_dump(exclude={"commandId", "expectedVersion"}), command.expectedVersion))


@router.post("/accounts/{account_id}/orders/{order_id}/cancel")
async def cancel_order(account_id: str, order_id: str, command: CancelCommand, request: Request):
    actor = await actor_from_request(request)
    return await respond(lambda: service().cancel(actor, account_id, command.commandId, order_id, command.expectedVersion, reason=command.reason))


@router.post("/accounts/{account_id}/ticks")
async def match_tick(account_id: str, command: CancelCommand, request: Request):
    actor = await actor_from_request(request)
    if command.expectedVersion is not None:
        raise HTTPException(422, "tick_does_not_accept_expected_version")
    return await respond(lambda: service().match_tick(actor, account_id, command.commandId))
