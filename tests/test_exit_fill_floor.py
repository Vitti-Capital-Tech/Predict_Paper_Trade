"""Paper exits must honour the same bid floor a live sell does.

A live sell goes in at `bid - max_slippage` and a thin wing does not fill. The
paper twin used to sweep the whole bid ladder and bank the exit anyway, which
is the live-vs-paper gap on ITM wings (Trading Alpha #26 vs its paper twin).
These test the rule the exit path now applies: trim the sell to the size that
fills at or above the floor, and with partials off, refuse it when that size is
short of the full position.

    python tests/test_exit_fill_floor.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from predict_paper.config import FillConfig
from predict_paper.fills import PRICE_MIN, FillEngine


def book(bids):
    """A book with the given (price, size) bids and ample asks."""
    return {"buy": [{"price": p, "size": s} for p, s in bids],
            "sell": [{"price": 0.99, "size": 1e9}]}


def exit_fill(engine, qty, bk, bid, max_slippage, allow_partial=False):
    """The decision manage_exits makes for a paper sell: trim to the floor,
    block when short unless partials are allowed, else fill the affordable
    slice. Returns (filled, qty, reason)."""
    if bid is None or bid <= 0:
        return False, 0.0, "nothing bid"
    floor = bid if max_slippage is None else max(PRICE_MIN, bid - max_slippage)
    qty_sell = engine.trim_to_budget("sell", qty, bk, floor)
    if qty_sell < qty and not allow_partial:
        return False, 0.0, "no fill at %.4f" % floor
    fill = engine.simulate("sell", qty_sell, bk, bid, None, None)
    return fill.filled, fill.qty, fill.reason


def engine():
    return FillEngine(FillConfig())   # orderbook, no partial, depth 1.0


def test_thin_wing_is_refused_like_live():
    # Top bid 0.66 for 10 contracts, then a cliff to 0.30. Floor = 0.63.
    # Only 10 fill at or above the floor, so a 100-lot exit cannot fill.
    e = engine()
    bk = book([(0.66, 10), (0.30, 5000)])
    filled, qty, reason = exit_fill(e, 100, bk, bid=0.66, max_slippage=0.03)
    assert not filled, (filled, qty, reason)
    assert "no fill at 0.63" in reason, reason


def test_deep_bid_fills_above_floor():
    # The same touch, but 500 contracts sit at it: the whole 100 fills.
    e = engine()
    bk = book([(0.66, 500)])
    filled, qty, reason = exit_fill(e, 100, bk, bid=0.66, max_slippage=0.03)
    assert filled and abs(qty - 100) < 1e-9, (filled, qty, reason)


def test_shallow_dip_within_floor_still_fills():
    # Bid steps 0.66 -> 0.64, both within 0.03 of the touch, enough depth.
    e = engine()
    bk = book([(0.66, 60), (0.64, 60)])
    filled, qty, _ = exit_fill(e, 100, bk, bid=0.66, max_slippage=0.03)
    assert filled and abs(qty - 100) < 1e-9, (filled, qty)


def test_nothing_bid_is_refused():
    e = engine()
    filled, _, reason = exit_fill(e, 100, book([]), bid=None, max_slippage=0.03)
    assert not filled and reason == "nothing bid", reason


def test_partial_allowed_fills_the_affordable_slice():
    # With partials on, the exit takes the slice that fills at or above the
    # floor (the touch's 10, plus enough of the 0.30 cliff to drag the average
    # down to the 0.63 floor and no further), instead of refusing outright.
    cfg = FillConfig(); cfg.allow_partial = True
    e = FillEngine(cfg)
    bk = book([(0.66, 10), (0.30, 5000)])
    filled, qty, _ = exit_fill(e, 100, bk, bid=0.66, max_slippage=0.03, allow_partial=True)
    assert filled and 10 <= qty < 100, (filled, qty)
    fill = e.simulate("sell", qty, bk, 0.66, None, None)
    assert fill.avg_price >= 0.63 - 1e-9, fill.avg_price


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
