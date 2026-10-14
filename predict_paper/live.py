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
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from . import telegram
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
        # The account's own Telegram chat, for its trade messages. Set by the
        # engine from the accounts row, and refreshed when it changes.
        self.chat_id = ""
        self.client = DeltaAuthClient(api_key, api_secret, base_url)
        # symbol -> (client_order_id, qty) of a sell whose answer never came.
        # Looked up on Delta before anything else is sent for that symbol.
        self._pending_sells: Dict[str, tuple] = {}
        # Symbols Delta says this account no longer holds, with no sale of
        # ours to account for it. Not sold again - see sell().
        self._flat: set = set()

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
                telegram.notify_failure(
                    telegram.AMBER, self.name,
                    "Order UNCONFIRMED (buy %s) - may be open on Delta" % symbol,
                    str(exc), "qty %d @ %s" % (qty, price), self.chat_id)
                return LiveFill(False, reason="unconfirmed: %s" % exc,
                                unconfirmed=True)
            log.error("LIVE   %-14s order REFUSED %s qty=%d @ %s: %s",
                      self.name, symbol, qty, price, exc)
            telegram.notify_failure(
                telegram.YELLOW, self.name,
                "Order send FAILED (buy %s) - nothing was opened" % symbol,
                str(exc), "qty %d @ %s" % (qty, price), self.chat_id)
            return LiveFill(False, reason=str(exc))
        except Exception as exc:  # noqa: BLE001
            log.error("LIVE   %-14s order UNCONFIRMED %s qty=%d @ %s: %s "
                      "- may or may not have reached the exchange",
                      self.name, symbol, qty, price, exc)
            telegram.notify_failure(
                telegram.AMBER, self.name,
                "Order UNCONFIRMED (buy %s) - may be open on Delta" % symbol,
                str(exc), "qty %d @ %s" % (qty, price), self.chat_id)
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
        telegram.notify_trade(self.name, "📥 LIVE ENTRY",
                              "Bought %s\nqty %.0f @ %.4f ($%.2f)" % (
                                  symbol, filled, avg, filled * avg),
                              chat_id=self.chat_id)
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

        A sell whose answer never arrives is looked up on Delta rather than
        guessed at. On 13 Oct one timed out, had filled, and was then retried
        134 times against a position that no longer existed - each refused -
        until the round expired and the record booked a -$46 loss on a leg
        that had actually been sold for +$55.
        """
        if symbol in self._flat:
            return LiveFill(False, reason="not held on Delta", duplicate=True)

        # An earlier sell is still unaccounted for. Learn what it did before
        # sending another: it may already be the exit.
        if self.has_pending(symbol):
            seen = self.resolve_pending(symbol)
            if seen is None:
                return LiveFill(False, reason="earlier exit still unknown",
                                unconfirmed=True)
            if seen.filled:
                return seen
            # Never reached Delta, or reached it and did not fill. Either way
            # nothing was sold, and a fresh order is safe.

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
            # Unique per order, unlike the buy's. An unanswered sell is
            # resolved by looking this id up, and Delta answers for one order
            # per id - a retry under the same id would make the answer
            # ambiguous. Delta does not refuse a reused id either, so
            # uniqueness costs no protection.
            "client_order_id": clamp_tag("X%s-%s-%s-%s" % (
                self.account_id, round_id, role, _stamp36())),
        }

        if dry_run():
            log.info("DRYRUN %-14s would sell %-28s qty=%-6d @ %s  [%s]",
                     self.name, symbol, qty, price, order["client_order_id"])
            return LiveFill(False, reason="dry run - not sent")

        coid = order["client_order_id"]
        try:
            res = self.client.place_order(order) or {}
        except DeltaAuthError as exc:
            if getattr(exc, "indeterminate", False):
                return self._unanswered(symbol, qty, price, coid, exc)
            code = (exc.code or "").lower()
            if code in _NOT_HELD or "reduce_only" in code:
                return self._not_held(symbol, qty, exc)
            log.error("LIVE   %-14s exit REFUSED %s qty=%d @ %s: %s",
                      self.name, symbol, qty, price, exc)
            telegram.notify_failure(
                telegram.RED, self.name,
                "Close FAILED (sell %s) - leg may still be OPEN on Delta" % symbol,
                str(exc), "qty %d @ %s" % (qty, price), self.chat_id)
            return LiveFill(False, reason=str(exc))
        except Exception as exc:  # noqa: BLE001
            return self._unanswered(symbol, qty, price, coid, exc)

        filled = _f(res.get("size")) - _f(res.get("unfilled_size"))
        avg = _f(res.get("average_fill_price"))
        if filled < 1 or avg <= 0:
            log.info("LIVE   %-14s exit did not fill %s @ %s",
                     self.name, symbol, price)
            return LiveFill(False, reason="no fill at %s" % price,
                            order_id=res.get("id"))

        log.info("LIVE   %-14s SOLD   %-28s qty=%-6.0f @ %.4f  [%s]",
                 self.name, symbol, filled, avg, coid)
        self._announce_sale(symbol, filled, avg)
        return LiveFill(True, qty=filled, avg_price=avg, order_id=res.get("id"),
                        top_price=float(price), slippage_vs_top=float(price) - avg,
                        levels_consumed=1, requested_qty=float(qty))

    # ---- when the answer is missing or surprising -------------------------
    def has_pending(self, symbol: str) -> bool:
        return symbol in self._pending_sells

    def resolve_pending(self, symbol: str) -> Optional[LiveFill]:
        """Settle an unanswered sell from Delta's order record.

        Called every cycle for a position with one outstanding, not only when
        the exit rule fires again - the rule may never fire again, and the
        sale, if it happened, still has to be recorded.

        None while Delta cannot say. Otherwise the final answer, and the
        sell is no longer pending: a filled LiveFill is the exit to record; an
        unfilled one means nothing was sold.
        """
        coid, _qty = self._pending_sells.get(symbol, (None, 0))
        if coid is None:
            return None
        seen = self._lookup_sell(coid)
        if seen is None:
            return None
        self._pending_sells.pop(symbol, None)
        if seen.filled:
            log.warning("LIVE   %-14s SOLD   %-28s qty=%-6.0f @ %.4f  [%s] "
                        "- confirmed late, from Delta's order record",
                        self.name, symbol, seen.qty, seen.avg_price, coid)
            self._announce_sale(symbol, seen.qty, seen.avg_price)
        else:
            log.info("LIVE   %-14s earlier exit %s on %s sold nothing (%s)",
                     self.name, coid, symbol, seen.reason)
        return seen

    def _unanswered(self, symbol: str, qty: int, price: str, coid: str,
                    exc: Exception) -> LiveFill:
        """The sell went out and no answer came back. Ask Delta straight away
        - the order usually finished moments after the timeout - and only
        call it unknown if Delta cannot say either."""
        seen = self._lookup_sell(coid)
        if seen is not None and seen.filled:
            log.warning("LIVE   %-14s SOLD   %-28s qty=%-6.0f @ %.4f  [%s] - the "
                        "request timed out; Delta's order record confirms the sale",
                        self.name, symbol, seen.qty, seen.avg_price, coid)
            self._announce_sale(symbol, seen.qty, seen.avg_price)
            return seen
        if seen is not None:
            log.info("LIVE   %-14s exit did not fill %s @ %s (request timed out; "
                     "Delta's order record shows nothing sold)", self.name, symbol, price)
            return LiveFill(False, reason="no fill at %s" % price)
        self._pending_sells[symbol] = (coid, qty)
        log.error("LIVE   %-14s exit UNCONFIRMED %s qty=%d @ %s: %s - may or may "
                  "not have reached the exchange; will look it up before selling again",
                  self.name, symbol, qty, price, exc)
        telegram.notify_failure(
            telegram.RED, self.name,
            "Close UNCONFIRMED (sell %s) - leg may still be OPEN on Delta" % symbol,
            str(exc), "qty %d @ %s" % (qty, price), self.chat_id)
        return LiveFill(False, reason="unconfirmed: %s" % exc, unconfirmed=True)

    def _not_held(self, symbol: str, qty: int, exc: Exception) -> LiveFill:
        """Delta refused the sell as having nothing to reduce.

        On these markets that arrives as `naked_short_restricted` rather than
        the `no_position_for_reduce_only` this used to wait for, so it was
        read as an ordinary refusal and retried every few seconds. It can also
        mean only that our size is larger than Delta's, so Delta is asked what
        it holds before anything is concluded.
        """
        try:
            held = 0.0
            for p in self.client.open_positions() or []:
                if isinstance(p, dict) and p.get("product_symbol") == symbol:
                    held = abs(_f(p.get("size")))
        except Exception as e:  # noqa: BLE001
            log.warning("LIVE   %-14s exit refused for %s (%s) and positions "
                        "could not be read: %s", self.name, symbol, exc, e)
            return LiveFill(False, reason=str(exc))
        if held >= 1:
            # Still holding - the size we asked for is wrong, not the position.
            # Reconciliation corrects our size to Delta's within a minute.
            log.warning("LIVE   %-14s exit refused for %s qty=%d: %s - Delta "
                        "holds %.0f; waiting for the size to be corrected",
                        self.name, symbol, qty, exc, held)
            return LiveFill(False, reason="size differs from Delta (%.0f)" % held)
        self._flat.add(symbol)
        log.error("LIVE   %-14s %s is no longer held on Delta, and no sale of "
                  "ours accounts for it - not selling it again", self.name, symbol)
        telegram.notify_failure(
            telegram.AMBER, self.name,
            "%s is no longer open on Delta but the engine did not sell it - "
            "closed by hand? The record will settle it at expiry; check Delta "
            "for the real price" % symbol, str(exc), chat_id=self.chat_id)
        return LiveFill(False, reason="not held on Delta", duplicate=True)

    def _lookup_sell(self, coid: str) -> Optional[LiveFill]:
        """What became of one sell, from Delta's own record.

        A LiveFill when the answer is final - filled, finished without
        filling, or never received. None when Delta cannot say yet: the order
        is still live, or the lookup itself failed.
        """
        try:
            o = self.client.order_by_client_id(coid) or {}
        except DeltaAuthError as exc:
            if (exc.code or "").lower() == "order_not_found":
                return LiveFill(False, reason="order never reached Delta")
            log.warning("LIVE   %-14s could not look up %s: %s", self.name, coid, exc)
            return None
        except Exception as exc:  # noqa: BLE001
            log.warning("LIVE   %-14s could not look up %s: %s", self.name, coid, exc)
            return None
        if str(o.get("state") or "").lower() not in ("closed", "cancelled"):
            return None
        filled = _f(o.get("size")) - _f(o.get("unfilled_size"))
        avg = _f(o.get("average_fill_price"))
        if filled < 1 or avg <= 0:
            return LiveFill(False, reason="finished without a fill")
        limit = _f(o.get("limit_price")) or avg
        return LiveFill(True, qty=filled, avg_price=avg, order_id=o.get("id"),
                        top_price=limit, slippage_vs_top=limit - avg,
                        levels_consumed=1, requested_qty=_f(o.get("size")))

    def _announce_sale(self, symbol: str, qty: float, avg: float) -> None:
        telegram.notify_trade(self.name, "\U0001F4E4 LIVE EXIT",
                              "Sold %s\nqty %.0f @ %.4f ($%.2f)" % (
                                  symbol, qty, avg, qty * avg),
                              chat_id=self.chat_id)


# Delta's ways of saying there is nothing to reduce. Binary markets answer
# with the second; the first is what the API documents.
_NOT_HELD = ("no_position_for_reduce_only", "naked_short_restricted")

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _stamp36() -> str:
    """Five base-36 characters of tenths of a second - unique per order for
    about 70 days, and short enough that the tag stays whole under Delta's
    36-character cap."""
    n = int(time.time() * 10) % (36 ** 5)
    out = ""
    for _ in range(5):
        n, r = divmod(n, 36)
        out = _B36[r] + out
    return out


def _f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0
