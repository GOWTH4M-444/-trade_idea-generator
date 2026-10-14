"""
Backend unit tests. No network and no real API key are needed.

Run from the backend/ folder:
    pip install -r requirements-dev.txt
    pytest -q            # or:  python tests/test_backend.py
"""
import json
import math
import os
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

# Use a throw-away database; must be set before `database` is imported.
_TMP = tempfile.mkdtemp(prefix="trade_tests_")
os.environ["DATABASE_PATH"] = os.path.join(_TMP, "test.db")
os.environ["ANTHROPIC_API_KEY"] = "test-key"

import ai_analyzer  # noqa: E402
import auth  # noqa: E402
import backtester  # noqa: E402
import data_fetcher  # noqa: E402
import database  # noqa: E402
import indicators  # noqa: E402
from cache import SimpleTTLCache, market_cache  # noqa: E402
from trade_logic import build_fallback_ideas, compute_rr, sanitize_for_json, validate_ideas  # noqa: E402


# ----------------------------------------------------------------------------- helpers
def make_df(n=120, start=100.0, seed=1, freq="D", drift=0.0005, vol=0.015):
    rng = np.random.default_rng(seed)
    close = start * np.cumprod(1 + rng.normal(drift, vol, n))
    open_ = np.concatenate([[start], close[:-1]])
    high = np.maximum(open_, close) * (1 + rng.uniform(0, 0.01, n))
    low = np.minimum(open_, close) * (1 - rng.uniform(0, 0.01, n))
    idx = pd.date_range("2025-01-01", periods=n, freq=freq)
    return pd.DataFrame({"Open": open_, "High": high, "Low": low, "Close": close, "Volume": rng.integers(1_000, 5_000, n)}, index=idx)


def fake_claude(text_or_exc, counter):
    class Msgs:
        def create(self, **kwargs):
            counter.append(kwargs)
            if isinstance(text_or_exc, Exception):
                raise text_or_exc
            return SimpleNamespace(content=[SimpleNamespace(text=text_or_exc)])

    class Client:
        def __init__(self, **kwargs):
            self.messages = Msgs()

    return Client


PAYLOAD = {"symbol": "TEST", "interval": "1d", "current_price": 100.0, "rsi_14": 50, "macd_line": 0.1, "technical_score": 60}


# ----------------------------------------------------------------------------- trade_logic
def test_sanitize_keeps_sub_dollar_precision():
    out = sanitize_for_json({"price": 0.08341234, "big": 123.456789, "tiny": 0.00001234})
    assert out["price"] == 0.083412  # was rounded to 0.08 before
    assert out["big"] == 123.46
    assert out["tiny"] == 1.2e-05


def test_sanitize_handles_nan_numpy_and_containers():
    out = sanitize_for_json({
        "nan": float("nan"), "inf": float("inf"), "np_int": np.int64(7), "np_f": np.float64(1.5),
        "np_bool": np.bool_(True), "tup": (1, 2.0), "arr": np.array([1.0, np.nan]), "ts": pd.Timestamp("2026-01-02").to_pydatetime(),
    })
    assert out["nan"] is None and out["inf"] is None
    assert out["np_int"] == 7 and out["np_f"] == 1.5 and out["np_bool"] is True
    assert out["tup"] == [1, 2.0] and out["arr"] == [1.0, None]
    assert out["ts"].startswith("2026-01-02")
    json.dumps(out)  # must be serializable


def test_compute_rr():
    assert compute_rr(100, 110, 95) == "1:2.0"
    assert compute_rr(100, 90, 105) == "1:2.0"  # short
    assert compute_rr(100, 100, 95) == "n/a"


