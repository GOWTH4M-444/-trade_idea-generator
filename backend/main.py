import logging
import math
import os
import re

import pandas as pd
import yfinance as yf
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from ai_analyzer import generate_trade_ideas  # noqa: E402  (after load_dotenv so env is populated)
from auth import (  # noqa: E402
    add_to_watchlist, create_alert, get_user_alerts, get_user_watchlist,
    login_user, register_user, remove_from_watchlist,
)
from backtester import run_backtest  # noqa: E402
from cache import market_cache  # noqa: E402
from data_fetcher import fetch_stock_data, resolve_universal_ticker, search_symbols_quick  # noqa: E402
from database import get_trade_history, save_trade_history  # noqa: E402
from indicators import calculate_indicators  # noqa: E402
from market_extras import get_news, get_orderbook, get_quotes  # noqa: E402
from trade_logic import (  # noqa: E402
    ALERT_CONDITIONS, VALID_INTERVALS, VALID_PERIODS,
    build_fallback_ideas, sanitize_for_json,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("trade_terminal.api")

app = FastAPI(
    title="Institutional AI Trade Terminal API",
    description="Multi-Asset Quantitative & AI Engine with Live Price Polling, TradingView Charts, Backtesting, and SQLite History.",
    version="3.2.0",
)

# CORS: set CORS_ORIGINS="https://your-frontend.onrender.com,http://localhost:5500" in production.
# Browsers reject a wildcard origin combined with credentials, so credentials are only enabled
# when explicit origins are configured.
_cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials="*" not in _cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

TICKER_RE = re.compile(r"^[\^A-Za-z0-9.=\-& ]{1,40}$")
LIVE_PRICE_TTL = 4  # seconds


def _api_key_configured() -> bool:
    key = os.getenv("ANTHROPIC_API_KEY")
    return bool(key and key != "your_anthropic_api_key_here")


def _clean_ticker(ticker: str) -> str:
    t = (ticker or "").strip()
    if not t:
        raise HTTPException(status_code=400, detail="Ticker symbol cannot be empty.")
    if not TICKER_RE.match(t):
        raise HTTPException(status_code=400, detail="Ticker contains unsupported characters.")
    return t


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "Institutional AI Trade Terminal API v3.2",
        "anthropic_api_key_status": "configured" if _api_key_configured() else "missing_key",
        "ai_model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        "features": ["live_price_polling", "tradingview_candlesticks", "backtesting", "authentication", "sqlite_history"],
    }


@app.get("/live-price")
def get_live_price(
    ticker: str = Query(..., description="Stock/Asset ticker symbol (e.g. AAPL, RELIANCE, NIFTY)"),
    market: str = Query("AUTO", description="Market region: US, IN, or AUTO"),
):
    """Latest near-real-time price + day change. Cached for a few seconds so polling clients can't hammer yfinance."""
    ticker = _clean_ticker(ticker)
    formatted_symbol, asset_class = resolve_universal_ticker(ticker, market)

    cache_key = f"live_{formatted_symbol}"
    cached = market_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        yf_ticker = yf.Ticker(formatted_symbol)
        price = None
        prev_close = None
        change_pct = 0.0

        # Method 1: fast_info (lowest latency)
        try:
            fast = yf_ticker.fast_info
            price = fast.get("lastPrice") or fast.get("last_price")
            prev_close = fast.get("previousClose") or fast.get("previous_close")
        except Exception:
            pass

        # Method 2: recent 1-minute bars
        if price is None or math.isnan(price):
            df_recent = yf.download(formatted_symbol, period="5d", interval="1m", progress=False)
            if not df_recent.empty:
                if isinstance(df_recent.columns, pd.MultiIndex):
                    df_recent.columns = df_recent.columns.get_level_values(0)
                price = float(df_recent["Close"].dropna().iloc[-1])

        # Method 3 (also supplies the previous close): daily bars
        if price is None or math.isnan(price) or prev_close is None or (isinstance(prev_close, float) and math.isnan(prev_close)):
            try:
                daily = yf.download(formatted_symbol, period="5d", interval="1d", progress=False)
                if isinstance(daily.columns, pd.MultiIndex):
                    daily.columns = daily.columns.get_level_values(0)
                closes = daily["Close"].dropna()
                if (price is None or math.isnan(price)) and len(closes) >= 1:
                    price = float(closes.iloc[-1])
                if len(closes) >= 2:
                    prev_close = float(closes.iloc[-2])
            except Exception:
                pass

        if price is None or math.isnan(price):
            raise ValueError(f"Unable to fetch live quote for {formatted_symbol}.")

        if prev_close and not math.isnan(prev_close) and prev_close != 0:
            change_pct = round(((price - prev_close) / prev_close) * 100, 2)

        result = sanitize_for_json({
            "success": True,
            "ticker": formatted_symbol,
            "raw_ticker": ticker.upper(),
            "asset_class": asset_class,
            "price": float(price),
            "change_percent": change_pct,
            "timestamp": pd.Timestamp.now().strftime("%H:%M:%S"),
        })
        market_cache.set(cache_key, result, LIVE_PRICE_TTL)
        return result

    except Exception as e:
        logger.warning("live-price failed for %s: %s", formatted_symbol, e)
        return sanitize_for_json({"success": False, "ticker": formatted_symbol, "error": str(e), "status": "feed_delayed"})


