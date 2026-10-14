import pandas as pd
import numpy as np
from typing import Dict, Any, List
from trade_logic import round_price as rp
from ta.momentum import RSIIndicator
from ta.trend import SMAIndicator, EMAIndicator, MACD
from ta.volatility import BollingerBands, AverageTrueRange

MIN_BARS = 30  # MACD(26) / Bollinger(20) are undefined (NaN) on fewer bars


def _last(series, default: float = 0.0) -> float:
    """Last value of a price-scale indicator series, or `default` when it is NaN (never leaks NaN to the API)."""
    v = series.iloc[-1]
    return rp(float(v)) if not np.isnan(v) else default


def calculate_support_resistance(df: pd.DataFrame) -> Dict[str, List[float]]:
    """Calculates key support and resistance levels from price history."""
    highs = df['High'].values
    lows = df['Low'].values
    current_price = float(df['Close'].iloc[-1])
    
    swing_supports = []
    swing_resistances = []
    
    n = len(df)
    for i in range(2, n - 2):
        if lows[i] < lows[i-1] and lows[i] < lows[i-2] and lows[i] < lows[i+1] and lows[i] < lows[i+2]:
            swing_supports.append(rp(float(lows[i])))
        if highs[i] > highs[i-1] and highs[i] > highs[i-2] and highs[i] > highs[i+1] and highs[i] > highs[i+2]:
            swing_resistances.append(rp(float(highs[i])))

    recent_20_low = rp(float(df['Low'].tail(20).min()))
    recent_20_high = rp(float(df['High'].tail(20).max()))

    all_supports = sorted(list(set(swing_supports + [recent_20_low])))
    all_resistances = sorted(list(set(swing_resistances + [recent_20_high])))

    supports_below = [s for s in all_supports if s <= current_price]
    resistances_above = [r for r in all_resistances if r >= current_price]
    
    # Both lists are ordered nearest-to-price first, so index 0 is always the closest level.
    final_supports = supports_below[::-1][:3] if supports_below else [rp(current_price * 0.95)]
    final_resistances = resistances_above[:3] if resistances_above else [rp(current_price * 1.05)]
    
    return {
        "support_levels": final_supports,
        "resistance_levels": final_resistances
    }