def test_validate_ideas_filters_bad_setups_and_recomputes_rr():
    ideas = [
        {"setup_type": "ok long", "entry_price": "100", "target_price": 110, "stop_loss": 95, "risk_reward_ratio": "1:99"},
        {"setup_type": "ok short", "entry_price": 100, "target_price": 90, "stop_loss": 104},
        {"setup_type": "inverted long", "entry_price": 100, "target_price": 90, "stop_loss": 110 - 1000},   # stop negative
        {"setup_type": "stop above entry but target above", "entry_price": 100, "target_price": 110, "stop_loss": 105},
        {"setup_type": "hallucinated", "entry_price": 100, "target_price": 400, "stop_loss": 95},
        {"setup_type": "missing"}, "not a dict", {"entry_price": "abc", "target_price": 1, "stop_loss": 1},
    ]
    out = validate_ideas(ideas, 100.0)
    assert [i["setup_type"] for i in out] == ["ok long", "ok short"]
    assert out[0]["risk_reward_ratio"] == "1:2.0"  # model's "1:99" is not trusted
    assert out[0]["direction"] == "LONG" and out[1]["direction"] == "SHORT"
    assert validate_ideas("garbage", 100) == [] and validate_ideas(ideas, 0) == []


def _ind(**over):
    base = dict(current_price=100.0, atr_14=2.0, support_levels=[98.0, 95.0], resistance_levels=[104.0, 110.0],
                sma_20=100.0, bb_upper=106.0, bb_lower=94.0, bb_status="Normal", rsi_14=50, sentiment="Neutral",
                vol_ratio=1.2, ema_crossover="Bullish Cross (EMA 9 > EMA 21)", technical_score=60)
    base.update(over)
    return base


def test_fallback_ideas_are_always_consistent():
    for over in [{}, {"sma_20": 90.0}, {"sma_20": 112.0, "ema_crossover": "Bearish Cross (EMA 9 < EMA 21)"},
                 {"support_levels": [99.9], "resistance_levels": [100.2]}, {"atr_14": None}, {"resistance_levels": [150.0]}]:
        ideas = build_fallback_ideas({}, _ind(**over), "1d")
        assert ideas, over
        for i in ideas:
            e, t, s = i["entry_price"], i["target_price"], i["stop_loss"]
            assert (s < e < t) or (t < e < s), (over, i)


def test_fallback_mean_reversion_direction_follows_price_vs_mean():
    above = {i["setup_type"] for i in build_fallback_ideas({}, _ind(sma_20=95.0), "1d")}
    below = {i["setup_type"] for i in build_fallback_ideas({}, _ind(sma_20=105.0), "1d")}
    assert "Mean Reversion Short" in above and "Mean Reversion Long" not in above
    assert "Mean Reversion Long" in below and "Mean Reversion Short" not in below


# ----------------------------------------------------------------------------- cache
def test_cache_expiry_and_bound():
    c = SimpleTTLCache(default_ttl_seconds=60, max_items=5)
    c.set("a", 1, ttl_seconds=0)
    time.sleep(0.01)
    assert c.get("a") is None
    for i in range(20):
        c.set(f"k{i}", i)
    assert len(c) <= 5


def test_cache_thread_safety():
    c = SimpleTTLCache(max_items=50)
    errors = []

    def work(n):
        try:
            for i in range(500):
                c.set(f"{n}-{i % 80}", i)
                c.get(f"{n}-{(i + 1) % 80}")
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors and len(c) <= 50


# ----------------------------------------------------------------------------- auth + database
def test_password_hash_is_salted_and_verifies():
    h1, h2 = auth.hash_password("correct horse"), auth.hash_password("correct horse")
    assert h1 != h2 and h1.startswith("pbkdf2_sha256$")
    assert auth.verify_password("correct horse", h1) and not auth.verify_password("wrong", h1)
    assert not auth.verify_password("x", "pbkdf2_sha256$garbage")


