"""One-off owner-authorized simulation bootstrap; no live market matching bypass."""
import json, os, sys, uuid, shutil
from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.paper_ledger import PaperLedger
from app.paper_ledger_model import canonical, validate_state
from app.provider import _tencent_watchlist_quotes

root=Path(__file__).resolve().parents[1]
out=root/'data'/'paper_accounts'/'bootstrap-20260908'
out.mkdir(parents=True,exist_ok=True)
owner=os.environ['QUANT_PAPER_OWNER_ID']
ledger=PaperLedger()
source=out/'empty.json'
if not source.exists():
    now=datetime.now(timezone.utc).isoformat()
    source.write_text(canonical(dict(id='owner-fresh-20260908',initial_cash='1000000.00',cash='1000000.00',frozen_cash='0',realized_pnl='0',created_at=now,updated_at=now,orders=[],fills=[],lots=[])),encoding='utf-8')
legacy=root/'data'/'paper_account.json'
backup=out/'legacy-before-reset.json'
if not backup.exists(): shutil.copy2(legacy,backup)
preview=ledger.import_file(owner,source,dry_run=True)
result=ledger.import_file(owner,source,dry_run=False,controllers_stopped=True,backup_dir=out/'backups',migration_batch_id='23d329c5-f210-46fd-bf35-a579b3852c48')
account=result['accountId']
evidence=out/'quotes.json'
if not evidence.exists():
    quotes=_tencent_watchlist_quotes(['515980.SH','002716.SZ'])
    assert len(quotes)==2 and all(q['updated_at'].startswith('2026-09-08T16:') for q in quotes)
    assert {q['code']:str(q['price']) for q in quotes}=={'515980.SH':'1.017','002716.SZ':'10.61'}
    evidence.write_text(json.dumps(quotes,ensure_ascii=False,indent=2),encoding='utf-8')
quotes=json.loads(evidence.read_text(encoding='utf-8'))
payload={'method':'owner_authorized_close_price_simulation','sessionDate':'2026-09-08','quantities':{'515980.SH':10300,'002716.SZ':400},'quotes':quotes,'feeModel':'no_fees_current_ledger','authorization':'User requested fresh 1000000 cash and confirmed quantities and closing prices in current task.'}
def apply(state):
    assert not state['orders'] and not state['fills'] and not state['lots']
    now=datetime.now(timezone.utc).isoformat()
    for q in quotes:
        code=q['code']; qty=payload['quantities'][code]; price=Decimal(str(q['price'])); amount=price*qty
        key='close-20260908-'+code
        note='用户指定按2026-09-08收盘价模拟建仓；盘后录入，非实时撮合；当前账本不计手续费'
        state['orders'].append(dict(id='order-'+key,code=code,name=q['name'],side='buy',status='filled',quantity=qty,remaining_quantity=0,limit_price=price,created_at=now,updated_at=now,note=note,status_note=note,strategy='owner_close_price_bootstrap'))
        state['fills'].append(dict(id='fill-'+key,order_id='order-'+key,execution_key=key,code=code,name=q['name'],side='buy',quantity=qty,price=price,amount=amount,filled_at=now,note=note,strategy='owner_close_price_bootstrap',quoteObservedAt=q['updated_at'],provider='tencent_quote_batch',simulationTradeDate='2026-09-08'))
        state['lots'].append(dict(id='lot-'+key,code=code,name=q['name'],quantity=qty,remaining_quantity=qty,cost_price=price,trade_date='2026-09-08',created_at=now))
        state['cash']-=amount
    return {'status':'completed','method':payload['method'],'cash':str(state['cash'])}
receipt=ledger.command(owner,account,'owner-close-bootstrap-20260908','owner_close_price_bootstrap','owner:'+owner,payload,apply,expected_version=0,observation=payload)
assert ledger.command(owner,account,'owner-close-bootstrap-20260908','owner_close_price_bootstrap','owner:'+owner,payload,apply,expected_version=0,observation=payload)==receipt
snapshot=ledger.read(owner,account)
validate_state(snapshot['state'])
assert snapshot['state']['cash']==Decimal('985280.90')
assert len(snapshot['state']['fills'])==2 and len(snapshot['state']['lots'])==2
assert all('用户指定' in f['note'] and '\ufffd' not in f['note'] for f in snapshot['state']['fills'])
(out/'result.json').write_text(canonical({'accountId':account,'receipt':receipt,'snapshot':snapshot,'checks':['conservation','idempotent_replay','two_fills_two_lots','unicode_readback']}),encoding='utf-8')
print(json.dumps({'accountId':account,'cash':str(snapshot['state']['cash']),'fills':2,'checks':'passed'}))
