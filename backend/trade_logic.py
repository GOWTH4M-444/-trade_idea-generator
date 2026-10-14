"""
Pure, dependency-light trade logic shared by the API layer and the AI analyzer:

  - sanitize_for_json : make arbitrary results JSON-safe without destroying precision
  - validate_ideas    : reject malformed / inconsistent / hallucinated trade setups
  - build_fallback_ideas : rule-based setups used when Claude is unavailable

Nothing here touches the network or the database, so it is easy to unit test.
"""
import math
from datetime import date, datetime
from typing import Any, Dict, List, Optional

import numpy as np

VALID_INTERVALS = {"1m", "5m", "15m", "30m", "1h", "4h", "1d", "1wk"}
VALID_PERIODS = {"1mo", "3mo", "6mo", "1y", "2y", "5y"}
ALERT_CONDITIONS = {"PRICE_ABOVE", "PRICE_BELOW", "RSI_ABOVE", "RSI_BELOW"}

# A setup whose entry/target/stop is further than this from the current price is
# treated as hallucinated or broken and dropped.
MAX_LEVEL_DEVIATION = 0.35


def round_price(x: float) -> float:
    """
    Precision that fits the magnitude: 2 decimals >= 100, 4 decimals for 1-100 (FX pairs like
    EURUSD=1.0842), 6 below 1 (DOGE, SHIB). Rounding everything to 2 decimals destroys these.
    """
    a = abs(x)
    if a >= 100:
        return round(x, 2)
    if a >= 1:
        return round(x, 4)
    return round(x, 6)


