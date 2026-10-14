"""
Real market-data helpers used by the terminal UI:

  - get_quotes():    batch last price + day change for watchlist / ticker tape
  - get_news():      latest headlines for a symbol (yfinance news feed)
  - get_orderbook(): Level-2 depth for crypto (Binance public API) or
                     Level-1 bid/ask for other assets when the provider has it

Nothing here invents data. If a source has nothing, the result says so
(ok=False / available=False) and the UI shows an empty state.
"""
import json
import logging
import math
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import yfinance as yf

from cache import market_cache
from data_fetcher import resolve_universal_ticker

logger = logging.getLogger("trade_terminal.market")
_pool = ThreadPoolExecutor(max_workers=8)

QUOTE_TTL = 8        # seconds
QUOTE_FAIL_TTL = 3
NEWS_TTL = 300
BOOK_TTL = 5
MAX_QUOTES = 30


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else f


# ----------------------------------------------------------------------------
# Quotes
# ----------------------------------------------------------------------------
def _quote_one(raw: str) -> Dict[str, Any]:
    raw = raw.strip()
    symbol, asset_class = resolve_universal_ticker(raw, "AUTO")
    key = f"quote_{symbol}"
    cached = market_cache.get(key)
    if cached:
        return {**cached, "symbol": raw}

    price = prev = None
    try:
        fi = yf.Ticker(symbol).fast_info
        price = _num(fi.get("lastPrice") or fi.get("last_price"))
        prev = _num(fi.get("previousClose") or fi.get("previous_close"))
    except Exception:
        pass

    if price is None or prev is None:
        try:
            closes = yf.Ticker(symbol).history(period="5d", interval="1d")["Close"].dropna()
            if len(closes) >= 1 and price is None:
                price = _num(closes.iloc[-1])
            if len(closes) >= 2 and prev is None:
                prev = _num(closes.iloc[-2])
        except Exception:
            pass

    if price is None:
        result = {"symbol": raw, "resolved": symbol, "asset_class": asset_class, "ok": False}
        market_cache.set(key, {k: v for k, v in result.items() if k != "symbol"}, QUOTE_FAIL_TTL)
        return result

    change_pct = round((price - prev) / prev * 100, 2) if prev else None
    result = {
        "symbol": raw,
        "resolved": symbol,
        "asset_class": asset_class,
        "ok": True,
        "price": round(price, 6 if price < 1 else 2),
        "prev_close": (round(prev, 6 if prev < 1 else 2) if prev else None),
        "change_pct": change_pct,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    market_cache.set(key, {k: v for k, v in result.items() if k != "symbol"}, QUOTE_TTL)
    return result


def _quote_one_safe(raw: str) -> Dict[str, Any]:
    """One bad symbol must never fail the whole batch."""
    try:
        return _quote_one(raw)
    except Exception as e:
        logger.warning("quote failed for %r: %s", raw, e)
        return {"symbol": raw, "ok": False}


def get_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    clean = []
    for s in symbols:
        s = s.strip()
        if s and s.upper() not in [c.upper() for c in clean]:
            clean.append(s)
    return list(_pool.map(_quote_one_safe, clean[:MAX_QUOTES]))


# ----------------------------------------------------------------------------
# News
# ----------------------------------------------------------------------------
def _parse_news_item(it: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    # yfinance >= 0.2.5x nests everything under "content"; older versions are flat.
    c = it.get("content") if isinstance(it.get("content"), dict) else None
    if c:
        title = c.get("title")
        publisher = (c.get("provider") or {}).get("displayName")
        url_obj = c.get("canonicalUrl") or c.get("clickThroughUrl") or {}
        url = url_obj.get("url") if isinstance(url_obj, dict) else None
        published = c.get("pubDate") or c.get("displayTime")
    else:
        title = it.get("title")
        publisher = it.get("publisher")
        url = it.get("link")
        ts = it.get("providerPublishTime")
        published = (
            datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")
            if isinstance(ts, (int, float)) else None
        )
    if not title:
        return None
    return {"title": title, "publisher": publisher or "News", "url": url, "published": published}


def get_news(raw: str, limit: int = 8) -> Dict[str, Any]:
    symbol, _ = resolve_universal_ticker(raw, "AUTO")
    key = f"news_{symbol}"
    cached = market_cache.get(key)
    if cached is not None:
        return cached

    items: List[Dict[str, Any]] = []
    error = None
    try:
        for it in (yf.Ticker(symbol).news or []):
            parsed = _parse_news_item(it)
            if parsed:
                items.append(parsed)
            if len(items) >= limit:
                break
    except Exception as e:
        error = str(e)

    result = {"ok": error is None, "symbol": symbol, "items": items}
    if error:
        result["error"] = error
    market_cache.set(key, result, 30 if error else NEWS_TTL)
    return result


# ----------------------------------------------------------------------------
# Order book
# ----------------------------------------------------------------------------
def _binance_depth(base: str, limit: int = 10) -> Optional[Dict[str, Any]]:
    if not re.fullmatch(r"[A-Z0-9]{2,10}", base):  # base comes from user input; keep the request URL well-formed
        return None
    pair = f"{base}USDT"
    url = f"https://api.binance.com/api/v3/depth?symbol={pair}&limit={limit}"
    try:
        with urllib.request.urlopen(url, timeout=4) as resp:
            data = json.loads(resp.read().decode())
        bids = [{"price": float(p), "qty": float(q)} for p, q in data.get("bids", [])[:5]]
        asks = [{"price": float(p), "qty": float(q)} for p, q in data.get("asks", [])[:5]]
        if bids and asks:
            return {
                "available": True, "level": "L2",
                "source": f"Binance spot depth ({pair})",
                "bids": bids, "asks": asks,
            }
    except Exception:
        pass
    return None


def get_orderbook(raw: str) -> Dict[str, Any]:
    symbol, asset_class = resolve_universal_ticker(raw, "AUTO")
    key = f"book_{symbol}"
    cached = market_cache.get(key)
    if cached is not None:
        return cached

    result: Optional[Dict[str, Any]] = None

    if asset_class == "CRYPTO" and symbol.endswith("-USD"):
        result = _binance_depth(symbol.split("-")[0])

    if result is None:
        try:
            info = yf.Ticker(symbol).info or {}
            bid, ask = _num(info.get("bid")), _num(info.get("ask"))
            bid_sz, ask_sz = _num(info.get("bidSize")), _num(info.get("askSize"))
            if bid and ask and bid > 0 and ask > 0:
                result = {
                    "available": True, "level": "L1", "source": "Best bid/ask (Level 1)",
                    "bids": [{"price": bid, "qty": bid_sz}],
                    "asks": [{"price": ask, "qty": ask_sz}],
                }
        except Exception:
            pass

    if result is None:
        result = {
            "available": False, "symbol": symbol,
            "reason": "No live bid/ask depth from the data provider for this instrument (market closed or not supported).",
        }
    else:
        result["symbol"] = symbol

    market_cache.set(key, result, BOOK_TTL)
    return result
