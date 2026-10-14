import yfinance as yf
import pandas as pd
from typing import Tuple, Dict, Any, List
from cache import market_cache
from trade_logic import VALID_INTERVALS, VALID_PERIODS, round_price

INDIAN_INDEX_PREFIXES = ("^NSE", "^BSE", "^CNX")

POPULAR_ALIASES = {
    # Indices
    "NIFTY": "^NSEI",
    "NIFTY50": "^NSEI",
    "NIFTY 50": "^NSEI",
    "BANKNIFTY": "^NSEBANK",
    "BANK NIFTY": "^NSEBANK",
    "FINNIFTY": "NIFTY_FIN_SERVICE.NS",
    "SENSEX": "^BSESN",
    "BSE SENSEX": "^BSESN",
    "SP500": "^GSPC",
    "S&P500": "^GSPC",
    "S&P 500": "^GSPC",
    "NASDAQ": "^IXIC",
    "NASDAQ 100": "^NDX",
    "DOW": "^DJI",
    "DOW JONES": "^DJI",
    
    # Sensex & Nifty Top Indian Stocks
    "RELIANCE": "RELIANCE.NS",
    "TCS": "TCS.NS",
    "INFY": "INFY.NS",
    "INFOSYS": "INFY.NS",
    "HDFCBANK": "HDFCBANK.NS",
    "ICICIBANK": "ICICIBANK.NS",
    "SBIN": "SBIN.NS",
    "SBI": "SBIN.NS",
    "BHARTIARTL": "BHARTIARTL.NS",
    "AIRTEL": "BHARTIARTL.NS",
    "ITC": "ITC.NS",
    "KOTAKBANK": "KOTAKBANK.NS",
    "LT": "LT.NS",
    "LARSEN": "LT.NS",
    "TATAMOTORS": "TATAMOTORS.NS",
    "TATA MOTORS": "TATAMOTORS.NS",
    "MARUTI": "MARUTI.NS",
    "SUNPHARMA": "SUNPHARMA.NS",
    "ASIANPAINT": "ASIANPAINT.NS",
    "TITAN": "TITAN.NS",
    "ULTRACEMCO": "ULTRACEMCO.NS",
    "BAJFINANCE": "BAJFINANCE.NS",
    "BAJAJ FINANCE": "BAJFINANCE.NS",
    "AXISBANK": "AXISBANK.NS",
    "HINDUNILVR": "HINDUNILVR.NS",
    "HUL": "HINDUNILVR.NS",
    "HINDUSTAN UNILEVER": "HINDUNILVR.NS",
    "NIFTYBEES": "NIFTYBEES.NS",

    # Crypto
    "BTC": "BTC-USD",
    "BITCOIN": "BTC-USD",
    "ETH": "ETH-USD",
    "ETHEREUM": "ETH-USD",
    "SOL": "SOL-USD",
    "SOLANA": "SOL-USD",
    "DOGE": "DOGE-USD",
    "XRP": "XRP-USD",
    "BNB": "BNB-USD",
    "ADA": "ADA-USD",

    # Commodities & Futures
    "GOLD": "GC=F",
    "GOLD FUTURES": "GC=F",
    "SILVER": "SI=F",
    "SILVER FUTURES": "SI=F",
    "CRUDE": "CL=F",
    "CRUDE OIL": "CL=F",
    "OIL": "CL=F",
    "NATURAL GAS": "NG=F",
    "NATGAS": "NG=F",
    "COPPER": "HG=F",

    # Forex Pairs
    "EURUSD": "EURUSD=X",
    "USDINR": "USDINR=X",
    "GBPUSD": "GBPUSD=X",
    "USDJPY": "JPY=X"
}

