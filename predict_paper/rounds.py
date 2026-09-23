"""Group binary tickers into rounds and label strikes 1st / middle / last.

Delta launches a new Predict round every ~15 minutes, ~20 minutes before it
settles, with N strikes (3 for BTC, spaced 100) each having a Call and a Put.
Symbols look like:  B-C-BTC-75600-1609261915  /  B-P-BTC-75600-1609261915
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SYMBOL_RE = re.compile(r"^B-(?P<side>[CP])-(?P<asset>[A-Z0-9]+)-(?P<strike>[0-9.]+)-(?P<expiry>\d{10})$")


def parse_symbol(symbol: str) -> Optional[Dict[str, Any]]:
    m = SYMBOL_RE.match(symbol or "")
    if not m:
        return None
    return {
        "symbol": symbol,
        "side": "call" if m.group("side") == "C" else "put",
        "asset": m.group("asset"),
        "strike": float(m.group("strike")),
        "expiry_code": m.group("expiry"),
    }


def expiry_code_to_dt(code: str) -> Optional[datetime]:
    """DDMMYYHHMM -> aware UTC datetime."""
    try:
        return datetime.strptime(code, "%d%m%y%H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _f(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out


@dataclass
class Contract:
    symbol: str
    side: str          # call | put
    asset: str
    strike: float
    expiry_code: str
    best_bid: Optional[float] = None
    best_ask: Optional[float] = None
    bid_size: Optional[float] = None
    ask_size: Optional[float] = None
    mark_price: Optional[float] = None
    spot_price: Optional[float] = None
    product_id: Optional[int] = None
    tick_size: float = 0.0001

    @property
    def mid(self) -> Optional[float]:
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2.0

    @property
    def spread(self) -> Optional[float]:
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid

    @classmethod
    def from_ticker(cls, t: Dict[str, Any]) -> Optional["Contract"]:
        parsed = parse_symbol(t.get("symbol", ""))
        if not parsed:
            return None
        q = t.get("quotes") or {}
        return cls(
            symbol=parsed["symbol"], side=parsed["side"], asset=parsed["asset"],
            strike=parsed["strike"], expiry_code=parsed["expiry_code"],
            best_bid=_f(q.get("best_bid")), best_ask=_f(q.get("best_ask")),
            bid_size=_f(q.get("bid_size")), ask_size=_f(q.get("ask_size")),
            mark_price=_f(t.get("mark_price")), spot_price=_f(t.get("spot_price")),
            product_id=t.get("product_id"), tick_size=_f(t.get("tick_size")) or 0.0001,
        )


@dataclass
class Round:
    """One expiry of one asset: all strikes, both sides."""
    asset: str
    expiry_code: str
    expiry: datetime
    contracts: List[Contract] = field(default_factory=list)
    launch_time: Optional[datetime] = None

    @property
    def round_id(self) -> str:
        return f"{self.asset}-{self.expiry_code}"

    @property
    def strikes(self) -> List[float]:
        return sorted({c.strike for c in self.contracts})

    @property
    def spot(self) -> Optional[float]:
        for c in self.contracts:
            if c.spot_price is not None:
                return c.spot_price
        return None

    def get(self, strike: float, side: str) -> Optional[Contract]:
        for c in self.contracts:
            if c.strike == strike and c.side == side:
                return c
        return None

    def seconds_to_expiry(self, now: datetime) -> float:
        return (self.expiry - now).total_seconds()

    def seconds_since_launch(self, now: datetime) -> Optional[float]:
        if self.launch_time is None:
            return None
        return (now - self.launch_time).total_seconds()

    @property
    def complete(self) -> bool:
        """Has the venue finished listing this round?

        Delta lists exactly three strikes. While a round is still appearing,
        fewer are quoted - and `strikes[0]` / `strikes[-1]` then name contracts
        that are not the real extremes. Entering on those buys a strike that
        stops being the edge of the round a few seconds later.
        """
        return len(self.strikes) >= 3

    # ---- strike roles ---------------------------------------------------
    def wing_legs(self, mode: str = "opposite") -> Dict[str, Optional[Contract]]:
        """The two extreme strikes, and which side to buy at each.

        opposite  Put at the lowest strike, Call at the highest - a long
                  strangle. Both sit OTM while spot is between them, which is
                  what makes them cheap enough to clear the odds test, and a
                  hard move either way pays one of them.
        same      The same side at both extremes - a directional bet spread
                  over two strikes. Which side is not a choice to make by hand:
                  at most one of the two pairs can ever be cheap, because calls
                  at both extremes need spot below them and puts at both need
                  spot above. So take whichever pair the market is offering.
        """
        strikes = self.strikes
        if len(strikes) < 3:
            return {"low": None, "high": None}
        lo, hi = strikes[0], strikes[-1]

        if mode == "same":
            def pair(side):
                return self.get(lo, side), self.get(hi, side)

            def cost(p):
                if p[0] is None or p[1] is None:
                    return None
                if p[0].best_ask is None or p[1].best_ask is None:
                    return None
                return p[0].best_ask + p[1].best_ask

            priced = [(c, p) for p in (pair("call"), pair("put"))
                      if (c := cost(p)) is not None]
            if not priced:
                return {"low": None, "high": None}
            _, best = min(priced, key=lambda x: x[0])
            return {"low": best[0], "high": best[1]}

        return {"low": self.get(lo, "put"), "high": self.get(hi, "call")}

    def middle_strike(self) -> Optional[float]:
        strikes = self.strikes
        if len(strikes) < 3:
            return None
        return strikes[len(strikes) // 2]

    def middle_legs(self) -> Dict[str, Optional[Contract]]:
        mid = self.middle_strike()
        if mid is None:
            return {"call": None, "put": None}
        return {"call": self.get(mid, "call"), "put": self.get(mid, "put")}


def build_rounds(tickers: List[Dict[str, Any]], asset: str = "BTC",
                 products: Optional[List[Dict[str, Any]]] = None) -> List[Round]:
    """Assemble Round objects from a bulk ticker response.

    `/v2/tickers` carries no state, so a contract the venue has listed but not
    opened still appears there. Taken at face value that produced entries on
    premarket strikes, and - while a round was mid-listing - on strikes that
    were not the extremes they looked like. `products` is the authority on
    what is actually live, so when it is available the tickers are filtered
    through it.
    """
    launch_by_symbol: Dict[str, datetime] = {}
    live: set = set()
    for p in products or []:
        sym = p.get("symbol")
        if not sym:
            continue
        # `state` is "live" for everything, including a round that has not
        # opened yet, so it cannot tell a tradeable contract from a listed one.
        # `trading_status` can: a round spends its first few minutes
        # post-only and its last moments cancel-only, and a taker order is
        # refused in both.
        if p.get("trading_status") not in (None, "operational"):
            continue
        live.add(sym)
        lt = p.get("launch_time")
        if lt:
            try:
                launch_by_symbol[sym] = datetime.fromisoformat(
                    str(lt).replace("Z", "+00:00"))
            except ValueError:
                pass

    by_expiry: Dict[str, Round] = {}
    for t in tickers:
        c = Contract.from_ticker(t)
        if c is None or c.asset != asset:
            continue
        # No product list means no way to tell; trust the feed rather than
        # refusing to trade at all.
        if live and c.symbol not in live:
            continue
        rnd = by_expiry.get(c.expiry_code)
        if rnd is None:
            exp = expiry_code_to_dt(c.expiry_code)
            if exp is None:
                continue
            rnd = Round(asset=c.asset, expiry_code=c.expiry_code, expiry=exp)
            by_expiry[c.expiry_code] = rnd
        rnd.contracts.append(c)
        lt = launch_by_symbol.get(c.symbol)
        if lt and (rnd.launch_time is None or lt < rnd.launch_time):
            rnd.launch_time = lt

    return sorted(by_expiry.values(), key=lambda r: r.expiry)
