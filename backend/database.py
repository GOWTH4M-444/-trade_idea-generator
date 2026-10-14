import json
import logging
import os
import sqlite3
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

logger = logging.getLogger("trade_terminal.db")

DB_PATH = os.getenv("DATABASE_PATH") or os.path.join(os.path.dirname(__file__), "trade_ideas.db")

# Keep the history table bounded: every analysis would otherwise add a multi-KB row forever.
HISTORY_MAX_ROWS = 2000
HISTORY_DEDUPE_MINUTES = 5


def get_db_connection() -> sqlite3.Connection:
    """Open a connection (WAL + busy timeout so concurrent requests don't hit 'database is locked')."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.DatabaseError:
        pass
    return conn


@contextmanager
def db():
    """Connection that always commits-or-rolls-back and always closes (no leaks on errors)."""
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Initializes SQLite tables for users, watchlists, trade idea history, and alerts."""
    with db() as conn:
        _create_tables(conn.cursor())


def _create_tables(cursor) -> None:
    # 1. Users Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 2. Watchlists Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS watchlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        market TEXT DEFAULT 'AUTO',
        asset_class TEXT DEFAULT 'STOCK',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, ticker)
    );
    """)

    # 3. Trade Idea History Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        current_price REAL NOT NULL,
        rsi_14 REAL,
        technical_score REAL,
        ai_response_json TEXT NOT NULL,
        raw_payload_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 4. Alerts Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        condition_type TEXT NOT NULL, -- e.g. 'PRICE_ABOVE', 'PRICE_BELOW', 'RSI_BELOW', 'RSI_ABOVE'
        target_value REAL NOT NULL,
        is_triggered INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_history_ticker ON trade_history(ticker, id DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlists(user_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id)")


def save_trade_history(ticker: str, asset_class: str, timeframe: str, current_price: float, rsi_14: Optional[float], tech_score: float, ai_json: Dict[str, Any], raw_payload: Dict[str, Any]) -> bool:
    """
    Persist generated trade ideas and the indicator math behind them.
    Skips an identical (ticker, timeframe, price) snapshot saved in the last few minutes
    and prunes old rows. Returns True when a row was written.
    """
    with db() as conn:
        dup = conn.execute(
            "SELECT 1 FROM trade_history WHERE ticker = ? AND timeframe = ? AND current_price = ? "
            "AND created_at >= datetime('now', ?) LIMIT 1",
            (ticker, timeframe, current_price, f"-{HISTORY_DEDUPE_MINUTES} minutes"),
        ).fetchone()
        if dup:
            return False
        cur = conn.execute(
            """INSERT INTO trade_history (ticker, asset_class, timeframe, current_price, rsi_14, technical_score, ai_response_json, raw_payload_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (ticker, asset_class, timeframe, current_price, rsi_14, tech_score,
             json.dumps(ai_json, default=str), json.dumps(raw_payload, default=str)),
        )
        if cur.lastrowid and cur.lastrowid % 100 == 0:
            conn.execute(
                "DELETE FROM trade_history WHERE id NOT IN (SELECT id FROM trade_history ORDER BY id DESC LIMIT ?)",
                (HISTORY_MAX_ROWS,),
            )
        return True


def get_trade_history(ticker: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
    """Retrieve past trade calls, newest first."""
    limit = max(1, min(int(limit), 200))
    with db() as conn:
        if ticker:
            rows = conn.execute("SELECT * FROM trade_history WHERE ticker = ? ORDER BY id DESC LIMIT ?", (ticker, limit)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM trade_history ORDER BY id DESC LIMIT ?", (limit,)).fetchall()

    results = []
    for r in rows:
        try:
            ai = json.loads(r["ai_response_json"])
            raw = json.loads(r["raw_payload_json"])
        except (TypeError, ValueError):
            logger.warning("Skipping unreadable history row id=%s", r["id"])
            continue
        results.append({
            "id": r["id"],
            "ticker": r["ticker"],
            "asset_class": r["asset_class"],
            "timeframe": r["timeframe"],
            "current_price": r["current_price"],
            "rsi_14": r["rsi_14"],
            "technical_score": r["technical_score"],
            "ai_analysis": ai,
            "raw_payload": raw,
            "created_at": r["created_at"],
        })
    return results


# Run DB initialization on import
init_db()