def calculate_indicators(df: pd.DataFrame) -> Dict[str, Any]:
    """
    Computes Pro Technical Indicator Suite:
    - RSI (14-day)
    - SMAs (20, 50, 200)
    - EMAs (9, 21) & Cross Signals
    - MACD (MACD line, Signal line, Histogram)
    - Bollinger Bands (Upper, Middle, Lower, Squeeze)
    - Volume Trend & Spike Ratio
    - Support & Resistance Levels
    - Composite Technical Score (0 to 100)
    """
    if df.empty or len(df) < MIN_BARS:
        raise ValueError(f"Insufficient historical data (need at least {MIN_BARS} price bars, got {len(df)}).")

    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    volume = df["Volume"]

    # 1. RSI 14
    rsi_series = RSIIndicator(close=close, window=14).rsi()
    rsi_val = round(float(rsi_series.iloc[-1]), 2) if not np.isnan(rsi_series.iloc[-1]) else 50.0

    # 2. SMAs (20, 50, 200)
    sma_20 = rp(float(SMAIndicator(close=close, window=20).sma_indicator().iloc[-1])) if len(df) >= 20 else None
    sma_50 = rp(float(SMAIndicator(close=close, window=50).sma_indicator().iloc[-1])) if len(df) >= 50 else None
    sma_200 = rp(float(SMAIndicator(close=close, window=200).sma_indicator().iloc[-1])) if len(df) >= 200 else None

    # 3. EMAs (9, 21) & Golden/Death Cross
    ema_9_series = EMAIndicator(close=close, window=9).ema_indicator()
    ema_21_series = EMAIndicator(close=close, window=21).ema_indicator()
    
    ema_9 = rp(float(ema_9_series.iloc[-1])) if len(df) >= 9 else None
    ema_21 = rp(float(ema_21_series.iloc[-1])) if len(df) >= 21 else None

    ema_crossover = "Neutral"
    if ema_9 and ema_21:
        if ema_9 > ema_21:
            ema_crossover = "Bullish Cross (EMA 9 > EMA 21)"
        else:
            ema_crossover = "Bearish Cross (EMA 9 < EMA 21)"

    # 4. MACD (12, 26, 9)
    macd_obj = MACD(close=close, window_slow=26, window_fast=12, window_sign=9)
    macd_line = _last(macd_obj.macd())
    macd_signal = _last(macd_obj.macd_signal())
    macd_diff = _last(macd_obj.macd_diff())

    macd_status = "Bullish" if macd_line > macd_signal else "Bearish"

    # 5. Bollinger Bands (20, 2)
    bb = BollingerBands(close=close, window=20, window_dev=2)
    last_close = rp(float(close.iloc[-1]))
    bb_upper = _last(bb.bollinger_hband(), default=last_close)
    bb_middle = _last(bb.bollinger_mavg(), default=last_close)
    bb_lower = _last(bb.bollinger_lband(), default=last_close)
    
    # Bollinger Squeeze Detector
    bb_bandwidth = round(((bb_upper - bb_lower) / bb_middle) * 100, 2) if bb_middle else 0.0
    bb_status = "Squeeze (Low Volatility)" if bb_bandwidth < 5.0 else ("Overbought Near Upper Band" if close.iloc[-1] >= bb_upper * 0.98 else ("Oversold Near Lower Band" if close.iloc[-1] <= bb_lower * 1.02 else "Normal Volatility"))

    # 6. Volume Trend & Spike Ratio
    vol_20_avg = float(volume.tail(20).mean()) if len(df) >= 20 else float(volume.mean())
    latest_vol = float(volume.iloc[-1])
    vol_ratio = round(latest_vol / vol_20_avg, 2) if vol_20_avg > 0 else 1.0
    is_vol_spike = vol_ratio >= 1.5

    # 6b. ATR (14) - real average true range
    atr_series = AverageTrueRange(high=high, low=low, close=close, window=14).average_true_range()
    atr_14 = rp(float(atr_series.iloc[-1])) if not np.isnan(atr_series.iloc[-1]) else None
    atr_pct = round(atr_14 / float(close.iloc[-1]) * 100, 2) if atr_14 and float(close.iloc[-1]) else None

    # 7. Support & Resistance
    levels = calculate_support_resistance(df)

    # 8. Composite Technical Score (0 to 100)
    current_price = rp(float(close.iloc[-1]))
    prev_price = rp(float(close.iloc[-2])) if len(df) > 1 else current_price
    price_change = rp(current_price - prev_price)
    price_change_pct = round((price_change / prev_price) * 100, 2) if prev_price != 0 else 0.0

    score = 50.0
    if rsi_val > 50: score += 10
    if rsi_val < 35: score += 10 # oversold reversal
    if rsi_val > 70: score -= 15 # overbought risk
    if sma_20 and current_price > sma_20: score += 10
    if sma_50 and current_price > sma_50: score += 10
    if macd_line > macd_signal: score += 10
    if is_vol_spike and price_change > 0: score += 10

    technical_score = min(max(round(score, 1), 5.0), 95.0)

    sentiment = "Bullish" if technical_score >= 65 else ("Bearish" if technical_score <= 40 else "Neutral / Consolidation")

    return {
        "current_price": current_price,
        "price_change": price_change,
        "price_change_pct": price_change_pct,
        "rsi_14": rsi_val,
        "sma_20": sma_20,
        "sma_50": sma_50,
        "sma_200": sma_200,
        "ema_9": ema_9,
        "ema_21": ema_21,
        "ema_crossover": ema_crossover,
        "macd_line": macd_line,
        "macd_signal": macd_signal,
        "macd_diff": macd_diff,
        "macd_status": macd_status,
        "bb_upper": bb_upper,
        "bb_middle": bb_middle,
        "bb_lower": bb_lower,
        "bb_status": bb_status,
        "vol_20_avg": int(vol_20_avg),
        "latest_vol": int(latest_vol),
        "atr_14": atr_14,
        "atr_pct": atr_pct,
        "vol_ratio": vol_ratio,
        "is_vol_spike": is_vol_spike,
        "support_levels": levels["support_levels"],
        "resistance_levels": levels["resistance_levels"],
        "technical_score": technical_score,
        "sentiment": sentiment
    }
