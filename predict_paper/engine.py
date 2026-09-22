"""Live paper-trading loop.

Read-only against the venue: it polls public market data, simulates fills
against the real order book, and keeps its own ledger. It never authenticates
and never places an order.
"""
from __future__ import annotations

import copy
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


def index_symbol_for(asset: str) -> str:
    """Delta's spot index for an asset.

    The gate has to measure the volatility of the thing being traded: an ETH
    strategy reading BTC's ATR is gated on a number that has nothing to do
    with it.
    """
    return {"BTC": ".DEXBTUSDT", "ETH": ".DEETHUSDT"}.get(
        asset.upper(), ".DE%sUSDT" % asset.upper())


def _top_of_book(book, side: str):
    """Best price actually resting in the book.

    The ticker feed lags the book by seconds, which matters here because the
    fill walks the book: quoting one and filling from the other turns latency
    into phantom slippage.
    """
    levels = (book or {}).get("sell" if side == "buy" else "buy") or []
    prices = []
    for lvl in levels:
        try:
            price = float(lvl["price"])
        except (KeyError, TypeError, ValueError):
            continue
        if price > 0:
            prices.append(price)
    if not prices:
        return None
    return min(prices) if side == "buy" else max(prices)


class AccountStrategy:
    """One account's rules, and the machinery that runs them.

    Each account gets its own Config copy rather than a reference, so editing
    one account's odds in the dashboard cannot move another's. The ATR gate is
    per account too: two accounts may watch different resolutions or periods,
    and a shared gate would hand one of them the other's reading.
    """

    def __init__(self, account_id: int, cfg, client):
        self.account_id = account_id
        self.cfg = cfg
        self.name = str(account_id)
        self.balance = 0.0
        self.strategy = Strategy(cfg)
        self.atr_gate = AtrGate(
            client, cfg.atr.candle_symbol, cfg.atr.resolution, cfg.atr.period,
            cfg.atr.min_atr, cfg.atr.refresh_sec, cfg.atr.enabled)
        self._atr_key = (cfg.atr.resolution, cfg.atr.period, cfg.atr.min_atr,
                         cfg.atr.enabled, cfg.atr.candle_symbol)
        self.stamp = None

    def rebuild_gate_if_needed(self, client) -> None:
        """The gate caches candles against its resolution and period."""
        key = (self.cfg.atr.resolution, self.cfg.atr.period, self.cfg.atr.min_atr,
               self.cfg.atr.enabled, self.cfg.atr.candle_symbol)
        if key != self._atr_key:
            self._atr_key = key
            self.atr_gate = AtrGate(
                client, self.cfg.atr.candle_symbol, self.cfg.atr.resolution,
                self.cfg.atr.period, self.cfg.atr.min_atr,
                self.cfg.atr.refresh_sec, self.cfg.atr.enabled)


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
        # Positions live in memory, so anything still open when the last worker
        # stopped is stranded until someone picks it up. Try before the first
        # poll, and keep trying - see maybe_adopt.
        self._adopt_at: float = 0.0
        # Open positions held by ANY worker, keyed two ways: by symbol so a
        # restart does not re-buy a leg it already holds, and by round so the
        # both-wings rule knows a leg arrived on an earlier tick.
        self._held_symbols: set = set()
        self._held_roles: dict = {}
        self.maybe_adopt(time.time())
        self.atr_gate = AtrGate(
            self.client, cfg.atr.candle_symbol, cfg.atr.resolution,
            cfg.atr.period, cfg.atr.min_atr, cfg.atr.refresh_sec, cfg.atr.enabled)

        self._products: List[Dict] = []
        self._products_at: float = 0.0
        self._seen_rounds: set = set()
        self._logged_rejects: set = set()
        self._expiry_by_symbol: Dict[str, datetime] = {}
        # Last spot seen per symbol, so a settled position can report the
        # underlying price that produced its outcome.
        self._last_spot: Dict[str, float] = {}
        self._halt_logged: set = set()
        self._config_at: float = 0.0
        # account_id -> AccountStrategy. Empty until the first refresh,
        # and the bot opens nothing while it is empty.
        self.accounts: Dict[int, AccountStrategy] = {}

    # ---- remote settings --------------------------------------------------
    def _num(self, row, key, default=None):
        v = row.get(key)
        return default if v is None else float(v)

    def refresh_remote_config(self, now_ts: float) -> None:
        """Rebuild each account's rules from the dashboard.

        config.yaml stays the boot default and the template every account
        starts from; these rows are the live overrides. A failed read leaves
        the running strategies alone, because resetting them because of a
        network blip would be worse than running them stale.
        """
        every = self.cfg.config_refresh_sec
        if not every or (now_ts - self._config_at) < every:
            return
        self._config_at = now_ts

        rows = self.store.strategy_configs()
        if rows is None:
            return
        balances = {a["id"]: a for a in (self.store.accounts() or [])}

        seen = set()
        for row in rows:
            aid = row.get("account_id")
            if aid is None:
                continue
            seen.add(aid)

            acct = self.accounts.get(aid)
            if acct is None:
                # A copy, so one account's edits cannot reach another's rules.
                acct = AccountStrategy(aid, copy.deepcopy(self.cfg), self.client)
                self.accounts[aid] = acct

            self._apply_row(acct.cfg, row)
            acct.strategy = Strategy(acct.cfg)
            acct.rebuild_gate_if_needed(self.client)

            info = balances.get(aid) or {}
            acct.name = info.get("name") or str(aid)
            acct.balance = float(info.get("balance") or 0.0)

            stamp = row.get("updated_at")
            if stamp != acct.stamp:
                acct.stamp = stamp
                c = acct.cfg
                log.info("settings %-16s %-8s | %s | ATR>%.0f %s p%d | wing 1:%.0f "
                         "| exit %s/%s | $%.0f/leg | bal %.2f",
                         acct.name, "ARMED" if c.enabled else "DISARMED",
                         ("session %s" % c.timing.sessions[0]) if c.timing.sessions
                         else "all hours",
                         c.atr.min_atr, c.atr.resolution, c.atr.period,
                         c.entry.wing_odds, c.exit.mode, c.exit.moneyness_trigger,
                         c.entry.investment_per_leg, acct.balance)

        # An account deleted in the dashboard stops trading here too.
        for gone in set(self.accounts) - seen:
            log.info("account %s removed - no longer trading it", gone)
            self.accounts.pop(gone, None)

    def _apply_row(self, c, row: Dict) -> None:
        """Lay one settings row over a Config."""
        c.enabled = bool(row.get("enabled", c.enabled))
        c.api.underlying = row.get("underlying") or c.api.underlying
        c.atr.candle_symbol = index_symbol_for(c.api.underlying)

        c.atr.enabled = bool(row.get("atr_enabled", c.atr.enabled))
        c.atr.resolution = row.get("atr_resolution") or c.atr.resolution
        c.atr.period = int(row.get("atr_period") or c.atr.period)
        c.atr.min_atr = self._num(row, "atr_min", c.atr.min_atr)

        start, end = row.get("session_start"), row.get("session_end")
        c.timing.sessions = ["%s-%s" % (str(start)[:5], str(end)[:5])]             if start and end else []
        c.timing.session_timezone = row.get("session_timezone") or c.timing.session_timezone
        days = row.get("weekdays")
        if days:
            c.timing.weekdays = [int(d) for d in days]
        for key in ("min_seconds_since_launch", "max_seconds_since_launch",
                    "min_seconds_to_expiry", "max_seconds_to_expiry"):
            setattr(c.timing, key, self._num(row, key, getattr(c.timing, key)))

        c.entry.odds_convention = row.get("odds_convention") or c.entry.odds_convention
        c.entry.wing_odds = self._num(row, "wing_odds", c.entry.wing_odds)
        c.entry.middle_odds = self._num(row, "middle_odds", c.entry.middle_odds)
        c.entry.trade_wings = bool(row.get("trade_wings", c.entry.trade_wings))
        c.entry.require_both_wings = bool(
            row.get("require_both_wings", c.entry.require_both_wings))
        c.entry.trade_middle = bool(row.get("trade_middle", c.entry.trade_middle))
        c.entry.extremes_mode = row.get("extremes_mode") or c.entry.extremes_mode
        c.entry.middle_needs_both_wings = bool(
            row.get("middle_needs_both_wings", c.entry.middle_needs_both_wings))
        c.entry.investment_per_leg = self._num(
            row, "investment_per_leg", c.entry.investment_per_leg)
        c.entry.max_slippage = self._num(row, "max_slippage", c.entry.max_slippage)

        c.exit.mode = row.get("exit_mode") or c.exit.mode
        c.exit.moneyness_trigger = row.get("exit_trigger") or c.exit.moneyness_trigger
        c.exit.spot_points_itm = self._num(row, "exit_points", c.exit.spot_points_itm)
        c.exit.atm_band_points = self._num(row, "exit_atm_band", c.exit.atm_band_points)
        c.exit.take_profit_price = self._num(row, "take_profit_price",
                                             c.exit.take_profit_price)
        c.exit.stop_loss_price = self._num(row, "stop_loss_price", c.exit.stop_loss_price)
        c.exit.flatten_before_expiry_sec = self._num(
            row, "flatten_before_expiry_sec", c.exit.flatten_before_expiry_sec)

        c.portfolio.max_concurrent_rounds = int(
            row.get("max_concurrent_rounds") or c.portfolio.max_concurrent_rounds)
        c.portfolio.max_cost_per_round = self._num(
            row, "max_cost_per_round", c.portfolio.max_cost_per_round)

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
            self.portfolio.settle_position(
                pos, price, now, self._last_spot.get(pos.symbol))

    # ---- recovery -------------------------------------------------------
    def maybe_adopt(self, now_ts: float) -> None:
        """Take over positions no live worker is managing.

        Retried on a timer rather than only at startup. A worker that replaces
        another cleanly starts while the outgoing heartbeat is still seconds
        old, so the positions are correctly *not* adopted at that moment - and
        with a startup-only sweep nobody ever came back for them once the old
        run went quiet. A tidy restart stranded exactly the positions this is
        supposed to rescue.
        """
        if not self.cfg.recover_open_positions:
            return
        if (now_ts - self._adopt_at) < self.cfg.adopt_stale_after_sec:
            return
        self._adopt_at = now_ts

        keys = self.store.open_round_keys()
        if keys is not None:
            self._held_symbols = {
                (k.get("account_id"), k.get("symbol")) for k in keys}
            roles: dict = {}
            for k in keys:
                roles.setdefault((k.get("account_id"), k.get("round_id")),
                                 set()).add(k.get("role"))
            self._held_roles = roles

        try:
            rows = self.store.adoptable_positions(self.cfg.adopt_stale_after_sec)
            n = self.portfolio.adopt(rows)
            if n:
                log.info("adopted %d open position(s) no live worker was managing", n)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not recover open positions: %s", exc)

    # ---- whose rules apply --------------------------------------------
    def _cfg_for(self, pos):
        acct = self.accounts.get(getattr(pos, "account_id", None))
        return acct.cfg if acct else self.cfg

    def _strategy_for(self, pos):
        acct = self.accounts.get(getattr(pos, "account_id", None))
        return acct.strategy if acct else self.strategy

    # ---- exits ----------------------------------------------------------
    def manage_exits(self, by_symbol: Dict[str, Contract], now: datetime) -> None:
        for pos in list(self.portfolio.open_positions):
            contract = by_symbol.get(pos.symbol)
            if contract is None:
                continue
            # Trading halts before expiry, so a position that has not exited by
            # then is carried into settlement whether we like it or not.
            expiry = self._expiry_by_symbol.get(pos.symbol)
            if expiry is not None:
                tte = (expiry - now).total_seconds()
                if tte <= self.cfg.timing.trading_halt_sec:
                    if pos.symbol not in self._halt_logged:
                        self._halt_logged.add(pos.symbol)
                        log.info("HALT   %-28s %.0fs to expiry - holding to settlement",
                                 pos.symbol, tte)
                    continue

            # A position is judged by the rules of the account that opened it,
            # not by whichever account was edited last. One without an account
            # - a legacy bot entry, or a manual trade placed before accounts
            # existed - falls back to config.yaml.
            cfg = self._cfg_for(pos)

            spot = contract.spot_price
            should, reason = self._strategy_for(pos).should_exit(pos, contract, spot)

            # A flatten scheduled inside the halt window can never execute; the
            # branch above has already skipped those, so this only fires while
            # trading is still open. Manual positions are exempt for the same
            # reason they are exempt from take-profit: the user owns the exit.
            manual = pos.role == "manual" and not cfg.exit.apply_to_manual
            if not should and not manual                     and cfg.exit.flatten_before_expiry_sec is not None:
                rnd_expiry = self._expiry_by_symbol.get(pos.symbol)
                if rnd_expiry is not None:
                    tte = (rnd_expiry - now).total_seconds()
                    if tte <= cfg.exit.flatten_before_expiry_sec:
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
    def try_enter(self, acct: "AccountStrategy", rnd: Round, now: datetime,
                  atr_ok: bool, atr: Optional[float]) -> None:
        cfg = acct.cfg
        aid = acct.account_id
        # Roles already on in this round, from memory and from the table: a
        # leg bought ten minutes ago still counts toward the both-wings rule.
        held = set(self._held_roles.get((aid, rnd.round_id), set()))
        held |= {p.role for p in self.portfolio.open_positions
                 if p.round_id == rnd.round_id and p.account_id == aid}

        # The cap counts rounds we are not already in.
        if (rnd.round_id not in self.portfolio.open_rounds(aid)
                and len(self.portfolio.open_rounds(aid))
                >= cfg.portfolio.max_concurrent_rounds):
            return

        decision = acct.strategy.evaluate(rnd, now, atr_ok, atr, held=held)
        if not decision.enter:
            key = (rnd.round_id, "|".join(decision.reasons))
            if key not in self._logged_rejects:
                self._logged_rejects.add(key)
                log.info("SKIP   %-18s %s", rnd.round_id, "; ".join(decision.reasons))
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=decision.reasons, atr=atr,
                                         spot=decision.spot)
            return

        legs = [l for l in decision.legs if l.ok
                and (aid, l.contract.symbol) not in self._held_symbols
                and l.role not in held]
        if not legs:
            return

        def size_for(leg) -> int:
            """Contracts to buy on this leg, from a dollar budget.

            Converted at the leg's own price rather than once for the round:
            the two wings are rarely priced alike, so a single count would put
            very different money on each. Same arithmetic the ticket uses.
            """
            price = leg.quoted_price
            if not price or price <= 0:
                return 0
            return int(round(cfg.entry.investment_per_leg / price))

        # Price every leg first; with require_both_wings, a round is all-or-nothing,
        # so a leg that cannot fill must not leave the other one on naked.
        planned = []
        for leg in legs:
            ok, why = self.fills.spread_ok(leg.contract.best_bid, leg.contract.best_ask)
            if not ok:
                log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, why)
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=["%s %s" % (leg.role, why)])
                if cfg.entry.require_both_wings:
                    return
                continue
            qty = size_for(leg)
            if qty < 1:
                log.info("SKIP   %-18s %s: size rounds to zero at %.4f",
                         rnd.round_id, leg.role, leg.quoted_price or 0.0)
                if cfg.entry.require_both_wings:
                    return
                continue

            book = self._book(leg.contract.symbol)
            fill = self.fills.simulate("buy", qty, book, leg.contract.best_bid,
                                       leg.contract.best_ask, leg.contract.mark_price)
            if not fill.filled:
                log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, fill.reason)
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=["%s %s" % (leg.role, fill.reason)])
                if cfg.entry.require_both_wings:
                    return
                continue
            cap = cfg.entry.max_slippage
            if cap is not None and leg.quoted_price is not None                     and (fill.avg_price - leg.quoted_price) > cap:
                msg = "slippage %.4f exceeds cap %.4f" % (
                    fill.avg_price - leg.quoted_price, cap)
                log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, msg)
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=["%s %s" % (leg.role, msg)])
                if cfg.entry.require_both_wings:
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
                if cfg.entry.require_both_wings:
                    return
                continue
            planned.append((leg, fill))

        if not planned:
            return

        cap = cfg.portfolio.max_cost_per_round
        total = sum(f.qty * f.avg_price for _, f in planned)
        if cap is not None and total > cap:
            log.info("SKIP   %-18s cost %.2f exceeds cap %.2f", rnd.round_id, total, cap)
            self.portfolio.log_event("skip", round_id=rnd.round_id,
                                     reasons=["cost %.2f > cap %.2f" % (total, cap)])
            return
        if total > acct.balance:
            log.info("SKIP   %-18s %s: cost %.2f exceeds balance %.2f",
                     rnd.round_id, acct.name, total, acct.balance)
            return

        for leg, fill in planned:
            # Tagged with the account, so the trade debits and credits that
            # balance and shows up in its portfolio. Bot entries used to carry
            # no account at all, which left them invisible in a panel that
            # filters by one.
            self.portfolio.open_position(
                rnd.round_id, leg.contract.symbol, leg.role, leg.contract.side,
                leg.contract.strike, fill, now, decision.spot, atr,
                account_id=aid)
            self._held_symbols.add((aid, leg.contract.symbol))
            self._held_roles.setdefault((aid, rnd.round_id), set()).add(leg.role)

    # ---- manual orders from the trade panel -----------------------------
    def process_manual_orders(self, by_symbol: Dict[str, Contract],
                              now: datetime, atr: Optional[float]) -> None:
        """Execute orders queued by the trade panel.

        The browser can only record an intent (dollar amount + the price it was
        shown). The fill is simulated here against real depth, so a manual paper
        trade is exactly as honest as a bot entry.
        """
        orders = self.store.pending_manual_orders()
        if not orders:
            return

        for order in orders:
            if (order.get("action") or "buy") == "close":
                self._close_manual_order(order, by_symbol, now)
                continue

            oid = order.get("id")
            symbol = order.get("symbol")
            contract = by_symbol.get(symbol)

            if contract is None:
                self.store.resolve_manual_order(
                    oid, "rejected",
                    reject_reason="market no longer live (expired or delisted)")
                log.info("MANUAL rejected %s: not live", symbol)
                continue

            expiry = self._expiry_by_symbol.get(symbol)
            if expiry is not None:
                tte = (expiry - now).total_seconds()
                if tte <= self.cfg.timing.trading_halt_sec:
                    self.store.resolve_manual_order(
                        oid, "rejected",
                        reject_reason="trading halted for the final %.0fs "
                                      "(%.0fs to expiry)"
                                      % (self.cfg.timing.trading_halt_sec, tte))
                    log.info("MANUAL rejected %s: trading halted", symbol)
                    continue

            if self.portfolio.position_for(symbol) is not None:
                self.store.resolve_manual_order(
                    oid, "rejected", reject_reason="already holding this contract")
                continue

            # Size off the book, not the ticker. /v2/tickers trails
            # /v2/l2orderbook by seconds, so sizing from `best_ask` produced a
            # contract count for a price that no longer existed - and then the
            # slippage check measured that feed lag rather than real depth and
            # rejected orders that would have filled.
            book = self._book(symbol)
            ask = _top_of_book(book, "buy") or contract.best_ask
            if ask is None or ask <= 0:
                self.store.resolve_manual_order(
                    oid, "rejected", reject_reason="no ask quoted")
                continue

            # Delta's panel sizes by dollars: contracts = round(investment / price),
            # each paying 1.00 if correct. Verified against the app's own numbers.
            investment = float(order.get("investment") or 0)
            qty = round(investment / ask)
            if qty < 1:
                self.store.resolve_manual_order(
                    oid, "rejected",
                    reject_reason="investment $%.2f too small at price %.4f"
                                  % (investment, ask))
                continue

            fill = self.fills.simulate("buy", qty, book, contract.best_bid,
                                       contract.best_ask, contract.mark_price)
            if not fill.filled:
                self.store.resolve_manual_order(
                    oid, "rejected", reject_reason=fill.reason)
                log.info("MANUAL rejected %s: %s", symbol, fill.reason)
                continue

            # Honour the panel's slippage tolerance against the price the user
            # was actually shown, not against the current touch.
            quoted = order.get("quoted_price")
            tol = float(order.get("slippage_tolerance") or 0)
            if quoted is not None:
                drift = fill.avg_price - float(quoted)
                if drift > tol:
                    self.store.resolve_manual_order(
                        oid, "rejected",
                        reject_reason="slippage $%.4f exceeds tolerance $%.2f "
                                      "(quoted %.4f, fill %.4f)"
                                      % (drift, tol, float(quoted), fill.avg_price))
                    log.info("MANUAL rejected %s: slippage %.4f > %.2f",
                             symbol, drift, tol)
                    continue

            cost = fill.qty * fill.avg_price
            if cost > self.portfolio.cash:
                self.store.resolve_manual_order(
                    oid, "rejected",
                    reject_reason="cost $%.2f exceeds cash $%.2f"
                                  % (cost, self.portfolio.cash))
                continue

            account_id = order.get("account_id")
            pos = self.portfolio.open_position(
                order.get("round_id") or "manual", symbol, "manual",
                contract.side, contract.strike, fill, now,
                contract.spot_price, atr, account_id=account_id)
            # open_position debits the account now; doing it again here would
            # charge twice for one fill.
            self.store.resolve_manual_order(
                oid, "filled", position_id=pos.position_id,
                fill_price=fill.avg_price, contracts=fill.qty)
            log.info("MANUAL filled %s qty=%.0f @ %.4f (quoted %s)",
                     symbol, fill.qty, fill.avg_price, quoted)

    def _close_manual_order(self, order: Dict, by_symbol: Dict[str, Contract],
                            now: datetime) -> None:
        """Sell an open position because the panel asked to close it.

        Priced the same way an entry is: walk the real book at execution time.
        A close is worth nothing as a paper result if the proceeds come from a
        mid quote the market would not have paid.
        """
        oid = order.get("id")
        target = order.get("close_position_id")
        pos = self.portfolio.open_position_by_id(target) if target else None

        if pos is None:
            # Either it already settled, or this worker was restarted and never
            # held it — open positions live in memory (see README).
            self.store.resolve_manual_order(
                oid, "rejected",
                reject_reason="no open position %s on this worker" % target)
            log.info("MANUAL close rejected %s: not held", target)
            return

        contract = by_symbol.get(pos.symbol)
        if contract is None:
            self.store.resolve_manual_order(
                oid, "rejected",
                reject_reason="market no longer live — it will settle instead")
            return

        expiry = self._expiry_by_symbol.get(pos.symbol)
        if expiry is not None:
            tte = (expiry - now).total_seconds()
            if tte <= self.cfg.timing.trading_halt_sec:
                self.store.resolve_manual_order(
                    oid, "rejected",
                    reject_reason="trading halted for the final %.0fs "
                                  "(%.0fs to expiry) — holding to settlement"
                                  % (self.cfg.timing.trading_halt_sec, tte))
                log.info("MANUAL close rejected %s: halted", pos.symbol)
                return

        bid = contract.best_bid
        if bid is None or bid <= 0:
            self.store.resolve_manual_order(
                oid, "rejected", reject_reason="no bid quoted — nothing to sell into")
            return

        book = self._book(pos.symbol)
        fill = self.fills.simulate("sell", pos.qty, book, contract.best_bid,
                                   contract.best_ask, contract.mark_price)
        if not fill.filled:
            self.store.resolve_manual_order(
                oid, "rejected", reject_reason=fill.reason)
            log.info("MANUAL close rejected %s: %s", pos.symbol, fill.reason)
            return

        # Slippage cuts the other way on a sale: the book pays less than the
        # touch, so the shortfall is what the tolerance has to cover.
        quoted = order.get("quoted_price")
        tol = float(order.get("slippage_tolerance") or 0)
        if quoted is not None:
            drift = float(quoted) - fill.avg_price
            if drift > tol:
                self.store.resolve_manual_order(
                    oid, "rejected",
                    reject_reason="slippage $%.4f exceeds tolerance $%.2f "
                                  "(quoted %.4f, fill %.4f)"
                                  % (drift, tol, float(quoted), fill.avg_price))
                log.info("MANUAL close rejected %s: slippage %.4f > %.2f",
                         pos.symbol, drift, tol)
                return

        # close_position credits the owning account through _finish().
        self.portfolio.close_position(pos, fill, now, "closed from panel")
        self.store.resolve_manual_order(
            oid, "filled", position_id=pos.position_id,
            fill_price=fill.avg_price, contracts=fill.qty)
        log.info("MANUAL closed %s qty=%.0f @ %.4f", pos.symbol, fill.qty,
                 fill.avg_price)

    # ---- main loop ------------------------------------------------------
    def poll_once(self) -> None:
        now_ts = time.time()
        now = datetime.now(timezone.utc)

        # Settings first, so everything below runs under the current rules.
        self.refresh_remote_config(now_ts)
        self.maybe_adopt(now_ts)

        tickers = self.client.binary_tickers()
        products = self._refresh_products(now_ts)
        # One round set per underlying any account trades, not one for the
        # worker. An account's `underlying` was being written to its own config
        # and then never read, so an ETH strategy quietly traded BTC.
        assets = {a.cfg.api.underlying for a in self.accounts.values()}
        assets.add(self.cfg.api.underlying)
        rounds_by_asset = {a: build_rounds(tickers, a, products) for a in assets}
        rounds = [r for rs in rounds_by_asset.values() for r in rs]

        by_symbol: Dict[str, Contract] = {}
        self._expiry_by_symbol: Dict[str, datetime] = {}
        for rnd in rounds:
            for c in rnd.contracts:
                by_symbol[c.symbol] = c
                self._expiry_by_symbol[c.symbol] = rnd.expiry
                if c.spot_price is not None:
                    self._last_spot[c.symbol] = c.spot_price

        self.settle_expired(set(by_symbol), now)
        self.manage_exits(by_symbol, now)

        atr_ok, atr = self.atr_gate.passes(now_ts)

        # Manual trades are not subject to the strategy's filters - the user
        # asked for them explicitly - but they are subject to the same fills.
        self.process_manual_orders(by_symbol, now, atr)

        for rnd in rounds:
            if rnd.round_id not in self._seen_rounds:
                self._seen_rounds.add(rnd.round_id)
                log.info("ROUND  %-18s strikes=%s expiry=%s spot=%s",
                         rnd.round_id, rnd.strikes,
                         rnd.expiry.strftime("%H:%M:%SZ"), rnd.spot)
            if rnd.seconds_to_expiry(now) <= 0:
                continue

            # Each armed account trades this round under its own rules, with
            # its own ATR reading - two accounts may watch different
            # resolutions. Disarmed stops new entries only; settlement, exits
            # and manual orders above have already run for every account.
            for acct in list(self.accounts.values()):
                if not acct.cfg.enabled:
                    continue
                if rnd.asset != acct.cfg.api.underlying:
                    continue
                ok, value = acct.atr_gate.passes(now_ts)
                self.try_enter(acct, rnd, now, ok, value)

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
                # Every instrument in the round, for the Predict-style trade panel.
                "legs": [
                    {"symbol": c.symbol, "side": c.side, "strike": c.strike,
                     "bid": c.best_bid, "ask": c.best_ask, "mark": c.mark_price,
                     "bid_size": c.bid_size, "ask_size": c.ask_size}
                    for c in sorted(rnd.contracts, key=lambda x: (x.strike, x.side))
                ],
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
