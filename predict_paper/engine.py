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
from .rounds import (Contract, Round, build_rounds, parse_symbol,
                     expiry_code_to_dt)
from .delta_auth import DeltaAuthClient, SETTLEMENT_ASSETS, check_connection
from .live import LiveExecutor, LiveFill, dry_run
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
        # Live accounts send orders to the exchange instead of filling against
        # a simulated book. `executor` is None until credentials are read.
        self.live = False
        self.executor = None
        self.strategy = Strategy(cfg)
        # Its own fill engine, holding a reference to this account's cfg.fills,
        # so a spread guard edited in the dashboard reaches the entry path.
        # Sharing the engine-level one silently ignored the per-account value.
        self.fills = FillEngine(cfg.fills)
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


WINGS = ("wing_low", "wing_high")

# With partial entry on, stop topping a leg up once it is this close to its
# target. The last few dollars buy a handful of contracts and cost a crossed
# spread to get, so chasing them writes a fill every tick for no real exposure.
# How often a live account's balance is re-read from the exchange. Often
# enough to be current on a screen, rare enough not to spend the rate limit
# on a number that changes only when something settles.
# How often the record is checked against the exchange's own view.
LIVE_RECONCILE_SEC = 60.0

LIVE_BALANCE_SEC = 30.0

TOPUP_FLOOR_FRAC = 0.10


