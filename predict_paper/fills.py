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


def qty_within_price(book: Dict[str, Any], side: str, qty: float,
                     ceiling: float, max_levels: int = 20) -> float:
    """The largest slice of `qty` whose average fill stays within `ceiling`.

    Buying more of a thin leg always costs more per contract, because each
    extra contract comes off a worse level - so the affordable sizes are a
    prefix of the requested one and one walk finds the edge of it. Returns
    0.0 when even the touch is already beyond the ceiling.

    For a buy, `ceiling` is a maximum average price; for a sell it is a
    minimum. Both are "no worse than this".
    """
    if qty <= 0:
        return 0.0
    key = "sell" if side == "buy" else "buy"
    levels = _levels(book, key, max_levels)
    if not levels:
        return 0.0
    levels.sort(key=lambda x: x[0], reverse=(side == "sell"))

    taken = cost = 0.0
    for price, size in levels:
        room = min(qty - taken, size)
        if room <= 0:
            break
        # How far the average may still be dragged, and how hard this level
        # drags it. A level on the right side of the ceiling is free to take
        # whole; one past it can still be taken while the cheaper fills below
        # carry it, and only stops the walk when that budget runs out. A level
        # priced past the ceiling is NOT the end of the walk on its own: if
        # its own size ran out first there is budget left for the next one.
        slack = (ceiling * taken - cost) if side == "buy" else (cost - ceiling * taken)
        worse = (price - ceiling) if side == "buy" else (ceiling - price)
        if worse > 0:
            allowed = slack / worse
            if allowed <= 0:
                break
            if allowed < room:
                taken += allowed
                cost += allowed * price
                break
        taken += room
        cost += room * price
    return max(0.0, taken)


def qty_within_spend(book: Dict[str, Any], side: str, qty: float,
                     budget: float, max_levels: int = 20) -> float:
    """The largest slice of `qty` that costs no more than `budget` to buy.

    A dollar budget is converted to contracts at the quoted price, but the
    fill walks past that price, so the money actually leaving the account is
    larger - by as much as the odds ceiling allows, which on a leg quoted at
    0.05 against a ceiling of 0.1667 is more than three times the budget.
    A leg being assembled out of small fills has to respect the total it is
    being assembled to, so the walk stops when the money runs out.
    """
    if qty <= 0 or budget <= 0:
        return 0.0
    key = "sell" if side == "buy" else "buy"
    levels = _levels(book, key, max_levels)
    if not levels:
        return 0.0
    levels.sort(key=lambda x: x[0])

    taken = cost = 0.0
    for price, size in levels:
        room = min(qty - taken, size)
        if room <= 0 or price <= 0:
            break
        if cost + room * price > budget:
            taken += (budget - cost) / price
            break
        taken += room
        cost += room * price
    return max(0.0, taken)


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

    def trim_to_budget(self, side: str, qty: float,
                       book: Optional[Dict[str, Any]],
                       ceiling: Optional[float],
                       budget: Optional[float] = None) -> float:
        """Shrink `qty` until it fills inside the limits, rather than refusing it.

        Two limits, and the smaller one wins: the price the fill may average
        (`ceiling`) and the money it may cost (`budget`). Both hold on a
        prefix of the order - each further contract comes off a worse level,
        so it can only raise the average and the total - which is why one
        walk each finds them.

        Only the order-book model has anything to shrink: under best_quote and
        mark the price does not depend on size, so a leg that is too expensive
        is too expensive at any size.

        The padding `_apply_extra` adds after the walk is part of what gets
        paid, so it comes out of the ceiling first - otherwise the trimmed
        size lands just past the limit it was trimmed to meet.
        """
        if not book or self.cfg.model != "orderbook":
            return qty
        if ceiling is not None:
            pad = self.cfg.extra_slippage_ticks * self.cfg.tick_size
            limit = (ceiling - pad) if side == "buy" else (ceiling + pad)
            qty = min(qty, qty_within_price(book, side, qty, limit,
                                            self.cfg.max_book_levels))
        if budget is not None and side == "buy":
            qty = min(qty, qty_within_spend(book, side, qty, budget,
                                            self.cfg.max_book_levels))
        return max(0.0, qty)

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
