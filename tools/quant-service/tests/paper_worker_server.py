"""Real signed router and ledger with deterministic market observations for worker tests."""
import os
import sys
import uuid
import socket
import json
from pathlib import Path
from datetime import datetime
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from paper_ledger_integration import PaperLedger, PaperTradingService, PaperActor, fresh, canonical, market, NOW, OWNER
from app import paper_api
from fastapi import FastAPI
import uvicorn

directory = Path(os.environ['PAPER_WORKER_TEST_DIRECTORY']).resolve()
if not directory.name.startswith('zhiyu_test_paper_worker_'):
    raise RuntimeError('isolated directory required')
source = directory / 'source.json'
source.write_text(canonical(fresh()), encoding='utf-8')
ledger = PaperLedger(os.environ['QUANT_PAPER_DATABASE_URL'])
account = ledger.import_file(OWNER, source, dry_run=False, controllers_stopped=True,
    backup_dir=directory / 'backup', migration_batch_id=str(uuid.uuid4()))['accountId']
observations = 0
now = datetime.fromisoformat(NOW)
def observe():
    global observations
    observations += 1
    return market(now)
service = PaperTradingService(ledger, observe, clock=lambda: now, control_guard=lambda: None)
service.submit(PaperActor(OWNER, 'fixture-owner', 'owner'), account, 'fixture-buy',
    {'code': '159278.SZ', 'side': 'buy', 'quantity': 100, 'limit_price': '0.957'})
paper_api.service = lambda: service
app = FastAPI()
app.include_router(paper_api.router)
@app.get('/health')
def health():
    return {'owner': OWNER, 'account': account, 'observations': observations}
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    (directory / 'ready.json').write_text(json.dumps({'port': port, 'owner': OWNER}), encoding='utf-8')
    uvicorn.Server(uvicorn.Config(app, log_level='warning')).run(sockets=[listener])