@app.get("/quotes")
def batch_quotes(tickers: str = Query(..., description="Comma-separated symbols, e.g. AAPL,^NSEI,BTC-USD")):
    """Real last price + day change for many symbols at once (watchlist, ticker tape)."""
    symbols = [t.strip() for t in tickers.split(",") if t.strip() and TICKER_RE.match(t.strip())]
    if not symbols:
        raise HTTPException(status_code=400, detail="tickers parameter is required.")
    return sanitize_for_json({"quotes": get_quotes(symbols)})


@app.get("/news")
def ticker_news(ticker: str = Query(...), limit: int = Query(8, ge=1, le=20)):
    """Latest real headlines for a symbol."""
    return sanitize_for_json(get_news(_clean_ticker(ticker), limit))


@app.get("/orderbook")
def ticker_orderbook(ticker: str = Query(...)):
    """Real order-book depth (crypto L2) or best bid/ask (L1); available=false when unsupported."""
    return sanitize_for_json(get_orderbook(_clean_ticker(ticker)))


@app.get("/search")
def search_tickers(query: str = Query(..., description="Query term for ticker search")):
    if not query or len(query.strip()) < 1:
        return {"suggestions": []}
    return {"suggestions": search_symbols_quick(query[:40])}


# 1. USER AUTHENTICATION ENDPOINTS
# NOTE: user_id on the endpoints below is supplied by the client and there are no session tokens yet,
# so these are suitable for a single-user / demo deployment, not for hostile multi-user use.
@app.post("/auth/register")
def register(payload: dict = Body(...)):
    username, email, password = payload.get("username"), payload.get("email"), payload.get("password")
    if not username or not email or not password:
        raise HTTPException(status_code=400, detail="Username, email, and password required.")
    try:
        return register_user(username, email, password)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@app.post("/auth/login")
def login(payload: dict = Body(...)):
    username, password = payload.get("username"), payload.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required.")
    try:
        return login_user(username, password)
    except ValueError as ve:
        raise HTTPException(status_code=401, detail=str(ve))


# 2. WATCHLIST ENDPOINTS
@app.get("/watchlist")
def get_watchlist(user_id: int = Query(1)):
    return {"watchlist": get_user_watchlist(user_id)}


@app.post("/watchlist/add")
def add_watchlist(payload: dict = Body(...)):
    ticker = payload.get("ticker")
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required.")
    try:
        return add_to_watchlist(int(payload.get("user_id", 1)), ticker, payload.get("market", "AUTO"), payload.get("asset_class", "STOCK"))
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/watchlist/remove")
def remove_watchlist(user_id: int = Query(1), ticker: str = Query(...)):
    return remove_from_watchlist(user_id, ticker)


# 3. TRADE HISTORY ENDPOINT
@app.get("/history")
def get_history(ticker: str = Query(None), limit: int = Query(20, ge=1, le=200)):
    return {"history": get_trade_history(ticker=ticker, limit=limit)}


# 4. BACKTESTING ENGINE ENDPOINT
@app.get("/backtest")
def backtest_ticker(
    ticker: str = Query(..., description="Asset ticker to backtest strategy"),
    initial_capital: float = Query(10000.0, gt=0, le=1e9, description="Initial capital ($/₹)"),
    risk_pct: float = Query(2.0, gt=0, le=25, description="Risk per trade %"),
):
    ticker = _clean_ticker(ticker)
    try:
        df, meta = fetch_stock_data(ticker=ticker, period="1y", interval="1d")
        results = run_backtest(df, initial_capital=initial_capital, risk_per_trade_pct=risk_pct)
        return sanitize_for_json({"success": True, "ticker": meta["symbol"], "metadata": meta, "backtest": results})
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception:
        logger.exception("backtest failed for %s", ticker)
        raise HTTPException(status_code=502, detail="Backtest failed because the market data provider returned an error. Please retry.")


# 5. ALERTS ENDPOINT
@app.post("/alerts/create")
def create_new_alert(payload: dict = Body(...)):
    ticker = payload.get("ticker")
    condition = str(payload.get("condition_type", "PRICE_ABOVE")).upper()
    target = payload.get("target_value")
    if not ticker or target is None or target == "":
        raise HTTPException(status_code=400, detail="Ticker and target_value required.")
    if condition not in ALERT_CONDITIONS:
        raise HTTPException(status_code=400, detail=f"condition_type must be one of: {', '.join(sorted(ALERT_CONDITIONS))}.")
    try:
        target_value = float(target)
        if not math.isfinite(target_value):
            raise ValueError
        return create_alert(int(payload.get("user_id", 1)), ticker, condition, target_value)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e) if str(e) else "target_value must be a finite number.")


