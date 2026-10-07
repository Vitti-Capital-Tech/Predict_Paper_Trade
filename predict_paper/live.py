"""Real order placement for live accounts.

Three gates stand between a strategy decision and an order on the exchange,
and all three must be open:

  1. the account is `mode='live'`                  - migration 022
  2. the account has `live_enabled` set            - a switch, off by default
  3. PREDICT_LIVE_DRYRUN is not on                 - on by default

The third is the one that matters while this is new. With dry run on, every
intended order is logged in full and nothing is sent, so the whole path -
sizing, pricing, tagging, the lot - can be read against a real funded account
before any money moves. Turning it off is a deliberate act on the host, not a
setting anyone can reach from a browser.

What this is not: reconciliation. Delta is the authority on what is held, and
a write that times out may still have been accepted. Until positions and fills
are polled back, a live account's record here is only as good as its last
answered request - which is the remaining reason not to leave this running
unattended.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .delta_auth import DeltaAuthClient, DeltaAuthError, clamp_tag, clean_price

log = logging.getLogger("predict.live")


def dry_run() -> bool:
    """Default on. Only the literal '0' or 'false' turns it off."""
    raw = str(os.environ.get("PREDICT_LIVE_DRYRUN", "1")).strip().lower()
    return raw not in ("0", "false", "no", "off")


@dataclass
class LiveFill:
    """What came back, shaped like the paper engine's Fill.

    Every field `fills.Fill` carries is here, including the ones that only
    describe a simulated walk through the book. The portfolio reads them all
    when it records a position, and a missing one raised mid-record *after*
    the order had already filled on the exchange - which aborted the cycle
    before the leg could be marked as held, so the next cycle bought it
    again. Fourteen times, before it was stopped.

    `filled` is false for a refusal and for a dry run alike: in both cases no
    position exists, and the one thing worse than not trading would be
    recording one that does not.
    """
    filled: bool
    qty: float = 0.0
    avg_price: float = 0.0
    reason: str = ""
    order_id: Optional[str] = None
    # True when the exchange already had this exact order. Not an error: it
    # means the intended order is resting, and the guard did its job.
    duplicate: bool = False
    # The exchange may have acted on this even though we never heard back.
    # Treated as held, not as a free retry.
    unconfirmed: bool = False

    # The book-walk fields. There is no walk here - the exchange matched the
    # order - so the top is the price asked for and the slippage against it is
    # whatever the fill came back better or worse by.
    top_price: Optional[float] = None
    slippage_vs_top: float = 0.0
    levels_consumed: int = 0
    requested_qty: float = 0.0

    @property
    def notional(self) -> float:
        return self.qty * self.avg_price


class LiveExecutor:
    """Places one account's orders, or reports what it would have placed."""

    def __init__(self, account_id: int, name: str, api_key: str,
                 api_secret: str, base_url: str):
        self.account_id = account_id
        self.name = name
        self.client = DeltaAuthClient(api_key, api_secret, base_url)

    def tag(self, round_id: str, role: str, attempt: int = 0) -> str:
        """A deterministic id for an intended order.

        Deterministic so a retry of the same intent is refused by the exchange
        rather than doubling the position. The tail carries the role, which is
        what survives if the venue truncates it.
        """
        return clamp_tag("P%s-%s-%s-%d" % (self.account_id, round_id, role, attempt))

    def buy(self, symbol: str, qty: int, limit_price: float, round_id: str,
            role: str, attempt: int = 0) -> LiveFill:
        """Buy `qty` contracts at `limit_price` or better.

        Immediate-or-cancel, deliberately. The strategy's edge is in the price
        it decided on; an order left resting fills later at a price nobody
        tested, in a round that may by then be nearly over. Better to miss.
        """
        price = clean_price(limit_price)
        if price is None or qty < 1:
            return LiveFill(False, reason="nothing to send (qty=%s price=%s)"
                                          % (qty, limit_price))

        order = {
            "product_symbol": symbol,
            "size": int(qty),
            "side": "buy",
            "order_type": "limit_order",
            "limit_price": price,
            "time_in_force": "ioc",
            "client_order_id": self.tag(round_id, role, attempt),
        }

        if dry_run():
            log.info("DRYRUN %-14s would buy %-28s qty=%-6d @ %s  [%s]",
                     self.name, symbol, qty, price, order["client_order_id"])
            return LiveFill(False, reason="dry run - not sent")

        try:
            res = self.client.place_order(order) or {}
        except DeltaAuthError as exc:
            # The exchange already has this exact order, so the intended
            # position is resting. Reported as such rather than as a failure,
            # and not retried - retrying is what it is preventing.
            if "duplicate_client_order_id" in (exc.code or "").lower():
                log.info("LIVE   %-14s duplicate %s - already placed",
                         self.name, order["client_order_id"])
                return LiveFill(False, reason="already placed", duplicate=True)
            if getattr(exc, "indeterminate", False):
                # A timeout or a 5xx says nothing about whether the order was
                # accepted. Reported as unconfirmed so the caller stops
                # trying: retrying here is how one leg becomes two, and only
                # the deterministic client_order_id has been preventing it.
                log.error("LIVE   %-14s order UNCONFIRMED %s qty=%d @ %s: %s "
                          "- may or may not have reached the exchange",
                          self.name, symbol, qty, price, exc)
                return LiveFill(False, reason="unconfirmed: %s" % exc,
                                unconfirmed=True)
            log.error("LIVE   %-14s order REFUSED %s qty=%d @ %s: %s",
                      self.name, symbol, qty, price, exc)
            return LiveFill(False, reason=str(exc))
        except Exception as exc:  # noqa: BLE001
            log.error("LIVE   %-14s order UNCONFIRMED %s qty=%d @ %s: %s "
                      "- may or may not have reached the exchange",
                      self.name, symbol, qty, price, exc)
            return LiveFill(False, reason="unconfirmed: %s" % exc,
                            unconfirmed=True)

        filled = _f(res.get("size")) - _f(res.get("unfilled_size"))
        avg = _f(res.get("average_fill_price"))
        state = str(res.get("state") or "")
        oid = res.get("id")

        if filled < 1 or avg <= 0:
            # IOC with nothing crossing at the limit. Ordinary, not an error.
            log.info("LIVE   %-14s no fill %s @ %s (state=%s)",
                     self.name, symbol, price, state or "?")
            return LiveFill(False, reason="no fill at %s" % price, order_id=oid)

        log.info("LIVE   %-14s BOUGHT %-28s qty=%-6.0f @ %.4f  [%s]",
                 self.name, symbol, filled, avg, order["client_order_id"])
        return LiveFill(True, qty=filled, avg_price=avg, order_id=oid,
                        top_price=float(price), slippage_vs_top=avg - float(price),
                        levels_consumed=1, requested_qty=float(qty))


    def sell(self, symbol: str, qty: int, limit_price: float, round_id: str,
             role: str, attempt: int = 0) -> LiveFill:
        """Close `qty` contracts at `limit_price` or better.

        `reduce_only`, so this can only ever shrink a position. Without it a
        sell on a position that has already gone - settled, or closed by hand
        on the exchange - would open a short instead of closing nothing, and
        a short on a binary is a liability this strategy never intends to
        hold.

        Immediate-or-cancel for the same reason as the buy: an exit that
        rests is an exit that has not happened, and the rule that asked for
        it was about this moment.
        """
        price = clean_price(limit_price)
        if price is None or qty < 1:
            return LiveFill(False, reason="nothing to send (qty=%s price=%s)"
                                          % (qty, limit_price))

        order = {
            "product_symbol": symbol,
            "size": int(qty),
            "side": "sell",
            "order_type": "limit_order",
            "limit_price": price,
            "time_in_force": "ioc",
            "reduce_only": True,
            "client_order_id": clamp_tag(
                "X%s-%s-%s-%d" % (self.account_id, round_id, role, attempt)),
        }

        if dry_run():
            log.info("DRYRUN %-14s would sell %-28s qty=%-6d @ %s  [%s]",
                     self.name, symbol, qty, price, order["client_order_id"])
            return LiveFill(False, reason="dry run - not sent")

        try:
            res = self.client.place_order(order) or {}
        except DeltaAuthError as exc:
            code = (exc.code or "").lower()
            # The position is already gone, so the exit it was asked for has
            # in effect happened. Reported as closed rather than as a failure
            # that would be retried every cycle for the rest of the round.
            if "no_position_for_reduce_only" in code or "reduce_only" in code:
                log.info("LIVE   %-14s %s already flat on Delta", self.name, symbol)
                return LiveFill(False, reason="already closed on Delta",
                                duplicate=True)
            if "duplicate_client_order_id" in code:
                log.info("LIVE   %-14s duplicate exit %s - already placed",
                         self.name, order["client_order_id"])
                return LiveFill(False, reason="exit already placed", duplicate=True)
            if getattr(exc, "indeterminate", False):
                log.error("LIVE   %-14s exit UNCONFIRMED %s qty=%d @ %s: %s "
                          "- may or may not have reached the exchange",
                          self.name, symbol, qty, price, exc)
                return LiveFill(False, reason="unconfirmed: %s" % exc,
                                unconfirmed=True)
            log.error("LIVE   %-14s exit REFUSED %s qty=%d @ %s: %s",
                      self.name, symbol, qty, price, exc)
            return LiveFill(False, reason=str(exc))
        except Exception as exc:  # noqa: BLE001
            log.error("LIVE   %-14s exit UNCONFIRMED %s qty=%d @ %s: %s "
                      "- may or may not have reached the exchange",
                      self.name, symbol, qty, price, exc)
            return LiveFill(False, reason="unconfirmed: %s" % exc,
                            unconfirmed=True)

        filled = _f(res.get("size")) - _f(res.get("unfilled_size"))
        avg = _f(res.get("average_fill_price"))
        if filled < 1 or avg <= 0:
            log.info("LIVE   %-14s exit did not fill %s @ %s",
                     self.name, symbol, price)
            return LiveFill(False, reason="no fill at %s" % price,
                            order_id=res.get("id"))

        log.info("LIVE   %-14s SOLD   %-28s qty=%-6.0f @ %.4f  [%s]",
                 self.name, symbol, filled, avg, order["client_order_id"])
        return LiveFill(True, qty=filled, avg_price=avg, order_id=res.get("id"),
                        top_price=float(price), slippage_vs_top=float(price) - avg,
                        levels_consumed=1, requested_qty=float(qty))


def _f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0