def test_register_login_and_legacy_hash_upgrade():
    auth.register_user("alice", "alice@example.com", "password123")
    assert auth.login_user("alice", "password123")["user"]["username"] == "alice"
    for bad in [("alice", "nope"), ("ghost", "password123")]:
        try:
            auth.login_user(*bad)
            raise AssertionError("login should fail")
        except ValueError:
            pass

    # legacy unsalted sha256 account (created by the old version) still logs in and is upgraded
    with database.db() as conn:
        conn.execute("INSERT INTO users (username, email, password_hash) VALUES (?,?,?)",
                     ("bob", "bob@example.com", auth._legacy_hash("oldpassword")))
    assert auth.login_user("bob", "oldpassword")["success"]
    with database.db() as conn:
        stored = conn.execute("SELECT password_hash FROM users WHERE username='bob'").fetchone()[0]
    assert stored.startswith("pbkdf2_sha256$")
    assert auth.login_user("bob", "oldpassword")["success"]


def test_register_validation_and_duplicates():
    for args in [("ab", "a@b.co", "password123"), ("valid_user", "not-an-email", "password123"), ("valid_user", "a@b.co", "short")]:
        try:
            auth.register_user(*args)
            raise AssertionError(args)
        except ValueError:
            pass
    auth.register_user("carol", "carol@example.com", "password123")
    try:
        auth.register_user("carol", "other@example.com", "password123")
        raise AssertionError("duplicate username accepted")
    except ValueError as e:
        assert "already registered" in str(e)


def test_watchlist_add_dedupe_remove_and_validation():
    assert "added" in auth.add_to_watchlist(7, "nvda")["message"]
    assert "already" in auth.add_to_watchlist(7, "NVDA")["message"]
    assert [w["ticker"] for w in auth.get_user_watchlist(7)] == ["NVDA"]
    try:
        auth.add_to_watchlist(7, "bad ticker; DROP TABLE")
        raise AssertionError("invalid ticker accepted")
    except ValueError:
        pass
    assert "removed" in auth.remove_from_watchlist(7, "nvda")["message"]
    assert "not in" in auth.remove_from_watchlist(7, "nvda")["message"]


def test_history_saved_deduped_and_readable():
    ok = database.save_trade_history("ZZZ", "STOCK", "1d", 10.5, 55.0, 60.0, {"a": 1}, {"b": float("nan")})
    dup = database.save_trade_history("ZZZ", "STOCK", "1d", 10.5, 55.0, 60.0, {"a": 1}, {"b": 2})
    other = database.save_trade_history("ZZZ", "STOCK", "1h", 10.5, 55.0, 60.0, {"a": 1}, {"b": 2})
    assert ok and not dup and other
    rows = database.get_trade_history("ZZZ", limit=10)
    assert len(rows) == 2 and rows[0]["timeframe"] == "1h"
    assert len(database.get_trade_history(limit=100000)) <= 200


def test_db_connections_closed_on_error():
    try:
        with database.db() as conn:
            conn.execute("INSERT INTO nope VALUES (1)")
    except Exception:
        pass
    with database.db() as conn:  # database must still be usable (not locked)
        conn.execute("SELECT 1")


# ----------------------------------------------------------------------------- indicators
def test_indicators_shape_levels_and_no_nan():
    df = make_df(150)
    out = indicators.calculate_indicators(df)
    price = out["current_price"]
    assert all(s <= price for s in out["support_levels"]) and all(r >= price for r in out["resistance_levels"])
    assert out["support_levels"] == sorted(out["support_levels"], reverse=True)  # nearest first
    assert out["resistance_levels"] == sorted(out["resistance_levels"])
    for k, v in out.items():
        if isinstance(v, float):
            assert not math.isnan(v), k


def test_indicators_require_enough_bars():
    try:
        indicators.calculate_indicators(make_df(20))
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "Insufficient" in str(e)


def test_sub_dollar_and_fx_prices_keep_precision_end_to_end():
    out = indicators.calculate_indicators(make_df(150, start=0.0834, vol=0.02))
    assert 0 < out["current_price"] < 1 and out["current_price"] != round(out["current_price"], 2)
    assert out["sma_20"] and out["sma_20"] != round(out["sma_20"], 2)
    assert out["support_levels"][0] != round(out["support_levels"][0], 2)
    assert sanitize_for_json({"eurusd": 1.08423456})["eurusd"] == 1.0842  # FX pairs need 4 decimals


