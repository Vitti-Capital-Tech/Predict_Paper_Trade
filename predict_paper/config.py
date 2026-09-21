"""Configuration objects.

Every ambiguous rule in the original strategy description is exposed here as a
flag, so an interpretation can be changed (or swept) without touching code.
"""
from __future__ import annotations

import dataclasses as dc
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import yaml


@dataclass
class ApiConfig:
    base_url: str = "https://api.delta.exchange"
    underlying: str = "BTC"
    poll_interval_sec: float = 2.0
    request_timeout_sec: float = 10.0
    max_retries: int = 3


@dataclass
class AtrConfig:
    """ATR gate.

    `candle_symbol` matters more than it looks. BTCUSD is stale and flat, which
    disables the filter outright. BTCUSDT looks alive but barely trades at
    short resolutions - 51 of 60 five-minute bars came back flat with zero
    volume, understating ATR by roughly 2.4x (32 against 77 on the same
    window). `.DEXBTUSDT` is Delta's spot index: continuous, and what these
    markets settle against.
    """
    candle_symbol: str = ".DEXBTUSDT"
    resolution: str = "5m"
    period: int = 14
    min_atr: float = 200.0
    refresh_sec: float = 30.0
    enabled: bool = True


@dataclass
class TimingConfig:
    """The 'filter for timings'.

    Two independent axes:
      * where we are *inside a round* (seconds since launch / to expiry)
      * wall-clock session windows and weekdays
    """
    min_seconds_since_launch: float = 30.0
    max_seconds_since_launch: float = 900.0
    # Delta halts trading for the final minute of a round: positions can be
    # neither opened nor closed inside this window. Modelling it matters -
    # without it the paper book fills at moments the venue would refuse.
    trading_halt_sec: float = 60.0
    min_seconds_to_expiry: float = 180.0
    max_seconds_to_expiry: float = 1800.0
    # "HH:MM-HH:MM" windows; empty list = all hours allowed.
    sessions: List[str] = field(default_factory=list)
    session_timezone: str = "UTC"  # "UTC" or "IST"
    # 0 = Monday .. 6 = Sunday
    weekdays: List[int] = field(default_factory=lambda: [0, 1, 2, 3, 4, 5, 6])


@dataclass
class EntryConfig:
    """Entry rules.

    odds_convention:
      risk_reward     -- "1:5" = risk 1 to win 5 -> max price 1/(1+5) = 0.1667
      payout_multiple -- "1:5" = 5x gross payout -> max price 1/5   = 0.2000
    """
    odds_convention: str = "risk_reward"
    wing_odds: float = 5.0
    middle_odds: float = 3.0

    # A leg whose fill lands more than this above the touch is skipped. The
    # odds re-test already catches gross slippage, but only when the ceiling
    # happens to be nearby; this is the explicit cap.
    max_slippage: Optional[float] = None
    trade_wings: bool = True
    require_both_wings: bool = True
    trade_middle: bool = False
    middle_side: str = "auto"  # auto | call | put

    # Dollars per leg, the way Predict itself sizes: you name the money and the
    # contracts follow from the price. A fixed contract count is not something
    # the venue offers, so it is not something this exposes.
    #
    # The risk a dollar budget carries is that the cheapest wings - the
    # thinnest part of the book - are exactly where it buys the most contracts.
    # `max_slippage` is what holds that in check.
    investment_per_leg: float = 25.0
    one_entry_per_round: bool = True


@dataclass
class ExitConfig:
    """Exit rules.

    mode:
      price       -- "ITM 50" = close when the contract is worth 0.50
      spot_points -- "ITM 50" = close when spot is 50 points past the strike
    """
    mode: str = "price"
    # moneyness mode: which side of the strike ends the trade.
    #   itm -> spot is `spot_points_itm` past the strike in your favour
    #   otm -> spot is `spot_points_itm` past it against you (a stop)
    #   atm -> spot is within `atm_band_points` of the strike
    moneyness_trigger: str = "itm"
    atm_band_points: float = 25.0
    take_profit_price: float = 0.50
    spot_points_itm: float = 50.0
    stop_loss_price: Optional[float] = None
    close_loser_on_tp: bool = False
    # Force-flatten this many seconds before settlement (None = hold to expiry).
    flatten_before_expiry_sec: Optional[float] = None
    # Whether these rules also govern trades placed by hand from the panel.
    # Off by default: a manual position is the user's to exit, and having the
    # strategy take profit on their behalf silently overrides the click.
    apply_to_manual: bool = False


