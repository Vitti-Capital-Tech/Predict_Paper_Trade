"""The rule engine.

Encodes the strategy as stated:
  * a timing filter
  * entry on the 1st and last strike, needing at least 1:5 odds on both
  * middle strike only at 1:3 odds or better
  * exit rule "ITM 50"
  * only trade when BTC ATR > 200

Every decision returns its reason, so a rejected round is auditable rather than
silently skipped.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timedelta, timezone
from typing import List, Optional, Tuple

from .rounds import Contract, Round

log = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))

# The role of the single leg bought while spot is outside the strikes. Its
# own name, not a wing's: it must not count toward the both-wings rule or
# let a middle ride along, and a round holding it is locked to it.
OUTSIDE = "outside"


@dataclass
class LegSignal:
    role: str  # wing_low | wing_high | middle
    contract: Optional[Contract]
    max_price: float
    quoted_price: Optional[float]
    ok: bool
    reason: str = ""


@dataclass
class RoundDecision:
    round_id: str
    enter: bool
    legs: List[LegSignal] = field(default_factory=list)
    reasons: List[str] = field(default_factory=list)
    atr: Optional[float] = None
    spot: Optional[float] = None

    def reject(self, why: str) -> "RoundDecision":
        self.enter = False
        self.reasons.append(why)
        return self


def _parse_window(win: str) -> Tuple[dtime, dtime]:
    start_s, end_s = win.split("-")
    h1, m1 = (int(x) for x in start_s.strip().split(":"))
    h2, m2 = (int(x) for x in end_s.strip().split(":"))
    return dtime(h1, m1), dtime(h2, m2)


def in_sessions(now: datetime, sessions: List[str], tz_name: str) -> bool:
    if not sessions:
        return True
    tz = IST if tz_name.upper() == "IST" else timezone.utc
    local = now.astimezone(tz).replace(tzinfo=None).time()
    for win in sessions:
        start, end = _parse_window(win)
        if start <= end:
            if start <= local <= end:
                return True
        else:  # window wraps midnight
            if local >= start or local <= end:
                return True
    return False


class Strategy:
    def __init__(self, cfg):
        self.cfg = cfg

    # ---- filters --------------------------------------------------------
    def timing_ok(self, rnd: Round, now: datetime) -> Tuple[bool, str]:
        t = self.cfg.timing
        if now.astimezone(timezone.utc).weekday() not in t.weekdays:
            return False, "weekday filter"
        if not in_sessions(now, t.sessions, t.session_timezone):
            return False, "outside session windows (%s)" % t.session_timezone

        tte = rnd.seconds_to_expiry(now)
        # Hard floor: the venue will not accept an order in the halt window,
        # whatever min_seconds_to_expiry is configured to.
        if tte <= t.trading_halt_sec:
            return False, "trading halted for the final %.0fs" % t.trading_halt_sec
        if tte < t.min_seconds_to_expiry:
            return False, "too close to expiry (%.0fs < %.0fs)" % (tte, t.min_seconds_to_expiry)
        if tte > t.max_seconds_to_expiry:
            return False, "too far from expiry (%.0fs > %.0fs)" % (tte, t.max_seconds_to_expiry)

        since = rnd.seconds_since_launch(now)
        if since is not None:
            if since < t.min_seconds_since_launch:
                return False, "round too young (%.0fs < %.0fs)" % (since, t.min_seconds_since_launch)
            if since > t.max_seconds_since_launch:
                return False, "round too old (%.0fs > %.0fs)" % (since, t.max_seconds_since_launch)
        return True, "ok"

    # ---- entry ----------------------------------------------------------
    def _leg_signal(self, role: str, contract: Optional[Contract],
                    max_price: float) -> LegSignal:
        if contract is None:
            return LegSignal(role, contract, max_price, None, False, "leg not listed")
        ask = contract.best_ask
        if ask is None:
            return LegSignal(role, contract, max_price, None, False, "no ask quoted")
        if ask > max_price:
            return LegSignal(role, contract, max_price, ask, False,
                             "ask %.4f above max %.4f (odds worse than required)"
                             % (ask, max_price))
        return LegSignal(role, contract, max_price, ask, True, "ok")

    # ---- out of range -------------------------------------------------
    def _outside_range(self, rnd: Round, dec: RoundDecision, held: set,
                       lo: float, hi: float, spot: float) -> RoundDecision:
        """Spot has left the range. At most one leg, at the strike nearest it.

        This replaces what the strangle logic does out here, which is buy the
        far strike: with spot above the range the lowest put is the one cheap
        enough to pass the odds, and it pays only if spot falls back through
        every strike. 101 of the 160 legs bought out of range were that far
        strike. The rule asked for is the near one, and only the near one.

        Which side - YES or NO - is decided the way every other leg is: test
        both against the bar and buy the one that passes, the cheaper if both
        do. That is the middle strike's rule as well.
        """
        entry = self.cfg.entry
        where = "above" if spot > hi else "below"
        closest = hi if spot > hi else lo
        span = "spot %.1f %s strikes %g-%g" % (spot, where, lo, hi)

        if held:
            # Already traded while spot was inside. Adding to it now would mean
            # buying something out here, which is the far-strike trade this
            # rule exists to stop.
            return dec.reject("%s; round already entered, nothing added out of range"
                              % span)
        if not entry.trade_outside_range:
            return dec.reject("%s; out-of-range trading is off" % span)

        sigs = [self._leg_signal(OUTSIDE, rnd.get(closest, side),
                                 self.cfg.outside_max_price)
                for side in ("call", "put")]
        dec.legs = [s for s in sigs if s.contract is not None]
        ok = [s for s in sigs if s.ok]
        if not ok:
            return dec.reject("%s; neither side at %g qualifies: %s" % (
                span, closest, "; ".join(
                    "%s %s" % (s.contract.side if s.contract else "?", s.reason)
                    for s in sigs)))
        dec.legs = [min(ok, key=lambda s: s.quoted_price)]
        dec.enter = True
        return dec

    def _outside_locked(self, rnd: Round, dec: RoundDecision,
                        held_symbols: set) -> RoundDecision:
        """A round entered out of range takes that one leg and nothing else.

        Without this, spot drifting back inside would hand the round to the
        strangle logic, which would buy the other extreme and the middle -
        turning one deliberate leg into a strangle assembled by accident.

        The leg itself is offered back, so partial entry can still finish
        buying it. The engine lets a held leg through only to top it up, so
        this cannot open anything new; and once that leg is closed it cannot be
        bought again.
        """
        mine = [c for c in rnd.contracts if c.symbol in held_symbols]
        dec.legs = [self._leg_signal(OUTSIDE, c, self.cfg.outside_max_price)
                    for c in mine]
        if not any(s.ok for s in dec.legs):
            return dec.reject("entered out of range; single leg only")
        dec.enter = True
        return dec

    def evaluate(self, rnd: Round, now: datetime, atr_ok: bool,
                 atr: Optional[float],
                 held: Optional[set] = None,
                 held_symbols: Optional[set] = None) -> RoundDecision:
        """`held` names roles already open in this round for this account.

        A leg that is already on counts as satisfied: if one extreme filled
        earlier and the other only clears its odds ten minutes later, the pair
        should still complete rather than being refused because both did not
        qualify on the same tick.

        `held_symbols` names the contracts behind those roles. Only the
        out-of-range rule needs it, to find the one leg a locked round holds.
        """
        held = held or set()
        dec = RoundDecision(round_id=rnd.round_id, enter=False, atr=atr, spot=rnd.spot)

        if not atr_ok:
            shown = ("%.1f" % atr) if atr is not None else "unavailable"
            return dec.reject("ATR gate: %s <= %.0f" % (shown, self.cfg.atr.min_atr))

        ok, why = self.timing_ok(rnd, now)
        if not ok:
            return dec.reject("timing: " + why)

        entry = self.cfg.entry
        legs: List[LegSignal] = []

        # A round still being listed shows fewer than three strikes, and its
        # "extremes" are whichever happen to be quoted - not the real edges.
        if not rnd.complete:
            return dec.reject("round still listing (%d of 3 strikes)"
                              % len(rnd.strikes))

        # Where spot sits against the strikes decides which strategy applies.
        # Inside the range is the strangle the rest of this method describes.
        # Outside it is a different trade entirely, handled on its own - and a
        # round entered that way stays that way.
        strikes = rnd.strikes
        lo, hi = strikes[0], strikes[-1]
        spot = rnd.spot
        if OUTSIDE in held:
            return self._outside_locked(rnd, dec, held_symbols or set())
        if spot is not None and not (lo <= spot <= hi):
            return self._outside_range(rnd, dec, held, lo, hi, spot)

        if entry.trade_wings:
            wings = rnd.wing_legs(entry.extremes_mode)
            low = self._leg_signal("wing_low", wings["low"], self.cfg.wing_max_price)
            high = self._leg_signal("wing_high", wings["high"], self.cfg.wing_max_price)
            legs.extend([low, high])
            if entry.require_both_wings:
                low_done = low.ok or "wing_low" in held
                high_done = high.ok or "wing_high" in held
                if not (low_done and high_done):
                    dec.legs = legs
                    bad = [l for l in (low, high)
                           if not l.ok and l.role not in held]
                    return dec.reject("wings: " + "; ".join(
                        "%s %s" % (l.role, l.reason) for l in bad))

        # The middle only rides along with a pair already on both extremes.
        wings_ok = entry.trade_wings and all(
            l.ok or l.role in held for l in legs[:2]) and len(legs) >= 2
        if entry.trade_middle and (wings_ok or not entry.middle_needs_both_wings):
            mids = rnd.middle_legs()
            candidates: List[Contract] = []
            if entry.middle_side in ("auto", "call") and mids["call"]:
                candidates.append(mids["call"])
            if entry.middle_side in ("auto", "put") and mids["put"]:
                candidates.append(mids["put"])
            # 'auto' takes whichever middle leg is cheap enough; if both are, take
            # the cheaper one rather than doubling up on the same strike.
            priced = [c for c in candidates if c.best_ask is not None]
            chosen = min(priced, key=lambda c: c.best_ask) if priced else None
            sig = self._leg_signal("middle", chosen, self.cfg.middle_max_price)
            if sig.ok:
                legs.append(sig)
            else:
                dec.reasons.append("middle skipped: " + sig.reason)

        dec.legs = legs
        if not [l for l in legs if l.ok]:
            return dec.reject("no leg met its odds threshold")

        dec.enter = True
        return dec

    # ---- exit -----------------------------------------------------------
    def should_exit(self, position, contract: Optional[Contract],
                    spot: Optional[float]) -> Tuple[bool, str]:
        """Implements 'exit rule ITM 50' under the configured interpretation."""
        ex = self.cfg.exit

        # A hand-placed trade is the user's to exit. Taking profit on their
        # behalf would close a position they never asked to close, so the
        # strategy leaves manual roles alone unless explicitly told not to.
        if getattr(position, "role", "") == "manual" and not ex.apply_to_manual:
            return False, ""

        if ex.mode == "price":
            bid = contract.best_bid if contract else None
            if bid is not None and bid >= ex.take_profit_price:
                return True, "take profit: bid %.4f >= %.2f" % (bid, ex.take_profit_price)
            if ex.stop_loss_price is not None and bid is not None and bid <= ex.stop_loss_price:
                return True, "stop loss: bid %.4f <= %.4f" % (bid, ex.stop_loss_price)
            return False, ""

        if ex.mode == "moneyness":
            if spot is None:
                return False, ""
            # Signed distance past the strike in this leg's favour: positive
            # means the contract is in the money.
            edge = (spot - position.strike) if position.side == "call"                 else (position.strike - spot)
            trig = ex.moneyness_trigger
            if trig == "itm" and edge >= ex.spot_points_itm:
                return True, "ITM: %.1f points past strike %.0f" % (
                    edge, position.strike)
            if trig == "otm" and edge <= -ex.spot_points_itm:
                return True, "OTM: %.1f points against strike %.0f" % (
                    -edge, position.strike)
            if trig == "atm" and abs(spot - position.strike) <= ex.atm_band_points:
                return True, "ATM: spot %.1f within %.0f of strike %.0f" % (
                    spot, ex.atm_band_points, position.strike)
            return False, ""

        if ex.mode == "spot_points":
            if spot is None:
                return False, ""
            pts = ex.spot_points_itm
            if position.side == "call" and spot >= position.strike + pts:
                return True, "spot %.1f is %.0f+ above strike %.0f" % (spot, pts, position.strike)
            if position.side == "put" and spot <= position.strike - pts:
                return True, "spot %.1f is %.0f+ below strike %.0f" % (spot, pts, position.strike)
            return False, ""

        raise ValueError("unknown exit mode: %s" % ex.mode)