# ----------------------------------------------------------------------------- backtester
def _bt(df, **kw):
    return backtester.run_backtest(df, **kw)


def test_backtest_metrics_are_honest():
    found = False
    for seed in range(1, 40):
        res = _bt(make_df(250, seed=seed, drift=0.0, vol=0.02))
        if res["total_trades"] >= 3:
            found = True
            wins, losses = res["winning_trades"], res["losing_trades"]
            gain = sum(t["pnl"] for t in res["trades_log"] if t["result"] == "WIN")
            if losses == 0:
                assert res["profit_factor"] is None  # used to be returned as a currency amount
                assert res["avg_rr_ratio"] is None
            else:
                assert isinstance(res["profit_factor"], float)
            assert res["designed_rr_ratio"] == "1:2.25"
            assert res["equity_curve"][-1]["capital"] == res["final_capital"]  # final point never dropped
            break
    assert found, "no seed produced trades"


def test_backtest_does_not_use_hidden_leverage_on_expensive_assets():
    for seed in range(1, 60):
        df = make_df(250, start=60_000, seed=seed, drift=0.0, vol=0.02)
        res = _bt(df, initial_capital=10_000, risk_per_trade_pct=2.0)
        losses = [t for t in res["trades_log"] if t["result"] == "LOSS"]
        if losses:
            # 2% risk on 10k is ~$200. The old code forced >=1 whole unit (~$1,200 stop distance).
            assert all(abs(t["pnl"]) < 400 for t in losses), losses
            return
    raise AssertionError("no losing trade found to check")


def test_backtest_keeps_sub_dollar_prices():
    for seed in range(1, 60):
        res = _bt(make_df(250, start=0.0834, seed=seed, drift=0.0, vol=0.03))
        if res["trades_log"]:
            t = res["trades_log"][0]
            assert t["entry"] > 0 and t["exit"] > 0 and t["entry"] != t["exit"]
            return
    raise AssertionError("no trades")


# ----------------------------------------------------------------------------- data_fetcher
def test_ticker_resolution_and_currency_rules():
    assert data_fetcher.resolve_universal_ticker("avax-usd")[1] == "CRYPTO"
    assert data_fetcher.resolve_universal_ticker("hul")[0] == "HINDUNILVR.NS"
    assert data_fetcher.resolve_universal_ticker("nifty")[0] == "^NSEI"


def test_search_dedupes_by_symbol_and_ranks_exact_first():
    res = data_fetcher.search_symbols_quick("reliance")
    syms = [r["symbol"] for r in res]
    assert len(syms) == len(set(syms)) and syms[0] == "RELIANCE.NS"
    assert data_fetcher.search_symbols_quick("   ") == []


def _hourly(n_days=6):
    idx = pd.date_range("2026-01-05 09:00", periods=n_days * 24, freq="h", tz="America/New_York")
    base = np.linspace(100, 110, len(idx))
    return pd.DataFrame({"Open": base, "High": base + 1, "Low": base - 1, "Close": base + 0.5, "Volume": 100}, index=idx)