@dataclass
class FillConfig:
    """Slippage model. This is the part that decides whether the strategy is
    real or an artifact, so it defaults to walking the actual L2 book."""
    model: str = "orderbook"  # orderbook | best_quote | mark
    extra_slippage_ticks: float = 0.0
    tick_size: float = 0.0001
    max_book_levels: int = 20
    allow_partial: bool = False
    # Refetch the book at execution time so real latency is in the fill.
    refetch_book_on_execute: bool = True
    max_spread_frac: Optional[float] = 1.5  # skip if (ask-bid)/mid exceeds this


@dataclass
class PortfolioConfig:
    starting_cash: float = 10000.0
    max_concurrent_rounds: int = 2
    max_cost_per_round: Optional[float] = None
    taker_fee_rate: float = 0.0   # venue reports 0 for binaries
    maker_fee_rate: float = 0.0


@dataclass
class Config:
    api: ApiConfig = field(default_factory=ApiConfig)
    atr: AtrConfig = field(default_factory=AtrConfig)
    timing: TimingConfig = field(default_factory=TimingConfig)
    entry: EntryConfig = field(default_factory=EntryConfig)
    exit: ExitConfig = field(default_factory=ExitConfig)
    fills: FillConfig = field(default_factory=FillConfig)
    portfolio: PortfolioConfig = field(default_factory=PortfolioConfig)
    data_dir: str = "data"
    run_name: str = "default"

    # On startup, take over positions a previous worker left open. Hosting
    # makes restarts routine - every redeploy is one - and without this each
    # restart strands whatever was open at the time.
    # Master switch. False stops new entries; exits and settlement continue,
    # because disarming must not strand an open position.
    enabled: bool = True
    # Poll Supabase for edited settings this often. None disables remote
    # config entirely and config.yaml stays the only source.
    config_refresh_sec: Optional[float] = 5.0

    recover_open_positions: bool = True
    # How long a run's heartbeat must have been silent before its positions
    # count as abandoned. Must comfortably exceed the poll interval, or a live
    # worker's positions could be adopted out from under it.
    adopt_stale_after_sec: float = 120.0

    # ---- max entry prices derived from the odds convention -------------
    def max_price_for_odds(self, odds: float) -> float:
        if self.entry.odds_convention == "risk_reward":
            return 1.0 / (1.0 + odds)
        if self.entry.odds_convention == "payout_multiple":
            return 1.0 / odds
        raise ValueError(f"unknown odds_convention: {self.entry.odds_convention}")

    @property
    def wing_max_price(self) -> float:
        return self.max_price_for_odds(self.entry.wing_odds)

    @property
    def middle_max_price(self) -> float:
        return self.max_price_for_odds(self.entry.middle_odds)

    # ---- (de)serialisation ---------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        return dc.asdict(self)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "Config":
        raw = dict(raw or {})
        sections = {
            "api": ApiConfig, "atr": AtrConfig, "timing": TimingConfig,
            "entry": EntryConfig, "exit": ExitConfig, "fills": FillConfig,
            "portfolio": PortfolioConfig,
        }
        kwargs: Dict[str, Any] = {}
        for name, klass in sections.items():
            sub = raw.pop(name, None) or {}
            known = {f.name for f in dc.fields(klass)}
            unknown = set(sub) - known
            if unknown:
                raise ValueError(f"unknown keys in config section '{name}': {sorted(unknown)}")
            kwargs[name] = klass(**sub)
        known_top = {f.name for f in dc.fields(cls)} - set(sections)
        unknown_top = set(raw) - known_top
        if unknown_top:
            raise ValueError(f"unknown top-level config keys: {sorted(unknown_top)}")
        kwargs.update(raw)
        return cls(**kwargs)

    @classmethod
    def load(cls, path: str) -> "Config":
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_dict(yaml.safe_load(fh) or {})
