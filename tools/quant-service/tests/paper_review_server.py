"""Isolated real signed router; no market adapters or daily file access."""
import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from app import paper_trading
from app.paper_api import router
import uvicorn

source=Path(os.environ['PAPER_REVIEW_TEST_SOURCE']).resolve()
if not source.parent.name.startswith('zhiyu_test_paper_e2e_'):
    raise RuntimeError('isolated source required')
paper_trading.PAPER_ACCOUNT_PATH=source
app=FastAPI()
app.include_router(router)
@app.get('/health')
def health():
    return {'ready':True}
uvicorn.run(app,host='127.0.0.1',port=8778,log_level='warning')