def test_fetch_validates_input_resamples_4h_and_returns_copies():
    market_cache.clear()
    hourly = _hourly()
    hourly = pd.concat([hourly, hourly.iloc[[-1]]])  # duplicate live bar

    class FakeYF:
        calls = 0

        @staticmethod
        def download(*a, **k):
            FakeYF.calls += 1
            return hourly.copy()

        class Ticker:
            def __init__(self, *a): pass
            @property
            def info(self): raise RuntimeError("no network")

    with patch.object(data_fetcher, "yf", FakeYF):
        for bad in [dict(interval="3m"), dict(period="10y")]:
            try:
                data_fetcher.fetch_stock_data("AAPL", **bad)
                raise AssertionError(bad)
            except ValueError:
                pass
        df1h, _ = data_fetcher.fetch_stock_data("AAPL", interval="1h")
        df4h, meta = data_fetcher.fetch_stock_data("AAPL", interval="4h")
        assert not df1h.index.duplicated().any()
        assert len(df4h) < len(df1h) / 3 and df4h["High"].iloc[0] >= df1h["High"].iloc[0]
        assert meta["interval"] == "4h"

        calls = FakeYF.calls
        a, ma = data_fetcher.fetch_stock_data("AAPL", interval="4h")
        a.iloc[0, 0] = -999  # mutate our copy...
        ma["symbol"] = "HACKED"
        b, mb = data_fetcher.fetch_stock_data("AAPL", interval="4h")
        assert FakeYF.calls == calls            # served from cache
        assert b.iloc[0, 0] != -999 and mb["symbol"] == "AAPL"  # ...cache is unaffected


def test_indian_index_currency_is_inr_even_without_provider_info():
    market_cache.clear()
    df = make_df(60)

    class FakeYF:
        @staticmethod
        def download(*a, **k): return df.copy()
        class Ticker:
            def __init__(self, *a): pass
            @property
            def info(self): raise RuntimeError("no network")

    with patch.object(data_fetcher, "yf", FakeYF):
        _, meta = data_fetcher.fetch_stock_data("NIFTY")
    assert meta["symbol"] == "^NSEI" and meta["currency"] == "INR"


# ----------------------------------------------------------------------------- ai_analyzer
GOOD = json.dumps({"ticker": "TEST", "trade_ideas": [
    {"setup_type": "A", "entry_price": 100, "target_price": 110, "stop_loss": 95, "risk_reward_ratio": "1:9", "reasoning": "r"},
    {"setup_type": "bad", "entry_price": 100, "target_price": 90, "stop_loss": 95}]})


def test_ai_validates_caches_and_tolerates_wrapping():
    ai_analyzer._ai_cache.clear()
    calls = []
    wrapped = "Here you go:\n```json\n" + GOOD + "\n```\nHope this helps"
    with patch.object(ai_analyzer.anthropic, "Anthropic", fake_claude(wrapped, calls)):
        out = ai_analyzer.generate_trade_ideas(dict(PAYLOAD))
        again = ai_analyzer.generate_trade_ideas(dict(PAYLOAD))
    assert [i["setup_type"] for i in out["trade_ideas"]] == ["A"]      # inconsistent idea dropped
    assert out["trade_ideas"][0]["risk_reward_ratio"] == "1:2.0"       # recomputed, not "1:9"
    assert out["source"] == "claude" and again == out
    assert len(calls) == 1                                             # second call served from cache (no extra billing)
    assert calls[0]["max_tokens"] >= 3000 and "Chart Timeframe" in calls[0]["messages"][0]["content"]


def test_ai_retries_invalid_output_but_not_api_errors():
    ai_analyzer._ai_cache.clear()
    calls = []
    with patch.object(ai_analyzer.anthropic, "Anthropic", fake_claude("not json at all", calls)):
        try:
            ai_analyzer.generate_trade_ideas(dict(PAYLOAD))
            raise AssertionError("expected failure")
        except RuntimeError as e:
            assert "invalid" in str(e)
    assert len(calls) == 2  # original + 1 retry

    calls.clear()
    err = ai_analyzer.anthropic.APIError("credit balance is too low")
    with patch.object(ai_analyzer.anthropic, "Anthropic", fake_claude(err, calls)):
        try:
            ai_analyzer.generate_trade_ideas(dict(PAYLOAD))
            raise AssertionError("expected failure")
        except RuntimeError as e:
            assert "credit balance" in str(e)
    assert len(calls) == 1  # billing/auth errors are not retried


def test_ai_missing_key_raises():
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "your_anthropic_api_key_here"}):
        try:
            ai_analyzer.generate_trade_ideas(dict(PAYLOAD))
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "not set" in str(e)


# ----------------------------------------------------------------------------- plain runner
if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
