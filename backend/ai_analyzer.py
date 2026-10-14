import copy
import json
import logging
import os
import re
from typing import Any, Dict

import anthropic
from dotenv import load_dotenv

from cache import SimpleTTLCache
from trade_logic import validate_ideas

load_dotenv()

logger = logging.getLogger("trade_terminal.ai")

# Override with ANTHROPIC_MODEL in backend/.env if your account uses a different model.
DEFAULT_MODEL = "claude-sonnet-4-6"
AI_TTL_SECONDS = 300

# Identical inputs (same symbol/timeframe/price/indicators) would produce an equivalent answer,
# so don't pay for the same Claude call again within the market-data cache window.
_ai_cache = SimpleTTLCache(default_ttl_seconds=AI_TTL_SECONDS, max_items=200)

SYSTEM_PROMPT = """You are a Master Quantitative Financial Analyst and Institutional Trader specializing in multi-asset analysis (Global Stocks, Equity Indices, Crypto, Forex, ETFs, Commodities).

Your goal is to analyze computed technical indicators (RSI, MACD, Bollinger Bands, Moving Averages, Support/Resistance, Volume trends) and produce institutional-grade, data-driven trade setups.

CRITICAL CONSTRAINTS:
1. ONLY reason over the exact numbers provided in the user prompt. Never invent fictitious price levels.
2. Every entry_price, target_price and stop_loss must be within 25% of the current price.
3. A long setup must satisfy stop_loss < entry_price < target_price. A short setup must satisfy target_price < entry_price < stop_loss.
4. Match the setup horizon to the chart timeframe given in the prompt (e.g. a 5m chart implies intraday setups).
5. Output strictly valid raw JSON ONLY matching the schema below. No markdown fences (```json), no intro text.

JSON Schema:
{
  "ticker": "string",
  "asset_class": "string (Stock, Index, Crypto, Forex, Commodity, ETF)",
  "overall_sentiment": "string (Strong Bullish, Bullish, Neutral, Bearish, Strong Bearish)",
  "trade_ideas": [
    {
      "setup_type": "string (e.g., Support Bounce Swing, MACD Crossover Breakout, Mean Reversion Scalp, Golden Cross Momentum)",
      "timeframe": "string (e.g., Intraday 1-3 Days, Swing 1-3 Weeks, Position 1-3 Months)",
      "entry_price": number,
      "target_price": number,
      "stop_loss": number,
      "risk_reward_ratio": "string (e.g., '1:2.5')",
      "reasoning": "string (Must explicitly reference the provided RSI, MACD, Bollinger Bands, or Support/Resistance levels)"
    }
  ]
}
Generate between 3 to 5 actionable trade setups.
"""


def clean_json_response(raw_text: str) -> str:
    text = raw_text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json_object(raw_text: str) -> Dict[str, Any]:
    """Parse the model output; tolerate stray prose around a single JSON object."""
    cleaned = clean_json_response(raw_text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start != -1 and end > start:
            return json.loads(cleaned[start:end + 1])
        raise


def _cache_key(p: Dict[str, Any]) -> str:
    return "|".join(str(p.get(k)) for k in ("symbol", "interval", "current_price", "rsi_14", "macd_line", "technical_score"))


def generate_trade_ideas(analysis_payload: Dict[str, Any], retry_count: int = 1) -> Dict[str, Any]:
    api_key = os.getenv("ANTHROPIC_API_KEY")

    if not api_key or api_key == "your_anthropic_api_key_here":
        raise ValueError("ANTHROPIC_API_KEY is not set in backend/.env.")

    key = _cache_key(analysis_payload)
    cached = _ai_cache.get(key)
    if cached is not None:
        return copy.deepcopy(cached)

    # The SDK already retries transient network/5xx errors once; keep the total wait bounded.
    client = anthropic.Anthropic(api_key=api_key, timeout=45.0, max_retries=1)

    prompt = f"""Perform multi-indicator quantitative trade synthesis for {analysis_payload.get('symbol', 'UNKNOWN')}:

ASSET METADATA:
- Ticker: {analysis_payload.get('symbol')} ({analysis_payload.get('company_name')})
- Asset Category: {analysis_payload.get('asset_class', 'STOCK')}
- Chart Timeframe: {analysis_payload.get('interval', '1d')}
- Current Price: {analysis_payload.get('current_price')} {analysis_payload.get('currency')}
- Day Change: {analysis_payload.get('price_change')} ({analysis_payload.get('price_change_pct')}%)
- 52-Week Range: {analysis_payload.get('fifty_two_week_low')} - {analysis_payload.get('fifty_two_week_high')}

TECHNICAL INDICATOR SUITE:
- RSI (14): {analysis_payload.get('rsi_14')}
- Moving Averages: SMA20={analysis_payload.get('sma_20')}, SMA50={analysis_payload.get('sma_50')}, SMA200={analysis_payload.get('sma_200')}
- EMA Crossover: {analysis_payload.get('ema_crossover')} (EMA9={analysis_payload.get('ema_9')}, EMA21={analysis_payload.get('ema_21')})
- MACD: Line={analysis_payload.get('macd_line')}, Signal={analysis_payload.get('macd_signal')}, Diff={analysis_payload.get('macd_diff')} ({analysis_payload.get('macd_status')})
- Bollinger Bands: Upper={analysis_payload.get('bb_upper')}, Middle={analysis_payload.get('bb_middle')}, Lower={analysis_payload.get('bb_lower')} Status: {analysis_payload.get('bb_status')}
- ATR (14): {analysis_payload.get('atr_14')} ({analysis_payload.get('atr_pct')}% of price)
- Volume: Latest={analysis_payload.get('latest_vol')}, 20D Avg={analysis_payload.get('vol_20_avg')}, Ratio={analysis_payload.get('vol_ratio')}x (Spike: {analysis_payload.get('is_vol_spike')})
- Key Support Levels (nearest first): {analysis_payload.get('support_levels')}
- Key Resistance Levels (nearest first): {analysis_payload.get('resistance_levels')}
- Composite Tech Score: {analysis_payload.get('technical_score')}/100 ({analysis_payload.get('sentiment')})

Generate 3-5 high probability trade setups matching strict JSON schema.
"""

    model_name = os.getenv("ANTHROPIC_MODEL", DEFAULT_MODEL)
    price = analysis_payload.get("current_price")

    last_error: Exception = RuntimeError("Unexpected error during trade idea generation.")
    for attempt in range(retry_count + 1):
        try:
            response = client.messages.create(
                model=model_name,
                max_tokens=3000,  # 5 setups with reasoning can exceed 2000 tokens and truncate the JSON
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.APIError as e:
            # Auth / billing / model-not-found / rate-limit problems won't be fixed by an immediate retry.
            raise RuntimeError(f"Claude AI API Error: {e}") from e

        try:
            raw_content = response.content[0].text if response.content else ""
            parsed = _parse_json_object(raw_content)
            ideas = validate_ideas(parsed.get("trade_ideas"), float(price))
            if not ideas:
                raise ValueError("Claude returned no valid trade setups (inconsistent or out-of-range levels).")
        except (ValueError, TypeError, AttributeError, IndexError) as e:  # JSONDecodeError is a ValueError
            logger.warning("AI response rejected on attempt %d: %s", attempt + 1, e)
            last_error = RuntimeError(f"Claude AI response invalid: {e}")
            continue

        parsed["trade_ideas"] = ideas
        parsed["source"] = "claude"
        _ai_cache.set(key, parsed)
        return copy.deepcopy(parsed)

    raise last_error