def drop_orphan_middle(planned_roles, held_roles, needs_both):
    """Should the middle leg be dropped for want of its wings?

    Returns the missing wing roles, or () to keep it.

    `Strategy.evaluate` already applies this rule, but against quoted prices.
    Between that decision and the fill a wing can still be dropped for spread,
    depth or slippage, and when both go the middle is left standing on its own
    - which is a different trade from the one the rule allows.
    """
    if not needs_both or "middle" not in planned_roles:
        return ()
    have = set(planned_roles) | set(held_roles)
    return tuple(w for w in WINGS if w not in have)


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
        # Strikes this account has entered in a round, whether or not it still
        # holds them. A round has three strikes, so this is what caps it at
        # three entries: taking profit on a leg early does not put its strike
        # back on the market.
        self._held_strikes: dict = {}
        self.maybe_adopt(time.time())
        self.atr_gate = AtrGate(
            self.client, cfg.atr.candle_symbol, cfg.atr.resolution,
            cfg.atr.period, cfg.atr.min_atr, cfg.atr.refresh_sec, cfg.atr.enabled)

        # Live accounts already reported as skipped, so the line is logged once
        # rather than on every config refresh.
        self._skipped_live: set = set()
        self._balance_warned: set = set()
        self._creds_at: float = 0.0
        self._balance_at: float = 0.0
        self._reconcile_at: float = 0.0
        self._adopted_live: set = set()
        # Authenticated clients for live accounts, kept whether or not the
        # account is armed: the balance is worth showing even when nothing is
        # being sent.
        self._live_clients: Dict[int, Any] = {}
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

        # Nothing is re-read from an answer that did not arrive. Every account
        # fact below - paper or live, armed or not, what the balance is -
        # comes from this one call, and an empty result made all of them read
        # as "paper, not armed". A live account then took the simulated exit
        # path: it closed positions in this table that were never sold on the
        # exchange, reconciliation adopted them back, and the pair looped once
        # a minute booking profit that did not exist.
        account_rows = self.store.accounts()
        if not account_rows:
            log.warning("account read returned nothing - keeping the previous "
                        "settings rather than treating live accounts as paper")
            return
        balances = {a["id"]: a for a in account_rows}

        seen = set()
        for row in rows:
            aid = row.get("account_id")
            if aid is None:
                continue

            # A live account trades through the exchange or not at all. It
            # must never get a simulated fill that reads like a real one, so
            # one without its switch on is dropped rather than quietly paper
            # traded. Accounts predating migration 022 have no mode and are
            # paper, which is what they have always been.
            info = balances.get(aid)
            if info is None:
                # A settings row whose account is not in the list. Leaving it
                # alone is the only safe reading: assuming paper is what broke
                # live exits.
                seen.add(aid)
                continue
            mode = info.get("mode") or "paper"
            armed_live = bool(info.get("live_enabled"))
            if mode != "paper" and not armed_live:
                if aid not in self._skipped_live:
                    self._skipped_live.add(aid)
                    log.info("SKIP   account %s is live but not enabled - "
                             "nothing will be sent", info.get("name") or aid)
                self.accounts.pop(aid, None)
                continue
            self._skipped_live.discard(aid)

            seen.add(aid)

            acct = self.accounts.get(aid)
            if acct is None:
                # A copy, so one account's edits cannot reach another's rules.
                acct = AccountStrategy(aid, copy.deepcopy(self.cfg), self.client)
                self.accounts[aid] = acct

            self._apply_row(acct.cfg, row)
            acct.strategy = Strategy(acct.cfg)
            acct.rebuild_gate_if_needed(self.client)

            acct.name = info.get("name") or str(aid)
            acct.balance = float(info.get("balance") or 0.0)
            acct.live = mode != "paper"
            if acct.live:
                self._attach_executor(acct)

            stamp = row.get("updated_at")
            if stamp != acct.stamp:
                acct.stamp = stamp
                c = acct.cfg
                log.info("settings %-16s %-8s | %s %s | %s | ATR>%.0f %s p%d | "
                         "wing 1:%.0f %s (max %.4f) | exit %s/%s | $%.0f/leg | bal %.2f",
                         acct.name, "ARMED" if c.enabled else "DISARMED",
                         c.api.underlying,
                         c.entry.extremes_mode + ("+mid" if c.entry.trade_middle else ""),
                         ("session %s" % c.timing.sessions[0]) if c.timing.sessions
                         else "all hours",
                         c.atr.min_atr, c.atr.resolution, c.atr.period,
                         c.entry.wing_odds,
                         "both" if c.entry.require_both_wings else "either",
                         c.wing_max_price, c.exit.mode, c.exit.moneyness_trigger,
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
        # Out-of-range trading: off by default, and with its own odds because
        # the strike nearest spot is priced near the money.
        c.entry.trade_outside_range = bool(
            row.get("trade_outside_range", c.entry.trade_outside_range))
        c.entry.outside_odds = self._num(row, "outside_odds", c.entry.outside_odds)
        c.entry.investment_per_leg = self._num(
            row, "investment_per_leg", c.entry.investment_per_leg)
        c.entry.max_slippage = self._num(row, "max_slippage", c.entry.max_slippage)
        # One toggle, two places: the entry rule decides whether to size a leg
        # down and top it up later, and the fill model decides whether a book
        # too thin for the whole order fills what it has. Set apart they would
        # disagree, and a leg would be trimmed for price but refused for depth.
        c.entry.partial_entry = bool(
            row.get("partial_entry", c.entry.partial_entry))
        c.fills.allow_partial = c.entry.partial_entry
        # The one-sided-market guard. Per account so it can be measured:
        # it is the largest single brake on entries, and a skipped entry
        # leaves no outcome to judge it by.
        c.fills.max_spread_frac = self._num(
            row, "max_spread_frac", c.fills.max_spread_frac)

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

        keys = self.store.entered_round_keys()
        if keys is not None:
            self._held_symbols = {
                (k.get("account_id"), k.get("symbol")) for k in keys}
            roles: dict = {}
            strikes: dict = {}
            for k in keys:
                where = (k.get("account_id"), k.get("round_id"))
                roles.setdefault(where, set()).add(k.get("role"))
                if k.get("strike") is not None:
                    strikes.setdefault(where, set()).add(float(k["strike"]))
            self._held_roles = roles
            self._held_strikes = strikes

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

            owner = self.accounts.get(pos.account_id)
            live = owner is not None and getattr(owner, "live", False)

            if live:
                if owner.executor is None:
                    log.warning("exit blocked for %s: live account has no "
                                "credentials", pos.symbol)
                    continue
                # Sold into the bid, with the account's slippage tolerance as
                # the floor. A ceiling on a buy and a floor on a sell are the
                # same rule: never trade worse than the price the decision was
                # made at by more than the account allows.
                bid = contract.best_bid
                if bid is None or bid <= 0:
                    log.warning("exit blocked for %s: nothing bid", pos.symbol)
                    continue
                floor = bid
                if cfg.entry.max_slippage is not None:
                    floor = max(0.0001, bid - cfg.entry.max_slippage)
                fill = owner.executor.sell(
                    pos.symbol, int(pos.qty), floor, pos.round_id, pos.role)
                if fill.duplicate:
                    # Already flat on Delta. The exit has effectively
                    # happened; reconciliation will square the record rather
                    # than this guessing a price it did not get.
                    continue
                if fill.unconfirmed:
                    # The sale may have gone through. Closing the record on a
                    # guess would be wrong either way, and re-selling could
                    # close a position twice; left open for reconciliation,
                    # and it settles on the exchange regardless.
                    continue
            else:
                book = (self._book(pos.symbol)
                        if self.cfg.fills.refetch_book_on_execute else None)
                fill = self.fills.simulate("sell", pos.qty, book,
                                           contract.best_bid, contract.best_ask,
                                           contract.mark_price)

            if not fill.filled:
                log.warning("exit blocked for %s: %s", pos.symbol, fill.reason)
                self.portfolio.log_event("exit_blocked", symbol=pos.symbol,
                                         reason=fill.reason, intended=reason)
                continue

            try:
                self.portfolio.close_position(
                    pos, fill, now, reason, self._last_spot.get(pos.symbol))
            except Exception:  # noqa: BLE001
                # Same rule as on the way in: the sale happened, so a failure
                # to record it must not become a second sale next cycle.
                # reduce_only makes that harmless anyway, but the record is
                # what needs fixing, and loudly.
                log.exception(
                    "RECORD FAILED closing %s qty=%s @ %s - the sale happened "
                    "and is NOT in the table; reconcile by hand",
                    pos.symbol, fill.qty, fill.avg_price)

    def _open_leg(self, aid: Optional[int], round_id: str, symbol: str):
        """This account's open position on a contract, if it already holds one."""
        for p in self.portfolio.open_positions:
            if (p.account_id == aid and p.symbol == symbol
                    and p.round_id == round_id):
                return p
        return None

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

        held_syms = {s for (a, s) in self._held_symbols if a == aid}
        decision = acct.strategy.evaluate(rnd, now, atr_ok, atr, held=held,
                                          held_symbols=held_syms)
        if not decision.enter:
            key = (rnd.round_id, "|".join(decision.reasons))
            if key not in self._logged_rejects:
                self._logged_rejects.add(key)
                log.info("SKIP   %-18s %s", rnd.round_id, "; ".join(decision.reasons))
                self.portfolio.log_event("skip", round_id=rnd.round_id,
                                         reasons=decision.reasons, atr=atr,
                                         spot=decision.spot)
            return

        partial = cfg.entry.partial_entry
        target = cfg.entry.investment_per_leg

        def short_by(symbol: str) -> float:
            """Dollars still to put on this leg to reach the target."""
            pos = self._open_leg(aid, rnd.round_id, symbol)
            return target - (pos.qty * pos.entry_price if pos else 0.0)

        def wants_more(symbol: str) -> bool:
            """Is this leg worth another go on this tick?

            Three conditions. Partial entry has to be on; the position has to
            still be open; and the gap has to be big enough to be worth
            crossing a spread for. Without the floor a leg that landed at 99%
            of target would try again every two seconds for the rest of the
            round.

            The open check is what separates finishing an entry from starting
            a new one. Once a leg has been exited its strike is spent for the
            round, and topping up a position that no longer exists would buy
            the strike back at whatever price the exit just proved wrong.
            """
            if not partial:
                return False
            if self._open_leg(aid, rnd.round_id, symbol) is None:
                return False
            return short_by(symbol) >= TOPUP_FLOOR_FRAC * target

        # One entry per strike per round, which caps a round at its three
        # strikes. A leg that was taken and closed early is finished with:
        # the strike does not come back on the market because the position
        # left it. Under partial entry a leg still open and still short is a
        # different case - that is one entry not yet complete, not a second.
        entered = self._held_strikes.get((aid, rnd.round_id), set())
        legs = [l for l in decision.legs if l.ok
                and (((aid, l.contract.symbol) not in self._held_symbols
                      and l.role not in held
                      and float(l.contract.strike) not in entered)
                     or wants_more(l.contract.symbol))]
        if not legs:
            return

        def size_for(leg) -> int:
            """Contracts to buy on this leg, from a dollar budget.

            Converted at the leg's own price rather than once for the round:
            the two wings are rarely priced alike, so a single count would put
            very different money on each. Same arithmetic the ticket uses.

            On a top-up the budget is only what the leg is still short, so the
            small fills add up to the target rather than to a multiple of it.
            """
            price = leg.quoted_price
            if not price or price <= 0:
                return 0
            budget = short_by(leg.contract.symbol) if partial else target
            # Round DOWN, the way the venue's own ticket does. Checked against
            # Predict directly: $50 at $0.99 offers 50 contracts and "You
            # invest: $49.50", not 51 and $50.49; $50 at $0.072 offers 694 and
            # $49.97, not 695. The budget is a ceiling there, never a target
            # to be overshot for the sake of a nearer number.
            return int(budget / price)

        # Price every leg first; with require_both_wings, a round is all-or-nothing,
        # so a leg that cannot fill must not leave the other one on naked.
        planned = []
        for leg in legs:
            ok, why = acct.fills.spread_ok(leg.contract.best_bid, leg.contract.best_ask)
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

            # The budget is the constraint, always - not only under partial
            # entry. Predict's ticket asks for money, not for a contract
            # count: you name $50 and the contracts are whatever $50 buys.
            # Sizing from the quote and then letting the fill cost what it
            # costs inverts that, and it does not round to a near miss - a
            # leg quoted at 0.0970 walked to 0.1120 and spent $77.71 of a $50
            # budget, and one account put $100.55 on a $50 leg. Capping the
            # spend is not a feature of partial entry; it is what the setting
            # already claimed to mean.
            #
            # The price ceiling is the part that does belong to partial entry:
            # buying the slice of a leg that clears the odds and slippage
            # limits, rather than refusing the leg outright.
            ceiling = None
            if partial:
                ceiling = leg.max_price
                if cfg.entry.max_slippage is not None and leg.quoted_price is not None:
                    ceiling = min(ceiling,
                                  leg.quoted_price + cfg.entry.max_slippage)
            qty = int(acct.fills.trim_to_budget(
                "buy", qty, book, ceiling, short_by(leg.contract.symbol)))
            if qty < 1:
                msg = ("nothing fills within %.4f" % ceiling) if ceiling is not None                     else "the book cannot fill even $1 of this leg"
                key = (rnd.round_id, leg.role, msg)
                if key not in self._logged_rejects:
                    self._logged_rejects.add(key)
                    log.info("SKIP   %-18s %s: %s", rnd.round_id, leg.role, msg)
                    self.portfolio.log_event(
                        "skip", round_id=rnd.round_id,
                        reasons=["%s %s" % (leg.role, msg)])
                if cfg.entry.require_both_wings:
                    return
                continue
            if acct.live:
                # The decision is identical; only the fill differs. The limit
                # is the price the odds rule already approved, so the exchange
                # can only improve on it - never fill worse than the strategy
                # agreed to pay, which is what the slippage checks below would
                # otherwise have to catch after the money was spent.
                if acct.executor is None:
                    log.warning("SKIP   %-18s %s: live account has no credentials",
                                rnd.round_id, leg.role)
                    return
                ceiling_live = leg.max_price
                if cfg.entry.max_slippage is not None and leg.quoted_price is not None:
                    ceiling_live = min(ceiling_live,
                                       leg.quoted_price + cfg.entry.max_slippage)
                fill = acct.executor.buy(
                    leg.contract.symbol, int(qty), ceiling_live,
                    rnd.round_id, leg.role)
                if fill.unconfirmed:
                    # The order may be on the exchange. Treated as held so
                    # this round stops asking: without it the leg was retried
                    # every few seconds against a venue that was timing out,
                    # and only the deterministic client_order_id stopped a
                    # second one landing. Reconciliation adopts it if it did.
                    self._held_symbols.add((aid, leg.contract.symbol))
                    self._held_strikes.setdefault(
                        (aid, rnd.round_id), set()).add(float(leg.contract.strike))
                    if cfg.entry.require_both_wings:
                        return
                    continue
            else:
                fill = acct.fills.simulate("buy", qty, book, leg.contract.best_bid,
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

        # The middle rides along with a pair on the extremes, and that has
        # to hold at fill time, not only at decision time.
        # Everything below decides whether to KEEP a fill that has already
        # happened. On paper that is free - nothing was bought, so dropping a
        # leg from `planned` un-buys it. On a live account the order is on the
        # exchange and the money is gone, so dropping it only loses the
        # record: the position stays, nothing marks the leg held, and the next
        # tick buys it again. That is what bought one middle leg three times
        # over fifteen seconds. A fill that happened is recorded; the rules
        # below are for the book that can still be changed.
        if not acct.live:
            missing = drop_orphan_middle(
                [l.role for l, _ in planned], held, cfg.entry.middle_needs_both_wings)
            if missing:
                msg = ("middle dropped: needs both wings, %s did not fill"
                       % " and ".join(missing))
                log.info("SKIP   %-18s %s", rnd.round_id, msg)
                self.portfolio.log_event("skip", round_id=rnd.round_id, reasons=[msg])
                planned = [(l, f) for l, f in planned if l.role != "middle"]

        if not planned:
            return

        total = sum(f.qty * f.avg_price for _, f in planned)
        if acct.live:
            # Reported, not acted on. A cap breached by a fill that already
            # happened is something to know about, not a reason to pretend the
            # position does not exist.
            cap = cfg.portfolio.max_cost_per_round
            if cap is not None and total > cap:
                log.warning("LIVE   %-18s filled %.2f over the %.2f round cap - "
                            "recorded anyway, the order is on the exchange",
                            rnd.round_id, total, cap)
            missing = drop_orphan_middle(
                [l.role for l, _ in planned], held, cfg.entry.middle_needs_both_wings)
            if missing:
                log.warning("LIVE   %-18s middle filled without %s - recorded "
                            "anyway, it was bought", rnd.round_id,
                            " and ".join(missing))
        else:
            cap = cfg.portfolio.max_cost_per_round
            if cap is not None and total > cap:
                log.info("SKIP   %-18s cost %.2f exceeds cap %.2f",
                         rnd.round_id, total, cap)
                self.portfolio.log_event(
                    "skip", round_id=rnd.round_id,
                    reasons=["cost %.2f > cap %.2f" % (total, cap)])
                return
            if total > acct.balance:
                log.info("SKIP   %-18s %s: cost %.2f exceeds balance %.2f",
                         rnd.round_id, acct.name, total, acct.balance)
                return

        for leg, fill in planned:
            # Marked as held BEFORE it is recorded, and deliberately so. The
            # fill has already happened - on a live account the money is
            # spent - so the leg is held whether or not the bookkeeping that
            # follows succeeds. Recording first meant one missing attribute
            # threw mid-record, aborted the cycle before this line, and left
            # the next cycle believing the leg was never bought: it bought it
            # again, every few seconds, with real money. Fail towards not
            # trading, never towards trading twice.
            self._held_symbols.add((aid, leg.contract.symbol))
            self._held_roles.setdefault((aid, rnd.round_id), set()).add(leg.role)
            self._held_strikes.setdefault((aid, rnd.round_id), set()).add(
                float(leg.contract.strike))

            # Tagged with the account, so the trade debits and credits that
            # balance and shows up in its portfolio. Bot entries used to carry
            # no account at all, which left them invisible in a panel that
            # filters by one.
            try:
                existing = self._open_leg(aid, rnd.round_id, leg.contract.symbol)
                if existing is not None:
                    # A leg bought over several ticks is one position at the
                    # average of what was paid, not one position per fill.
                    self.portfolio.add_to_position(existing, fill, now)
                else:
                    self.portfolio.open_position(
                        rnd.round_id, leg.contract.symbol, leg.role,
                        leg.contract.side, leg.contract.strike, fill, now,
                        decision.spot, atr, account_id=aid)
            except Exception:  # noqa: BLE001
                # Contained to this leg. A position that exists on the
                # exchange but not in this table is a reconciliation problem;
                # letting the exception escape made it a repeat-buying one.
                log.exception(
                    "RECORD FAILED %s %s qty=%s @ %s - the fill happened and is "
                    "NOT in the table; reconcile by hand",
                    acct.name, leg.contract.symbol, fill.qty, fill.avg_price)

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

            # This path fills against a simulated book. On a live account that
            # would write a position for money that never moved - which then
            # shows as real on the screen and argues with reconciliation,
            # because Delta has never heard of it. Refused outright until
            # manual orders can be sent to the exchange properly.
            acct = self.accounts.get(order.get("account_id"))
            if acct is not None and getattr(acct, "live", False):
                self.store.resolve_manual_order(
                    oid, "rejected",
                    reject_reason="manual trades are not available on a live "
                                  "account yet - this would be a paper fill")
                log.info("MANUAL rejected %s: live account", symbol)
                continue

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
        self.portfolio.close_position(
            pos, fill, now, "closed from panel",
            self._last_spot.get(pos.symbol))
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
        self.verify_pending_credentials(now_ts)
        self.sync_live_balances(now_ts)
        self.reconcile_live_positions(now_ts)
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

    def _attach_executor(self, acct: "AccountStrategy") -> None:
        """Give a live account the means to place orders.

        Credentials are read once and kept: decrypting them on every cycle
        would put the secret through the wire far more often than it needs to
        be. A change of key resets the account's verification status, which is
        what brings this back through here.
        """
        if acct.executor is not None:
            return
        creds = self.store.credentials_decrypted(acct.account_id)
        if not creds or not creds.get("api_secret"):
            log.warning("LIVE   %s is enabled but has no usable credentials",
                        acct.name)
            return
        acct.executor = LiveExecutor(
            acct.account_id, acct.name, creds.get("api_key") or "",
            creds.get("api_secret") or "", creds.get("base_url") or "")
        log.info("LIVE   %s armed%s", acct.name,
                 " (DRY RUN - nothing will be sent)" if dry_run() else "")

    # ---- live credentials -----------------------------------------------
    def verify_pending_credentials(self, now_ts: float) -> None:
        """Prove any newly saved Delta credentials, from this host.

        Delta authorises by IP, and the whitelisted address is this machine's.
        The browser therefore cannot check its own work - a check made there
        would fail on perfectly good credentials and teach you to distrust a
        working setup. It asks instead, and this answers.

        Reads only: one call to /v2/wallet/balances. It cannot place an order.
        """
        if (now_ts - self._creds_at) < 10.0:
            return
        self._creds_at = now_ts

        # Checks staged by the create form, which has no account to hang
        # credentials on yet.
        for chk in self.store.claim_credential_checks():
            cid = chk.get("id")
            if not cid:
                continue
            res = check_connection(chk.get("api_key") or "",
                                   chk.get("api_secret") or "",
                                   chk.get("base_url") or "")
            self.store.set_credential_check(
                cid, "ok" if res.ok else "failed",
                res.balance, res.message, res.seen_ip)
            log.info("CHECK  staged credentials %s - %s",
                     "ok" if res.ok else "REJECTED", res.message)

        for row in self.store.credentials_awaiting_check():
            aid = row.get("account_id")
            if aid is None:
                continue
            self.store.set_verification(aid, "verifying")
            creds = self.store.credentials_decrypted(aid)
            if not creds or not creds.get("api_secret"):
                self.store.set_verification(
                    aid, "invalid", "credentials could not be read back")
                continue

            res = check_connection(
                creds.get("api_key") or "", creds.get("api_secret") or "",
                creds.get("base_url") or "")
            self.store.set_verification(
                aid, "verified" if res.ok else "invalid",
                "" if res.ok else res.message, res.seen_ip, res.balance)
            log.info("CREDS  account %s %s - %s", aid,
                     "verified" if res.ok else "REJECTED", res.message)

    def sync_live_balances(self, now_ts: float) -> None:
        """Keep a live account's balance equal to the exchange's figure.

        It used to move only when someone pressed Verify, so between presses
        the dashboard showed a number that had stopped being true the moment
        anything settled - and after a fill it was wrong in both directions
        at once, because this side debits a cost that Delta has already taken.

        A live balance is not ours to compute. It is read and written as-is,
        including funding, fees and settlements that happened with no
        involvement from this worker.

        Runs for every live account with usable credentials, armed or not: the
        figure is worth showing either way.
        """
        if (now_ts - self._balance_at) < LIVE_BALANCE_SEC:
            return
        self._balance_at = now_ts

        for row in (self.store.accounts() or []):
            if (row.get("mode") or "paper") == "paper":
                continue
            aid = row.get("id")
            if aid is None:
                continue

            client = self._live_clients.get(aid)
            if client is None:
                creds = self.store.credentials_decrypted(aid)
                if not creds or not creds.get("api_secret"):
                    continue
                client = DeltaAuthClient(creds.get("api_key") or "",
                                         creds.get("api_secret") or "",
                                         creds.get("base_url") or "")
                self._live_clients[aid] = client

            try:
                wallets = client.wallet_balances() or []
            except Exception as exc:  # noqa: BLE001
                # A balance that could not be read is not a balance of zero.
                # Leave the last figure known to be real and say so once.
                if aid not in self._balance_warned:
                    self._balance_warned.add(aid)
                    log.warning("LIVE   %s balance read failed: %s",
                                row.get("name") or aid, exc)
                continue
            self._balance_warned.discard(aid)

            total = sum(
                _num(w.get("available_balance") or w.get("balance"))
                for w in wallets if isinstance(w, dict)
                and str(w.get("asset_symbol")
                        or (w.get("asset") or {}).get("symbol") or "").upper()
                in SETTLEMENT_ASSETS)

            if abs(total - _num(row.get("balance"))) > 0.005:
                self.store.set_account_balance(aid, total)
                acct = self.accounts.get(aid)
                if acct is not None:
                    acct.balance = total

    def reconcile_live_positions(self, now_ts: float) -> None:
        """Make the record match the exchange.

        Delta is the authority on what a live account holds; this table is a
        copy, and a copy can be wrong. It was: fourteen orders filled and
        every one failed to record, so the dashboard showed nothing while the
        account held seventy contracts. Nothing noticed, because nothing was
        looking.

        Two directions, treated differently on purpose.

        A position Delta has that this side does not is adopted outright -
        it is real, it was paid for, and showing it is strictly better than
        pretending it does not exist. A size that disagrees is corrected to
        Delta's.

        A position this side has that Delta does not is only reported. It
        usually means settlement, which `settle_expired` handles by expiry
        and does properly. Closing it here on the strength of one read would
        turn a timeout or a bad response into destroyed bookkeeping.
        """
        if (now_ts - self._reconcile_at) < LIVE_RECONCILE_SEC:
            return
        self._reconcile_at = now_ts
        now = datetime.now(timezone.utc)

        for aid, client in list(self._live_clients.items()):
            try:
                remote = client.open_positions() or []
            except Exception as exc:  # noqa: BLE001
                log.warning("LIVE   reconcile read failed for account %s: %s",
                            aid, exc)
                continue

            on_delta: Dict[str, float] = {}
            entry_of: Dict[str, float] = {}
            for p in remote:
                if not isinstance(p, dict):
                    continue
                sym = p.get("product_symbol") or ""
                size = abs(_num(p.get("size")))
                if not sym or size <= 0:
                    continue
                on_delta[sym] = size
                entry_of[sym] = _num(p.get("entry_price"))

            ours = {p.symbol: p for p in self.portfolio.open_positions
                    if p.account_id == aid}
            # Contracts this account has already finished with. A position we
            # closed but the exchange still shows is a disagreement to report,
            # not a new position to open: adopting it put the exit rule back
            # in front of the same contract, which closed it again, which let
            # the next pass adopt it again - once a minute, booking a profit
            # each time that no sale had earned.
            done = {p.symbol for p in self.portfolio.closed
                    if p.account_id == aid}

            # Delta has it, we do not - or we have the wrong size.
            for sym, size in on_delta.items():
                held = ours.get(sym)
                if held is not None and abs(_num(held.qty) - size) <= 0.001:
                    continue
                meta = parse_symbol(sym)
                if meta is None:
                    continue
                round_id = "%s-%s" % (meta["asset"], meta["expiry_code"])
                price = entry_of.get(sym) or 0.0

                if held is None and sym in done:
                    # Said once per symbol, then held: this repeats every
                    # pass until the contract settles, and the point is to be
                    # noticed rather than to fill the log.
                    if (aid, sym) not in self._adopted_live:
                        self._adopted_live.add((aid, sym))
                        log.warning(
                            "LIVE   STUCK %s is closed here but still open on "
                            "Delta qty=%.0f - the exit did not reach the "
                            "exchange; it will settle there", sym, size)
                    self._held_symbols.add((aid, sym))
                    continue

                if held is None:
                    log.warning("LIVE   ADOPT %s qty=%.0f @ %.4f - on Delta, "
                                "missing here", sym, size, price)
                    fill = LiveFill(True, qty=size, avg_price=price,
                                    top_price=price, requested_qty=size,
                                    levels_consumed=1)
                    try:
                        self.portfolio.open_position(
                            round_id, sym, "adopted", meta["side"],
                            meta["strike"], fill, now, None, None,
                            account_id=aid)
                    except Exception:  # noqa: BLE001
                        log.exception("LIVE   could not adopt %s", sym)
                        continue
                else:
                    log.warning("LIVE   SIZE %s here=%.0f delta=%.0f - "
                                "correcting to Delta", sym, _num(held.qty), size)
                    held.qty = size
                    if price:
                        held.entry_price = price

                # Whatever the exchange holds counts as held, so the strategy
                # does not try to open it a second time.
                self._held_symbols.add((aid, sym))
                self._held_strikes.setdefault((aid, round_id), set()).add(
                    float(meta["strike"]))

            # We have it, Delta does not. Reported only - see the docstring.
            for sym, held in ours.items():
                if sym in on_delta:
                    self._adopted_live.discard((aid, sym))
                    continue
                # The expiry is in the symbol, so it is still knowable after
                # the round has left the ticker feed. Reading it only from
                # `_expiry_by_symbol` meant an expired round - which is
                # exactly when Delta drops the position and this side has not
                # settled it yet - looked like a contract that had vanished.
                # Two false orphans within three seconds of every expiry is
                # how a warning stops being read.
                expiry = self._expiry_by_symbol.get(sym)
                if expiry is None:
                    meta = parse_symbol(sym)
                    if meta:
                        expiry = expiry_code_to_dt(meta["expiry_code"])
                if expiry is not None and (expiry - now).total_seconds() <= 0:
                    continue        # expired; settlement is settle_expired's job
                if (aid, sym) in self._adopted_live:
                    continue
                self._adopted_live.add((aid, sym))
                log.warning("LIVE   ORPHAN %s is open here but not on Delta - "
                            "check by hand; nothing closed automatically", sym)

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


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0
