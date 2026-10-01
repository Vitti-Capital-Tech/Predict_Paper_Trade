"""ATR over BTC candles, with caching so the poll loop stays cheap."""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from .delta import DeltaClient

log = logging.getLogger(__name__)

_RESOLUTION_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
}


def closed_bars(candles: List[Dict[str, Any]], step: int,
                now: float) -> List[Dict[str, Any]]:
    """Drop the bar that is still forming.

    The venue returns the current bar alongside the finished ones, and its
    high, low and close move on every tick until it closes. Measured live: on
    15m/p10 it read 133.63 against 142.70 from closed bars alone - nine points,
    right on top of the gates these accounts run at.

    It is not noise, either. A bar a few minutes old has barely any range yet,
    so it pulls ATR down early in every bar and lets it recover as the bar
    fills. The gate then opens and shuts on how far through the bar the clock
    is, not on how much the market is moving. Volatility is a property of
    finished bars; this keeps only those.
    """
    return [c for c in candles if float(c["time"]) + step <= now]


def true_ranges(candles: List[Dict[str, Any]]) -> List[float]:
    out: List[float] = []
    for i in range(1, len(candles)):
        cur, prev = candles[i], candles[i - 1]
        h, l, pc = float(cur["high"]), float(cur["low"]), float(prev["close"])
        out.append(max(h - l, abs(h - pc), abs(l - pc)))
    return out


def wilder_atr(candles: List[Dict[str, Any]], period: int) -> Optional[float]:
    """Wilder's smoothed ATR - the standard definition used by charting tools."""
    tr = true_ranges(candles)
    if len(tr) < period:
        return None
    atr = sum(tr[:period]) / period
    for value in tr[period:]:
        atr = (atr * (period - 1) + value) / period
    return atr


class AtrGate:
    """Caches ATR and answers 'is BTC moving enough to trade?'."""

    def __init__(self, client: DeltaClient, symbol: str, resolution: str,
                 period: int, min_atr: float, refresh_sec: float = 30.0,
                 enabled: bool = True):
        self.client = client
        self.symbol = symbol
        self.resolution = resolution
        self.period = period
        self.min_atr = min_atr
        self.refresh_sec = refresh_sec
        self.enabled = enabled
        self._value: Optional[float] = None
        self._fetched_at: float = 0.0

    def value(self, now: Optional[float] = None) -> Optional[float]:
        now = now or time.time()
        if self._value is not None and (now - self._fetched_at) < self.refresh_sec:
            return self._value
        step = _RESOLUTION_SECONDS.get(self.resolution, 300)
        # Ask for well over `period` bars so warm-up never truncates the average.
        lookback = step * (self.period * 6 + 20)
        try:
            candles = self.client.candles(self.symbol, self.resolution,
                                          int(now - lookback), int(now))
        except Exception as exc:  # noqa: BLE001
            log.warning("ATR candle fetch failed: %s", exc)
            return self._value
        candles = closed_bars(candles, step, now)
        if len(candles) < self.period + 2:
            log.warning("ATR: only %d candles for %s", len(candles), self.symbol)
            return self._value
        atr = wilder_atr(candles, self.period)
        if atr is not None:
            self._value, self._fetched_at = atr, now
        return self._value

    def passes(self, now: Optional[float] = None) -> tuple[bool, Optional[float]]:
        if not self.enabled:
            return True, self.value(now)
        atr = self.value(now)
        if atr is None:
            return False, None
        return atr > self.min_atr, atr
