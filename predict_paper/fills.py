"""Fill simulation.

The whole credibility of a paper run on these markets rests here. The wings are
exactly where the book is thinnest - e.g. a put quoted bid 0.001 / ask 0.049 -
so filling at mid or at mark would manufacture edge that does not exist.
Default model walks the real L2 book level by level.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger(__name__)

PRICE_MIN, PRICE_MAX = 0.0001, 0.9999


@dataclass
class Fill:
    filled: bool
    qty: float
    avg_price: float
    reason: str = ""
    levels_consumed: int = 0
    top_price: Optional[float] = None
    slippage_vs_top: float = 0.0
    requested_qty: float = 0.0

    @property
    def notional(self) -> float:
        return self.qty * self.avg_price


def _levels(book: Dict[str, Any], key: str, limit: int) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for lvl in (book.get(key) or [])[:limit]:
        try:
            price = float(lvl["price"])
            size = float(lvl["size"])
        except (KeyError, TypeError, ValueError):
            continue
        if size > 0:
            out.append((price, size))
    return out


def walk_book(book: Dict[str, Any], side: str, qty: float, max_levels: int = 20,
              allow_partial: bool = False) -> Fill:
    """side='buy' consumes asks (book['sell']); side='sell' consumes bids."""
    key = "sell" if side == "buy" else "buy"
    levels = _levels(book, key, max_levels)
    if not levels:
        return Fill(False, 0.0, 0.0, f"no {key} liquidity", requested_qty=qty)

    # Asks ascend, bids descend - sort defensively rather than trust the feed.
    levels.sort(key=lambda x: x[0], reverse=(side == "sell"))

    remaining, cost, consumed = qty, 0.0, 0
    for price, size in levels:
        if remaining <= 0:
            break
        take = min(remaining, size)
        cost += take * price
        remaining -= take
        consumed += 1

    got = qty - remaining
    if got <= 0:
        return Fill(False, 0.0, 0.0, "book empty", requested_qty=qty)
    if remaining > 0 and not allow_partial:
        return Fill(False, 0.0, 0.0,
                    f"insufficient depth ({got:.0f}/{qty:.0f} available)",
                    requested_qty=qty)

    avg = cost / got
    top = levels[0][0]
    slip = (avg - top) if side == "buy" else (top - avg)
    return Fill(True, got, avg, "ok", consumed, top, slip, qty)


class FillEngine:
    def __init__(self, cfg):
        self.cfg = cfg

    def _apply_extra(self, price: float, side: str) -> float:
        """Adverse padding for latency/queue effects beyond visible depth."""
        pad = self.cfg.extra_slippage_ticks * self.cfg.tick_size
        price = price + pad if side == "buy" else price - pad
        return min(max(price, PRICE_MIN), PRICE_MAX)

    def spread_ok(self, bid: Optional[float], ask: Optional[float]) -> Tuple[bool, str]:
        limit = self.cfg.max_spread_frac
        if limit is None:
            return True, ""
        if bid is None or ask is None:
            return False, "missing quote"
        mid = (bid + ask) / 2.0
        if mid <= 0:
            return False, "bad mid"
        frac = (ask - bid) / mid
        if frac > limit:
            return False, f"spread {frac:.1%} of mid exceeds limit {limit:.0%}"
        return True, ""

    def simulate(self, side: str, qty: float, book: Optional[Dict[str, Any]],
                 best_bid: Optional[float], best_ask: Optional[float],
                 mark: Optional[float]) -> Fill:
        model = self.cfg.model
        if model == "orderbook":
            if not book:
                return Fill(False, 0.0, 0.0, "no orderbook", requested_qty=qty)
            fill = walk_book(book, side, qty, self.cfg.max_book_levels,
                             self.cfg.allow_partial)
            if not fill.filled:
                return fill
            fill.avg_price = self._apply_extra(fill.avg_price, side)
            return fill

        if model == "best_quote":
            px = best_ask if side == "buy" else best_bid
            if px is None:
                return Fill(False, 0.0, 0.0, "no quote", requested_qty=qty)
            px = self._apply_extra(px, side)
            return Fill(True, qty, px, "ok", 1, px, 0.0, qty)

        if model == "mark":
            if mark is None:
                return Fill(False, 0.0, 0.0, "no mark", requested_qty=qty)
            px = self._apply_extra(mark, side)
            return Fill(True, qty, px, "ok (optimistic: mark fill)", 1, px, 0.0, qty)

        raise ValueError(f"unknown fill model: {model}")