def resolve_universal_ticker(ticker: str, market: str = "AUTO", asset_class: str = "AUTO") -> Tuple[str, str]:
    clean = ticker.strip().upper()
    
    if clean in POPULAR_ALIASES:
        resolved = POPULAR_ALIASES[clean]
        if resolved.startswith("^"):
            detected_asset = "INDEX"
        elif "-USD" in resolved:
            detected_asset = "CRYPTO"
        elif "=F" in resolved:
            detected_asset = "FUTURES"
        elif "=X" in resolved:
            detected_asset = "FOREX"
        else:
            detected_asset = "STOCK"
        return resolved, detected_asset

    if asset_class.upper() == "CRYPTO" or clean in ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB", "ADA"]:
        if not clean.endswith("-USD") and not clean.endswith("-INR"):
            return f"{clean}-USD", "CRYPTO"
        return clean, "CRYPTO"

    if clean.endswith("-USD") or clean.endswith("-INR") or clean.endswith("-USDT"):
        return clean, "CRYPTO"

    if asset_class.upper() == "FOREX" or clean.endswith("=X"):
        if not clean.endswith("=X"):
            return f"{clean}=X", "FOREX"
        return clean, "FOREX"

    if asset_class.upper() == "FUTURES" or asset_class.upper() == "COMMODITY" or clean.endswith("=F"):
        if not clean.endswith("=F"):
            return f"{clean}=F", "FUTURES"
        return clean, "FUTURES"

    if clean.startswith("^"):
        return clean, "INDEX"

    if market.upper() == "IN":
        if not (clean.endswith(".NS") or clean.endswith(".BO")):
            return f"{clean}.NS", "STOCK"

    # Auto-detect Indian stocks by symbol pattern or popularity
    indian_known = [
        "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "BHARTIARTL",
        "ITC", "KOTAKBANK", "LT", "TATAMOTORS", "MARUTI", "SUNPHARMA", "ASIANPAINT",
        "TITAN", "ULTRACEMCO", "BAJFINANCE", "AXISBANK", "HINDUNILVR", "WIPRO", "HCLTECH"
    ]
    if clean in indian_known:
        return f"{clean}.NS", "STOCK"

    return clean, "STOCK"