def sanitize_for_json(obj: Any) -> Any:
    """Recursively convert NaN/Inf and numpy/pandas types into JSON-safe Python values."""
    if obj is None:
        return None
    if isinstance(obj, (bool, np.bool_)):  # must precede int: bool is a subclass of int
        return bool(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        if math.isnan(f) or math.isinf(f):
            return None
        return round_price(f)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [sanitize_for_json(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [sanitize_for_json(v) for v in obj.tolist()]
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    return str(obj)


def compute_rr(entry: float, target: float, stop: float) -> str:
    """Real reward:risk computed from the actual levels (direction agnostic)."""
    risk = abs(entry - stop)
    reward = abs(target - entry)
    if risk <= 0 or reward <= 0:
        return "n/a"
    return f"1:{round(reward / risk, 1)}"


def validate_ideas(ideas: Any, price: float, max_deviation: float = MAX_LEVEL_DEVIATION) -> List[Dict[str, Any]]:
    """
    Keep only internally consistent setups:
      long  -> stop < entry < target
      short -> target < entry < stop
    and with every level within `max_deviation` of the live price.
    The reward:risk string is recomputed from the levels (never trusted from the model).
    """
    if not isinstance(ideas, list) or not price or price <= 0 or not math.isfinite(price):
        return []

    clean_ideas: List[Dict[str, Any]] = []
    for idea in ideas:
        if not isinstance(idea, dict):
            continue
        try:
            entry = float(idea["entry_price"])
            target = float(idea["target_price"])
            stop = float(idea["stop_loss"])
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(v) and v > 0 for v in (entry, target, stop)):
            continue

        is_long = stop < entry < target
        is_short = target < entry < stop
        if not (is_long or is_short):
            continue
        if any(abs(v - price) / price > max_deviation for v in (entry, target, stop)):
            continue

        item = dict(idea)
        item["entry_price"] = round_price(entry)
        item["target_price"] = round_price(target)
        item["stop_loss"] = round_price(stop)
        item["risk_reward_ratio"] = compute_rr(entry, target, stop)
        item["direction"] = "LONG" if is_long else "SHORT"
        item["setup_type"] = str(idea.get("setup_type") or "Trade Setup")
        item["reasoning"] = str(idea.get("reasoning") or "")
        clean_ideas.append(item)
    return clean_ideas


def build_fallback_ideas(metadata: Dict[str, Any], ind: Dict[str, Any], interval: str) -> List[Dict[str, Any]]:
    """
    Rule-based setups from the computed indicators. Direction is derived from the data
    (e.g. mean reversion goes short when price is above its mean) and every idea is passed
    through validate_ideas, so an unusable setup is dropped rather than shown.
    """
    price = float(ind["current_price"])
    atr = ind.get("atr_14") or price * 0.02
    atr = float(atr) if atr and math.isfinite(float(atr)) and float(atr) > 0 else price * 0.02

    supports = ind.get("support_levels") or [round(price * 0.95, 2)]  # nearest first
    resistances = ind.get("resistance_levels") or [round(price * 1.05, 2)]  # nearest first
    s1 = float(supports[0])
    r1 = float(resistances[0])
    r2 = float(resistances[1]) if len(resistances) > 1 else r1 * 1.03

    tf = f"Timeframe: {interval.upper()}"
    rsi = ind.get("rsi_14")
    sma20 = ind.get("sma_20")
    bb_upper, bb_lower = ind.get("bb_upper"), ind.get("bb_lower")
    ideas: List[Dict[str, Any]] = []

    # 1) Support bounce (long)
    entry = min(price, max(s1 * 1.005, price * 0.99))
    stop = s1 - 0.5 * atr
    if stop >= entry:
        stop = entry - 1.5 * atr
    target = r1 if r1 > entry * 1.005 else entry + 2 * (entry - stop)
    ideas.append({
        "setup_type": "Support Bounce Swing Long", "timeframe": tf,
        "entry_price": entry, "target_price": target, "stop_loss": stop,
        "reasoning": f"Price {price:g} is near support {s1:g}. RSI(14) is {rsi} ({ind.get('sentiment')}); "
                     f"stop sits half an ATR below support, target is resistance {r1:g}.",
    })

    # 2) Mean reversion to the 20 SMA, direction depends on which side price is on
    if sma20 and price < sma20 * 0.995:
        stop = min(bb_lower if bb_lower and bb_lower < price else price - 1.5 * atr, price - 1.5 * atr)
        ideas.append({
            "setup_type": "Mean Reversion Long", "timeframe": tf,
            "entry_price": price, "target_price": sma20, "stop_loss": stop,
            "reasoning": f"Price {price:g} is below its 20 SMA ({sma20:g}); Bollinger status: {ind.get('bb_status')}. "
                         f"Reversion target is the mean at {sma20:g}.",
        })
    elif sma20 and price > sma20 * 1.005:
        stop = max(bb_upper if bb_upper and bb_upper > price else price + 1.5 * atr, price + 1.5 * atr)
        ideas.append({
            "setup_type": "Mean Reversion Short", "timeframe": tf,
            "entry_price": price, "target_price": sma20, "stop_loss": stop,
            "reasoning": f"Price {price:g} is extended above its 20 SMA ({sma20:g}); Bollinger status: {ind.get('bb_status')}. "
                         f"Reversion target is the mean at {sma20:g}.",
        })

    # 3) Resistance breakout (long)
    entry = r1 * 1.005
    stop = r1 - 0.5 * atr
    if stop >= entry:
        stop = entry - 1.5 * atr
    target = r2 if r2 > entry * 1.005 else entry + 2 * (entry - stop)
    ideas.append({
        "setup_type": "Resistance Breakout Momentum", "timeframe": tf,
        "entry_price": entry, "target_price": target, "stop_loss": stop,
        "reasoning": f"Breakout entry above resistance {r1:g} with volume ratio {ind.get('vol_ratio')}x; "
                     f"stop back under the level, target {target:g}.",
    })

    # 4) EMA trend continuation (direction follows the crossover)
    bullish = str(ind.get("ema_crossover", "")).startswith("Bullish")
    if bullish:
        ideas.append({
            "setup_type": "EMA Trend Continuation Long", "timeframe": tf,
            "entry_price": price, "target_price": price + 3 * atr, "stop_loss": price - 1.5 * atr,
            "reasoning": f"EMA status: {ind.get('ema_crossover')}. Technical score {ind.get('technical_score')}/100. "
                         f"Stop 1.5 ATR, target 3 ATR (ATR {atr:g}).",
        })
    elif str(ind.get("ema_crossover", "")).startswith("Bearish"):
        ideas.append({
            "setup_type": "EMA Trend Continuation Short", "timeframe": tf,
            "entry_price": price, "target_price": price - 3 * atr, "stop_loss": price + 1.5 * atr,
            "reasoning": f"EMA status: {ind.get('ema_crossover')}. Technical score {ind.get('technical_score')}/100. "
                         f"Stop 1.5 ATR, target 3 ATR (ATR {atr:g}).",
        })

    return validate_ideas(ideas, price)
