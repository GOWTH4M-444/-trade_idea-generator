import pandas as pd
import numpy as np
from typing import Dict, Any, List
from ta.momentum import RSIIndicator
from ta.trend import SMAIndicator

STOP_PCT = 0.02      # stop-loss distance below entry
TARGET_PCT = 0.045   # take-profit distance above entry


def _px(x: float) -> float:
    """Keep sub-1 prices (crypto, FX) from collapsing to 0.00 when rounded."""
    return round(x, 2) if abs(x) >= 1 else round(x, 6)


def run_backtest(df: pd.DataFrame, initial_capital: float = 10000.0, risk_per_trade_pct: float = 2.0) -> Dict[str, Any]:
    """
    Replays quantitative swing setup logic over historical market data.
    
    Strategy:
    - Long Entry: Triggered when RSI(14) < 40 and Price <= 20-Day SMA or near calculated support.
    - Target: Price hits +4.5% above entry.
    - Stop Loss: Price drops -2% below entry (checked before the target on the same bar: conservative).
    
    Returns:
        Dict[str, Any] containing Win Rate %, Total Trades, Profit Factor, Max Drawdown %, and Equity Curve.
    """
    if df.empty or len(df) < 50:
        raise ValueError("Insufficient historical data for backtesting (minimum 50 bars required).")

    close = df["Close"].values
    high = df["High"].values
    low = df["Low"].values
    dates = [d.strftime("%Y-%m-%d") for d in df.index]

    rsi_series = RSIIndicator(close=df["Close"], window=14).rsi().values
    sma20_series = SMAIndicator(close=df["Close"], window=20).sma_indicator().values

    account_balance = initial_capital
    equity_curve = [{"date": dates[0], "capital": round(initial_capital, 2)}]
    
    trades = []
    in_trade = False
    entry_price = 0.0
    stop_loss = 0.0
    target_price = 0.0
    entry_date = ""
    trade_units = 0

    n = len(df)
    for i in range(25, n):
        curr_price = close[i]
        curr_rsi = rsi_series[i]
        curr_sma20 = sma20_series[i]
        curr_date = dates[i]

        # Process open trade exit condition first
        if in_trade:
            # Check Stop Loss hit
            if low[i] <= stop_loss:
                pnl = (stop_loss - entry_price) * trade_units
                account_balance += pnl
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": curr_date,
                    "type": "LONG",
                    "entry": _px(entry_price),
                    "exit": _px(stop_loss),
                    "pnl": round(pnl, 2),
                    "pnl_pct": round(((stop_loss - entry_price) / entry_price) * 100, 2),
                    "result": "LOSS"
                })
                in_trade = False

            # Check Target Hit
            elif high[i] >= target_price:
                pnl = (target_price - entry_price) * trade_units
                account_balance += pnl
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": curr_date,
                    "type": "LONG",
                    "entry": _px(entry_price),
                    "exit": _px(target_price),
                    "pnl": round(pnl, 2),
                    "pnl_pct": round(((target_price - entry_price) / entry_price) * 100, 2),
                    "result": "WIN"
                })
                in_trade = False

        # Evaluate long setup entry condition
        if not in_trade and not np.isnan(curr_rsi) and not np.isnan(curr_sma20):
            if curr_rsi <= 42 and curr_price <= curr_sma20 * 1.01:
                entry_price = float(curr_price)
                stop_loss = entry_price * (1 - STOP_PCT)
                target_price = entry_price * (1 + TARGET_PCT)

                risk_per_unit = entry_price - stop_loss
                max_risk_amount = (account_balance * risk_per_trade_pct) / 100.0
                # Size by risk, but never hold more than the account can pay for (no hidden leverage).
                # Fractional units are allowed so expensive assets (BTC, index funds) can still be traded.
                trade_units = min(max_risk_amount / risk_per_unit, account_balance / entry_price)

                if trade_units > 0 and account_balance > 0:
                    entry_date = curr_date
                    in_trade = True

        equity_curve.append({
            "date": curr_date,
            "capital": round(account_balance, 2)
        })

    # Performance Metrics
    total_trades = len(trades)
    winning_trades = [t for t in trades if t["result"] == "WIN"]
    losing_trades = [t for t in trades if t["result"] == "LOSS"]

    win_rate_pct = round((len(winning_trades) / total_trades) * 100, 2) if total_trades > 0 else 0.0
    total_gain_pnl = sum([t["pnl"] for t in winning_trades])
    total_loss_pnl = abs(sum([t["pnl"] for t in losing_trades]))
    # Profit factor = gross profit / gross loss. With no losing trades it is undefined (None), not a currency amount.
    if total_loss_pnl > 0:
        profit_factor = round(total_gain_pnl / total_loss_pnl, 2)
    else:
        profit_factor = None

    # Realized average reward:risk = average win / average loss (None until both exist)
    if winning_trades and losing_trades and total_loss_pnl > 0:
        avg_win = total_gain_pnl / len(winning_trades)
        avg_loss = total_loss_pnl / len(losing_trades)
        avg_rr_ratio = f"1:{round(avg_win / avg_loss, 2)}"
    else:
        avg_rr_ratio = None

    net_roi_pct = round(((account_balance - initial_capital) / initial_capital) * 100, 2)

    # Max Drawdown Calculation
    capitals = [e["capital"] for e in equity_curve]
    peak = capitals[0]
    max_drawdown = 0.0
    for cap in capitals:
        if cap > peak:
            peak = cap
        dd = (peak - cap) / peak
        if dd > max_drawdown:
            max_drawdown = dd

    max_drawdown_pct = round(max_drawdown * 100, 2)

    return {
        "initial_capital": initial_capital,
        "final_capital": round(account_balance, 2),
        "net_roi_pct": net_roi_pct,
        "total_trades": total_trades,
        "winning_trades": len(winning_trades),
        "losing_trades": len(losing_trades),
        "win_rate_pct": win_rate_pct,
        "profit_factor": profit_factor,
        "max_drawdown_pct": max_drawdown_pct,
        "avg_rr_ratio": avg_rr_ratio,
        "designed_rr_ratio": f"1:{round(TARGET_PCT / STOP_PCT, 2)}",
        "trades_log": trades[-15:], # Last 15 trades
        "equity_curve": _sample_curve(equity_curve, 50)
    }


def _sample_curve(curve: List[Dict[str, Any]], max_points: int) -> List[Dict[str, Any]]:
    """Down-sample for charting but always keep the first and last point (the final capital)."""
    if len(curve) <= max_points:
        return curve
    step = max(1, len(curve) // max_points)
    sampled = curve[::step]
    if sampled[-1] is not curve[-1]:
        sampled.append(curve[-1])
    return sampled