@app.get("/alerts")
def get_alerts(user_id: int = Query(1)):
    return {"alerts": get_user_alerts(user_id)}


# 6. ANALYZE & EXPLAINABILITY ENDPOINT
def _fallback_warning(err_msg: str) -> str:
    low = err_msg.lower()
    if "not set" in low:
        return "ANTHROPIC_API_KEY not configured. Showing rule-based quantitative setups."
    if "credit balance" in low:
        return "Anthropic account balance is low. Showing rule-based quantitative setups."
    if "authentication" in low or "invalid x-api-key" in low or "401" in low:
        return "Anthropic API key was rejected. Showing rule-based quantitative setups."
    if "not_found" in low or "model" in low and "not" in low:
        return "Configured Claude model is unavailable (check ANTHROPIC_MODEL). Showing rule-based quantitative setups."
    return "Claude is temporarily unavailable. Showing rule-based quantitative setups."


@app.get("/analyze")
def analyze_stock(
    ticker: str = Query(..., description="Asset symbol (e.g. AAPL, RELIANCE, NIFTY, BTC, GOLD)"),
    market: str = Query("AUTO", description="Market region: US, IN, or AUTO"),
    interval: str = Query("1d", description="Timeframe interval: 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1wk"),
    period: str = Query("6mo", description="Historical period: 1mo, 3mo, 6mo, 1y, 2y, 5y"),
):
    ticker = _clean_ticker(ticker)
    if interval not in VALID_INTERVALS:
        raise HTTPException(status_code=400, detail=f"interval must be one of: {', '.join(sorted(VALID_INTERVALS))}.")
    if period not in VALID_PERIODS:
        raise HTTPException(status_code=400, detail=f"period must be one of: {', '.join(sorted(VALID_PERIODS))}.")

    try:
        df, metadata = fetch_stock_data(ticker=ticker, market=market, period=period, interval=interval)
        indicators = calculate_indicators(df)
        combined_payload = {**metadata, **indicators}

        df_recent = df.tail(60).copy()  # duplicates were already removed in fetch_stock_data

        timestamps = []
        intraday = interval.endswith("m") or interval.endswith("h")
        for d in df_recent.index:
            try:
                timestamps.append(int(d.timestamp()) if intraday else d.strftime("%Y-%m-%d"))
            except Exception:
                timestamps.append(str(d)[:10])

        sma20_list = [float(v) if not pd.isna(v) else None for v in df_recent["Close"].rolling(20).mean()]
        sma50_list = [float(v) if not pd.isna(v) else None for v in df_recent["Close"].rolling(50).mean()]

        chart_data = {
            "timestamps": timestamps,
            "opens": [float(o) for o in df_recent["Open"]],
            "prices": [float(p) for p in df_recent["Close"]],
            "highs": [float(h) for h in df_recent["High"]],
            "lows": [float(l) for l in df_recent["Low"]],
            "volumes": [int(v) if not pd.isna(v) else 0 for v in df_recent["Volume"]],
            "sma20": sma20_list,
            "sma50": sma50_list,
        }

        api_key_configured = _api_key_configured()

        try:
            ai_response = generate_trade_ideas(combined_payload)
        except Exception as ai_err:
            logger.warning("AI generation unavailable for %s (%s): %s", metadata["symbol"], type(ai_err).__name__, ai_err)
            ai_response = {
                "source": "quant-fallback",
                "warning": _fallback_warning(str(ai_err)),
                "ticker": metadata["symbol"],
                "asset_class": metadata["asset_class"],
                "overall_sentiment": indicators["sentiment"],
                "trade_ideas": build_fallback_ideas(metadata, indicators, interval),
            }

        try:
            save_trade_history(
                ticker=metadata["symbol"],
                asset_class=metadata["asset_class"],
                timeframe=interval,
                current_price=indicators["current_price"],
                rsi_14=indicators["rsi_14"],
                tech_score=indicators["technical_score"],
                ai_json=ai_response,
                raw_payload=combined_payload,
            )
        except Exception:
            logger.exception("could not save trade history for %s", metadata["symbol"])

        explainability_audit = {
            "prompt_math_sent_to_ai": {
                "ticker": metadata["symbol"],
                "current_price": indicators["current_price"],
                "rsi_14": indicators["rsi_14"],
                "sma_20": indicators["sma_20"],
                "sma_50": indicators["sma_50"],
                "macd_status": indicators["macd_status"],
                "bollinger_status": indicators["bb_status"],
                "support_levels": indicators["support_levels"],
                "resistance_levels": indicators["resistance_levels"],
                "technical_score": indicators["technical_score"],
            },
            "ai_written_output": ai_response,
        }

        return sanitize_for_json({
            "success": True,
            "metadata": metadata,
            "indicators": indicators,
            "chart_data": chart_data,
            "ai_analysis": ai_response,
            "explainability_audit": explainability_audit,
            "api_key_configured": api_key_configured,
        })

    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception:
        logger.exception("analyze failed for %s", ticker)
        raise HTTPException(status_code=502, detail="Could not complete the analysis because the market data provider returned an error. Please retry.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
