import hashlib
import hmac
import os
import re
import sqlite3
from typing import Any, Dict, List

from database import db

# --- Password hashing -------------------------------------------------------------------
# New hashes: salted PBKDF2-HMAC-SHA256. Legacy unsalted SHA-256 hashes (from earlier versions
# of this app) still verify and are transparently upgraded on the next successful login.
PBKDF2_PREFIX = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 200_000

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TICKER_RE = re.compile(r"^[\^A-Za-z0-9.=\-]{1,20}$")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"{PBKDF2_PREFIX}${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def _legacy_hash(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith(PBKDF2_PREFIX + "$"):
        try:
            _, iters, salt_hex, hash_hex = stored.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters))
        except (ValueError, TypeError):
            return False
        return hmac.compare_digest(dk.hex(), hash_hex)
    return hmac.compare_digest(_legacy_hash(password), stored)


def _needs_upgrade(stored: str) -> bool:
    return not stored.startswith(PBKDF2_PREFIX + "$")


# --- Users ------------------------------------------------------------------------------
def register_user(username: str, email: str, password: str) -> Dict[str, Any]:
    username, email = str(username).strip(), str(email).strip()
    if not USERNAME_RE.match(username):
        raise ValueError("Username must be 3-32 characters (letters, numbers, _ . -).")
    if not EMAIL_RE.match(email):
        raise ValueError("Please provide a valid email address.")
    if len(str(password)) < 8:
        raise ValueError("Password must be at least 8 characters.")

    try:
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
                (username, email, hash_password(str(password))),
            )
            user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise ValueError("Username or Email already registered.")
    return {"success": True, "user": {"id": user_id, "username": username, "email": email}}


def login_user(username: str, password: str) -> Dict[str, Any]:
    with db() as conn:
        row = conn.execute(
            "SELECT id, username, email, password_hash FROM users WHERE username = ?", (str(username),)
        ).fetchone()
        ok = bool(row) and verify_password(str(password), row["password_hash"])
        if not ok:
            if not row:
                # burn comparable time so unknown usernames are not distinguishable by latency
                verify_password(str(password), hash_password("x"))
            raise ValueError("Invalid username or password.")
        if _needs_upgrade(row["password_hash"]):
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(str(password)), row["id"]))

    return {"success": True, "user": {"id": row["id"], "username": row["username"], "email": row["email"]}}


# --- Watchlist --------------------------------------------------------------------------
def add_to_watchlist(user_id: int, ticker: str, market: str = "AUTO", asset_class: str = "STOCK") -> Dict[str, Any]:
    ticker = str(ticker).strip().upper()
    if not TICKER_RE.match(ticker):
        raise ValueError("Invalid ticker symbol.")
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO watchlists (user_id, ticker, market, asset_class) VALUES (?, ?, ?, ?)",
                (user_id, ticker, str(market), str(asset_class)),
            )
        return {"success": True, "message": f"{ticker} added to watchlist."}
    except sqlite3.IntegrityError:
        return {"success": True, "message": f"{ticker} already in watchlist."}


def get_user_watchlist(user_id: int) -> List[Dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, ticker, market, asset_class, created_at FROM watchlists WHERE user_id = ? ORDER BY id DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def remove_from_watchlist(user_id: int, ticker: str) -> Dict[str, Any]:
    ticker = str(ticker).strip().upper()
    with db() as conn:
        cur = conn.execute("DELETE FROM watchlists WHERE user_id = ? AND ticker = ?", (user_id, ticker))
    if cur.rowcount == 0:
        return {"success": True, "message": f"{ticker} was not in the watchlist."}
    return {"success": True, "message": f"{ticker} removed from watchlist."}


# --- Alerts -----------------------------------------------------------------------------
def create_alert(user_id: int, ticker: str, condition_type: str, target_value: float) -> Dict[str, Any]:
    ticker = str(ticker).strip().upper()
    if not TICKER_RE.match(ticker):
        raise ValueError("Invalid ticker symbol.")
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO alerts (user_id, ticker, condition_type, target_value) VALUES (?, ?, ?, ?)",
            (user_id, ticker, condition_type, target_value),
        )
        alert_id = cur.lastrowid
    return {"success": True, "alert_id": alert_id, "message": f"Alert created for {ticker} when {condition_type} {target_value}"}


def get_user_alerts(user_id: int) -> List[Dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC", (user_id,)).fetchall()
    return [dict(r) for r in rows]
