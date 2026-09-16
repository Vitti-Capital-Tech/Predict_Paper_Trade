"""Live paper-trading loop.

Read-only against the venue: it polls public market data, simulates fills
against the real order book, and keeps its own ledger. It never authenticates
and never places an order.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

from .delta import DeltaClient
from .fills import FillEngine
from .indicators import AtrGate
from .portfolio import Portfolio, Position
from .rounds import Contract, Round, build_rounds
from .store import build_store
from .strategy import Strategy

log = logging.getLogger(__name__)


class Engine:
    def __init__(self, cfg, client: Optional[DeltaClient] = None, store=None):
        self.cfg = cfg
        self.client = client or DeltaClient(
            cfg.api.base_url, cfg.api.request_timeout_sec, cfg.api.max_retries)
        self.strategy = Strategy(cfg)
        self.fills = FillEngine(cfg.fills)
        self.store = store if store is not None else build_store()
        try:
            self.store.start_run(cfg.run_name, cfg.to_dict(),
                                 cfg.portfolio.starting_cash)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not register run in Supabase: %s", exc)
        self.portfolio = Portfolio(cfg.portfolio, cfg.data_dir, cfg.run_name,
                                   store=self.store)
        self.atr_gate = AtrGate(
            self.client, cfg.atr.candle_symbol, cfg.atr.resolution,
            cfg.atr.period, cfg.atr.min_atr, cfg.atr.refresh_sec, cfg.atr.enabled)

        self._products: List[Dict] = []
        self._products_at: float = 0.0
        self._seen_rounds: set = set()
        self._logged_rejects: set = set()
        self._expiry_by_symbol: Dict[str, datetime] = {}

    # ---- data -----------------------------------------------------------
    def _refresh_products(self, now_ts: float) -> List[Dict]:
        """Products carry launch_time (absent from tickers); refresh sparingly."""
        if not self._products or (now_ts - self._products_at) > 60:
            try:
                self._products = self.client.live_binary_products()
                self._products_at = now_ts
            except Exception as exc:  # noqa: BLE001
                log.warning("product refresh failed: %s", exc)
        return self._products

    def _book(self, symbol: str):
        if self.cfg.fills.model != "orderbook":
            return None
        try:
            return self.client.orderbook(symbol)
        except Exception as exc:  # noqa: BLE001
            log.warning("orderbook fetch failed for %s: %s", symbol, exc)
            return None

    # ---- settlement -----------------------------------------------------
    def settle_expired(self, live_symbols: set, now: datetime) -> None:
        """Positions whose round has expired no longer appear in the live feed;
        close them at the venue's published settlement price."""
        for pos in list(self.portfolio.open_positions):
            if pos.symbol in live_symbols:
                continue
            price = self.client.settlement_price(pos.symbol)
            if price is None:
                log.debug("settlement for %s not published yet", pos.symbol)
                continue
            self.portfolio.settle_position(pos, price, now)

    # ---- exits ----------------------------------------------------------
    def manage_exits(self, by_symbol: Dict[str, Contract], now: datetime) -> None:
        for pos in list(self.portfolio.open_positions):
            contract = by_symbol.get(pos.symbol)
            if contract is None:
                continue
            spot = contract.spot_price
            should, reason = self.strategy.should_exit(pos, contract, spot)

            if not should and self.cfg.exit.flatten_before_expiry_sec is not None:
                rnd_expiry = self._expiry_by_symbol.get(pos.symbol)
                if rnd_expiry is not None:
                    tte = (rnd_expiry - now).total_seconds()
                    if tte <= self.cfg.exit.flatten_before_expiry_sec:
                        should, reason = True, "flatten %.0fs before expiry" % tte

            if not should:
                continue

            book = self._book(pos.symbol) if self.cfg.fills.refetch_book_on_execute else None
            fill = self.fills.simulate("sell", pos.qty, book,
                                       contract.best_bid, contract.best_ask,
                                       contract.mark_price)
            if not fill.filled:
                log.warning("exit blocked for %s: %s", pos.symbol, fill.reason)
                self.portfolio.log_event("exit_blocked", symbol=pos.symbol,
                                         reason=fill.reason, intended=reason)
                continue
            self.portfolio.close_position(pos, fill, now, reason)

    # ---- entries --------------------------------------------------------
    def try_enter(self, rnd: Round, now: datetime, atr_ok: bool,
                  atr: Optional[float]) -> None:
        if self.cfg.entry.one_entry_per_round and self.portfolio.has_round(rnd.round_id):
            return
        if len(self.portfolio.open_rounds()) >= self.cfg.portfolio.max_concurrent_rounds:
            return

        decision = self.strategy.evaluate(rnd, now, atr_ok, atr)
        if not decision.enter:
            key = (rnd.round_id, "|".join(decision.reasons))
            if key not in self._logged_rejects:
                self._logged_rejects.add(key)
                log.info("SKIP   %-18s %s", rnd.round_id, "; ".join(decision.reasons))
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=decision.reasons, atr=atr,
                                         spot=decision.spot)
            return

        legs = [l for l in decision.legs if l.ok]
        qty = self.cfg.entry.size_contracts

        # Price every leg first; with require_both_wings, a round is all-or-nothing,
        # so a leg that cannot fill must not leave the other one on naked.
        planned = []
        for leg in legs:
            ok, why = self.fills.spread_ok(leg.contract.best_bid, leg.contract.best_ask)
            if not ok:
                log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, why)
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=["%s %s" % (leg.role, why)])
                if self.cfg.entry.require_both_wings:
                    return
                continue
            book = self._book(leg.contract.symbol)
            fill = self.fills.simulate("buy", qty, book, leg.contract.best_bid,
                                       leg.contract.best_ask, leg.contract.mark_price)
            if not fill.filled:
                log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, fill.reason)
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=["%s %s" % (leg.role, fill.reason)])
                if self.cfg.entry.require_both_wings:
                    return
                continue
            # Slippage can push the real fill past the odds threshold even when
            # the touch price passed. Re-test against what we would actually pay.
            if fill.avg_price > leg.max_price:
                msg = "slippage broke odds: avg %.4f > max %.4f" % (
                    fill.avg_price, leg.max_price)
                log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, msg)
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=["%s %s" % (leg.role, msg)])
                if self.cfg.entry.require_both_wings:
                    return
                continue
            planned.append((leg, fill))

        if not planned:
            return

        cap = self.cfg.portfolio.max_cost_per_round
        total = sum(f.qty * f.avg_price for _, f in planned)
        if cap is not None and total > cap:
            log.info("SKIP   %-18s cost %.2f exceeds cap %.2f", rnd.round_id, total, cap)
            self.portfolio.log_event("skip", round_id=rnd.round_id,
                                     reasons=["cost %.2f > cap %.2f" % (total, cap)])
            return
        if total > self.portfolio.cash:
            log.info("SKIP   %-18s cost %.2f exceeds cash %.2f",
                     rnd.round_id, total, self.portfolio.cash)
            return

        for leg, fill in planned:
            self.portfolio.open_position(
                rnd.round_id, leg.contract.symbol, leg.role, leg.contract.side,
                leg.contract.strike, fill, now, decision.spot, atr)

    # ---- main loop ------------------------------------------------------
    def poll_once(self) -> None:
        now_ts = time.time()
        now = datetime.now(timezone.utc)

        tickers = self.client.binary_tickers()
        products = self._refresh_products(now_ts)
        rounds = build_rounds(tickers, self.cfg.api.underlying, products)

        by_symbol: Dict[str, Contract] = {}
        self._expiry_by_symbol: Dict[str, datetime] = {}
        for rnd in rounds:
            for c in rnd.contracts:
                by_symbol[c.symbol] = c
                self._expiry_by_symbol[c.symbol] = rnd.expiry

        self.settle_expired(set(by_symbol), now)
        self.manage_exits(by_symbol, now)

        atr_ok, atr = self.atr_gate.passes(now_ts)

        for rnd in rounds:
            if rnd.round_id not in self._seen_rounds:
                self._seen_rounds.add(rnd.round_id)
                log.info("ROUND  %-18s strikes=%s expiry=%s spot=%s",
                         rnd.round_id, rnd.strikes,
                         rnd.expiry.strftime("%H:%M:%SZ"), rnd.spot)
            if rnd.seconds_to_expiry(now) <= 0:
                continue
            self.try_enter(rnd, now, atr_ok, atr)

        self._publish_snapshot(rounds, now, atr_ok, atr)

    # ---- dashboard feed -------------------------------------------------
    def _leg_payload(self, leg: Optional[Contract], max_price: float) -> Optional[Dict]:
        if leg is None:
            return None
        ask = leg.best_ask
        return {
            "symbol": leg.symbol, "side": leg.side, "strike": leg.strike,
            "bid": leg.best_bid, "ask": ask, "mark": leg.mark_price,
            "bid_size": leg.bid_size, "ask_size": leg.ask_size,
            "max_price": round(max_price, 4),
            "qualifies": bool(ask is not None and ask <= max_price),
        }

    def _publish_snapshot(self, rounds: List[Round], now: datetime,
                          atr_ok: bool, atr: Optional[float]) -> None:
        """Push what the engine currently sees so the dashboard can render it."""
        payload: List[Dict] = []
        spot = None
        for rnd in rounds:
            if rnd.seconds_to_expiry(now) <= 0:
                continue
            spot = rnd.spot if spot is None else spot
            wings = rnd.wing_legs()
            mids = rnd.middle_legs()
            decision = self.strategy.evaluate(rnd, now, atr_ok, atr)
            payload.append({
                "round_id": rnd.round_id,
                "expiry": rnd.expiry.isoformat(),
                "seconds_to_expiry": round(rnd.seconds_to_expiry(now)),
                "seconds_since_launch": (
                    round(rnd.seconds_since_launch(now))
                    if rnd.seconds_since_launch(now) is not None else None),
                "strikes": rnd.strikes,
                "spot": rnd.spot,
                "would_enter": decision.enter,
                "reasons": decision.reasons,
                "wing_low": self._leg_payload(wings["low"], self.cfg.wing_max_price),
                "wing_high": self._leg_payload(wings["high"], self.cfg.wing_max_price),
                "middle_call": self._leg_payload(mids["call"], self.cfg.middle_max_price),
                "middle_put": self._leg_payload(mids["put"], self.cfg.middle_max_price),
            })
        try:
            self.store.snapshot(spot, atr, atr_ok, payload)
            self.store.heartbeat(self.portfolio.cash)
        except Exception as exc:  # noqa: BLE001
            log.debug("snapshot publish failed: %s", exc)

    def run(self, max_iterations: Optional[int] = None,
            duration_sec: Optional[float] = None) -> None:
        started = time.time()
        iterations = 0
        log.info("paper engine starting | cash=%.2f | wing<=%.4f middle<=%.4f | "
                 "ATR>%.0f on %s %s | exit=%s | fills=%s",
                 self.portfolio.cash, self.cfg.wing_max_price,
                 self.cfg.middle_max_price, self.cfg.atr.min_atr,
                 self.cfg.atr.candle_symbol, self.cfg.atr.resolution,
                 self.cfg.exit.mode, self.cfg.fills.model)
        try:
            while True:
                if max_iterations is not None and iterations >= max_iterations:
                    break
                if duration_sec is not None and (time.time() - started) >= duration_sec:
                    break
                try:
                    self.poll_once()
                except Exception as exc:  # noqa: BLE001 - keep the loop alive
                    log.exception("poll failed: %s", exc)
                iterations += 1
                time.sleep(self.cfg.api.poll_interval_sec)
        except KeyboardInterrupt:
            log.info("interrupted by user")
        finally:
            try:
                self.store.finish_run(self.portfolio.cash)
            except Exception as exc:  # noqa: BLE001
                log.debug("finish_run failed: %s", exc)
