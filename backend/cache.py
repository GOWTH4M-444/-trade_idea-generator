import threading
import time
from typing import Any, Dict, Optional


class SimpleTTLCache:
    """
    In-memory TTL cache that eliminates redundant yfinance / Claude calls.

    Thread-safe (FastAPI runs sync endpoints in a thread pool) and bounded: expired
    entries are purged and, if still over `max_items`, the soonest-to-expire are evicted,
    so memory cannot grow without limit as users browse many symbols.
    """

    def __init__(self, default_ttl_seconds: int = 300, max_items: int = 500):
        self.cache: Dict[str, Dict[str, Any]] = {}
        self.default_ttl = default_ttl_seconds
        self.max_items = max_items
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self.cache.get(key)
            if entry is None:
                return None
            if time.time() < entry["expires_at"]:
                return entry["data"]
            del self.cache[key]
            return None

    def set(self, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
        ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
        with self._lock:
            self.cache[key] = {"data": value, "expires_at": time.time() + ttl}
            if len(self.cache) > self.max_items:
                self._evict()

    def _evict(self) -> None:
        now = time.time()
        for k in [k for k, e in self.cache.items() if e["expires_at"] <= now]:
            del self.cache[k]
        overflow = len(self.cache) - self.max_items
        if overflow > 0:
            for k, _ in sorted(self.cache.items(), key=lambda kv: kv[1]["expires_at"])[:overflow]:
                del self.cache[k]

    def clear(self) -> None:
        with self._lock:
            self.cache.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self.cache)


# Global cache instance (shared market data, quotes, news, order books)
market_cache = SimpleTTLCache(default_ttl_seconds=300, max_items=500)
