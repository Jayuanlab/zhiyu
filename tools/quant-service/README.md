# Embedded Quant Module

Lightweight Python service for the Zhiyu A-share quant workspace.

The service is read-only by default. It now uses a provider layer:

- `auto` mode: use AkShare real-time A-share data first, then Tencent real-time index/watchlist quotes, and only fall back to sample data when no live provider is available.
- `akshare` mode: require AkShare and fail fast when the upstream interface fails.
- `tencent` mode: use Tencent real-time quotes for major indices and the configured watchlist.
- `sample` mode: deterministic sample data for UI development.

This follows the common open-source quant stack split: AkShare for lightweight
market data access, Qlib later for research/backtesting, and vn.py later only
if live trading gateways are needed.

## Run

When developing Zhiyu from the repository root, the recommended command is:

```bash
pnpm dev
```

That command prepares the Python dependencies. Web starts `embedded_worker.py`
on demand and communicates through standard input/output. No quant port is
required.

To prepare the Python environment manually:

```bash
cd tools/quant-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

The legacy HTTP mode remains available for isolated fixtures:

```dotenv
QUANT_TRANSPORT=http
QUANT_SERVICE_URL=http://127.0.0.1:8766
```

Optional quant-service environment variables:

```dotenv
# auto | akshare | tencent | sample
QUANT_DATA_PROVIDER=auto

# auto | eastmoney | sina. Use sina when Eastmoney is blocked by a local proxy.
QUANT_AKSHARE_SOURCE=sina

# tencent | akshare | auto. Candidate discovery defaults to the fast Tencent
# theme-seed path so workshop agents do not block on slow full-market calls.
QUANT_CANDIDATE_PROVIDER=tencent

# Comma-separated A-share watchlist. Suffix can be omitted for common SH/SZ/BJ codes.
QUANT_WATCHLIST=600519.SH,300750.SZ,601318.SH,688981.SH
```

## Data Provider

The preferred live provider uses AkShare:

- `stock_zh_a_spot_em()` for沪深京 A 股实时行情。
- `stock_zh_index_spot_em(symbol="沪深重要指数")` for major indices.
- `stock_board_industry_name_em()` for industry heat when available.

The live dashboard still does not execute trades. Strategy signals are lightweight
rules over real-time quote fields and are meant for observation and follow-up
research only.

When AkShare is not installed or temporarily unavailable, the service now switches
to Tencent quote data for the configured watchlist and major indices. This keeps
the quant workspace usable with real-time prices while making the reduced data
scope visible through `data_provider=tencent` and `data_scope=indices_watchlist`.

## API

- `GET /health`
- `GET /dashboard`
- `GET /market/overview`
- `GET /market/candidates`
- `GET /watchlist`
- `GET /signals/today`
- `GET /portfolio`
- `GET /reports/daily`