def fetch_stock_data(ticker: str, market: str = "AUTO", period: str = "6mo", interval: str = "1d") -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Fetches historical OHLCV data & metadata supporting multi-timeframe intervals (1h, 4h, 1d, 1wk)
    with fast TTL cache protection.
    """
    if interval not in VALID_INTERVALS:
        raise ValueError(f"Unsupported interval '{interval}'. Use one of: {', '.join(sorted(VALID_INTERVALS))}.")
    if period not in VALID_PERIODS:
        raise ValueError(f"Unsupported period '{period}'. Use one of: {', '.join(sorted(VALID_PERIODS))}.")

    formatted_symbol, detected_asset = resolve_universal_ticker(ticker, market)

    # yfinance has no native 4h bar: fetch 1h and resample below.
    fetch_interval = "1h" if interval == "4h" else interval
    if fetch_interval in ["1m", "2m", "5m"]:
        fetch_period = "5d"
    elif fetch_interval in ["15m", "30m", "60m", "1h"]:
        fetch_period = "1mo"
    elif fetch_interval == "1wk":
        fetch_period = "2y"  # 6 months of weekly bars (~26) is too short for MACD/SMA20
    else:
        fetch_period = period

    cache_key = f"{formatted_symbol}_{fetch_period}_{interval}"
    cached_result = market_cache.get(cache_key)

    if cached_result:
        # Hand out copies so one request can never mutate another request's cached data
        return cached_result["df"].copy(), dict(cached_result["metadata"])

    df = pd.DataFrame()

    try:
        df = yf.download(formatted_symbol, period=fetch_period, interval=fetch_interval, progress=False)
    except Exception:
        df = pd.DataFrame()

    if df.empty:
        try:
            yf_ticker = yf.Ticker(formatted_symbol)
            df = yf_ticker.history(period=fetch_period, interval=fetch_interval)
        except Exception:
            df = pd.DataFrame()

    if df.empty and market.upper() == "IN" and not formatted_symbol.endswith(".BO"):
        fallback_symbol = formatted_symbol.replace(".NS", ".BO")
        try:
            df = yf.download(fallback_symbol, period=fetch_period, interval=fetch_interval, progress=False)
            if not df.empty:
                formatted_symbol = fallback_symbol
        except Exception:
            pass

    if df.empty:
        raise ValueError(f"No market data found for '{ticker}' (Symbol: {formatted_symbol}, Interval: {interval}). Please verify symbol.")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df.dropna(subset=["Close"])
    df = df[~df.index.duplicated(keep="last")]  # yfinance occasionally repeats the live bar
    if df.empty:
        raise ValueError(f"No valid price history found for '{ticker}'.")

    if interval == "4h":
        # Bars are anchored to the start of each calendar day in the exchange timezone.
        df = df.resample("4h").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
        df = df.dropna(subset=["Close"])
        if df.empty:
            raise ValueError(f"No valid 4h price history found for '{ticker}'.")

    latest_close = float(df["Close"].iloc[-1])
    is_inr = (formatted_symbol.endswith(".NS") or formatted_symbol.endswith(".BO")
              or formatted_symbol.startswith(INDIAN_INDEX_PREFIXES) or formatted_symbol.endswith("-INR"))
    currency = "INR" if is_inr else "USD"

    company_name = formatted_symbol
    pe_ratio = None
    market_cap = None
    hi_52w = None
    lo_52w = None

    try:
        info = yf.Ticker(formatted_symbol).info
        if isinstance(info, dict):
            company_name = info.get("shortName") or info.get("longName") or info.get("name") or formatted_symbol
            pe_ratio = info.get("trailingPE") or info.get("forwardPE")
            market_cap = info.get("marketCap") or info.get("totalAssets")
            hi_52w = info.get("fiftyTwoWeekHigh")
            lo_52w = info.get("fiftyTwoWeekLow")
            if info.get("currency"):
                currency = info.get("currency")
    except Exception:
        pass

    metadata = {
        "symbol": formatted_symbol,
        "raw_ticker": ticker.strip().upper(),
        "asset_class": detected_asset,
        "interval": interval,
        "company_name": company_name,
        "currency": currency,
        "pe_ratio": pe_ratio,
        "market_cap": market_cap,
        "fifty_two_week_high": float(hi_52w) if hi_52w else float(df["High"].max()),
        "fifty_two_week_high_is_true_52w": bool(hi_52w),
        "fifty_two_week_low": float(lo_52w) if lo_52w else float(df["Low"].min()),
        "current_price": round_price(latest_close),
        "open": round_price(float(df["Open"].iloc[-1])),
        "high": round_price(float(df["High"].iloc[-1])),
        "low": round_price(float(df["Low"].iloc[-1])),
        "close": round_price(float(df["Close"].iloc[-1])),
        "volume": int(df["Volume"].iloc[-1]) if not pd.isna(df["Volume"].iloc[-1]) else 0
    }

    # Store in TTL Cache (5 min)
    market_cache.set(cache_key, {"df": df, "metadata": metadata})

    return df.copy(), dict(metadata)

def search_symbols_quick(query: str) -> List[Dict[str, str]]:
    q = query.strip().upper()
    if not q:
        return []
    results = []
    seen = set()

    def add(item):
        if item["symbol"] not in seen:
            seen.add(item["symbol"])
            results.append(item)

    preset_suggestions = [
        # NASDAQ 100 & US Leaders
        {"name": "Apple Inc.", "symbol": "AAPL", "type": "US NASDAQ"},
        {"name": "Nvidia Corp", "symbol": "NVDA", "type": "US NASDAQ"},
        {"name": "Tesla Inc.", "symbol": "TSLA", "type": "US NASDAQ"},
        {"name": "Microsoft Corp", "symbol": "MSFT", "type": "US NASDAQ"},
        {"name": "Amazon.com Inc.", "symbol": "AMZN", "type": "US NASDAQ"},
        {"name": "Alphabet Inc (Google)", "symbol": "GOOGL", "type": "US NASDAQ"},
        {"name": "Meta Platforms", "symbol": "META", "type": "US NASDAQ"},
        {"name": "Advanced Micro Devices", "symbol": "AMD", "type": "US NASDAQ"},
        {"name": "Netflix Inc", "symbol": "NFLX", "type": "US NASDAQ"},
        {"name": "Palantir Tech", "symbol": "PLTR", "type": "US NYSE"},
        {"name": "Invesco QQQ ETF", "symbol": "QQQ", "type": "US ETF"},
        {"name": "SPDR S&P 500 ETF", "symbol": "SPY", "type": "US ETF"},

        # Sensex & Nifty Top Indian Stocks
        {"name": "Reliance Industries", "symbol": "RELIANCE.NS", "type": "Indian NSE/BSE"},
        {"name": "Tata Consultancy Services", "symbol": "TCS.NS", "type": "Indian NSE/BSE"},
        {"name": "Infosys Ltd", "symbol": "INFY.NS", "type": "Indian NSE/BSE"},
        {"name": "HDFC Bank", "symbol": "HDFCBANK.NS", "type": "Indian NSE/BSE"},
        {"name": "ICICI Bank", "symbol": "ICICIBANK.NS", "type": "Indian NSE/BSE"},
        {"name": "State Bank of India", "symbol": "SBIN.NS", "type": "Indian NSE/BSE"},
        {"name": "Bharti Airtel", "symbol": "BHARTIARTL.NS", "type": "Indian NSE/BSE"},
        {"name": "ITC Ltd", "symbol": "ITC.NS", "type": "Indian NSE/BSE"},
        {"name": "Larsen & Toubro", "symbol": "LT.NS", "type": "Indian NSE/BSE"},
        {"name": "Tata Motors", "symbol": "TATAMOTORS.NS", "type": "Indian NSE/BSE"},
        {"name": "Maruti Suzuki", "symbol": "MARUTI.NS", "type": "Indian NSE/BSE"},
        {"name": "Sun Pharma", "symbol": "SUNPHARMA.NS", "type": "Indian NSE/BSE"},
        {"name": "Bajaj Finance", "symbol": "BAJFINANCE.NS", "type": "Indian NSE/BSE"},

        # Major Global Indices & Futures
        {"name": "BSE Sensex Index", "symbol": "^BSESN", "type": "Index"},
        {"name": "Nifty 50 Index", "symbol": "^NSEI", "type": "Index"},
        {"name": "Bank Nifty Index", "symbol": "^NSEBANK", "type": "Index"},
        {"name": "NASDAQ 100 Index", "symbol": "^NDX", "type": "Index"},
        {"name": "S&P 500 Index", "symbol": "^GSPC", "type": "Index"},
        {"name": "Dow Jones Index", "symbol": "^DJI", "type": "Index"},
        {"name": "Gold Futures", "symbol": "GC=F", "type": "Futures/Commodity"},
        {"name": "Silver Futures", "symbol": "SI=F", "type": "Futures/Commodity"},
        {"name": "Crude Oil Futures", "symbol": "CL=F", "type": "Futures/Commodity"},
        {"name": "Natural Gas Futures", "symbol": "NG=F", "type": "Futures/Commodity"},

        # Crypto & Forex
        {"name": "Bitcoin USD", "symbol": "BTC-USD", "type": "Crypto"},
        {"name": "Ethereum USD", "symbol": "ETH-USD", "type": "Crypto"},
        {"name": "Solana USD", "symbol": "SOL-USD", "type": "Crypto"},
        {"name": "USD to INR Forex", "symbol": "USDINR=X", "type": "Forex"},
        {"name": "EUR to USD Forex", "symbol": "EURUSD=X", "type": "Forex"}
    ]

    # Curated entries (real company names) first, then raw aliases; de-duplicated by symbol
    for item in preset_suggestions:
        if q in item["name"].upper() or q in item["symbol"].upper():
            add(item)

    for name, sym in POPULAR_ALIASES.items():
        if q in name or q in sym:
            add({"name": name.title(), "symbol": sym, "type": "GLOBAL ASSET"})

    def rank(item):
        sym, name = item["symbol"].upper(), item["name"].upper()
        if sym == q: return 0
        if sym.startswith(q): return 1
        if name.startswith(q): return 2
        return 3

    results.sort(key=rank)  # stable: keeps curated-before-alias order within a rank
    return results[:10]
