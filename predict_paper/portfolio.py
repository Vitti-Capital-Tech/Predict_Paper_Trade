"""Paper portfolio: positions, realised P&L, settlement and the trade ledger.

These contracts pay exactly 1.0 USDT if in the money and 0.0 otherwise, and the
venue reports zero maker/taker commission for binaries, so P&L is simply
(exit - entry) * qty, with fees left configurable in case that changes.

Expired positions are settled from the venue's published `settlement_price`
rather than inferred from spot, so results match what actually happened.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


@dataclass
class Position:
    position_id: str
    round_id: str
    symbol: str
    role: str          # wing_low | wing_high | middle
    side: str          # call | put
    strike: float
    qty: float
    entry_price: float
    entry_time: str
    entry_top_price: Optional[float] = None
    entry_slippage: float = 0.0
    entry_levels: int = 0
    entry_spot: Optional[float] = None
    entry_atr: Optional[float] = None

    status: str = "open"          # open | closed | settled
    exit_price: Optional[float] = None
    exit_time: Optional[str] = None
    exit_reason: str = ""
    exit_slippage: float = 0.0
    fees: float = 0.0
    # Underlying price when the position settled (approximate - see
    # migration 003). None for positions closed before expiry.
    settlement_spot: Optional[float] = None

    @property
    def cost(self) -> float:
        return self.qty * self.entry_price

    @property
    def pnl(self) -> Optional[float]:
        if self.exit_price is None:
            return None
        return (self.exit_price - self.entry_price) * self.qty - self.fees

    def unrealised(self, mark: Optional[float]) -> float:
        if self.status != "open" or mark is None:
            return 0.0
        return (mark - self.entry_price) * self.qty


class Portfolio:
    def __init__(self, cfg, data_dir: str = "data", run_name: str = "default",
                 store=None):
        self.cfg = cfg
        self.starting_cash = cfg.starting_cash
        self.cash = cfg.starting_cash
        self.positions: Dict[str, Position] = {}
        self.closed: List[Position] = []
        self._seq = 0
        # Supabase (or NullStore). Never allowed to break the trading loop.
        from .store import NullStore
        self.store = store or NullStore()

        os.makedirs(data_dir, exist_ok=True)
        self.trades_path = os.path.join(data_dir, "trades_%s.jsonl" % run_name)
        self.events_path = os.path.join(data_dir, "events_%s.jsonl" % run_name)

    # ---- helpers --------------------------------------------------------
    def _next_id(self, symbol: str) -> str:
        self._seq += 1
        return "%s#%d" % (symbol, self._seq)

    def _append(self, path: str, record: Dict[str, Any]) -> None:
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, default=str) + "\n")
        except OSError as exc:
            log.error("could not write %s: %s", path, exc)

    def log_event(self, kind: str, **fields: Any) -> None:
        rec = {"ts": datetime.now(timezone.utc).isoformat(), "kind": kind}
        rec.update(fields)
        self._append(self.events_path, rec)
        try:
            reasons = fields.get("reasons")
            self.store.log_event(
                kind,
                round_id=fields.get("round_id"),
                symbol=fields.get("symbol"),
                reason=fields.get("reason") or (
                    "; ".join(reasons) if isinstance(reasons, list) else reasons),
                **{k: v for k, v in fields.items()
                   if k not in ("round_id", "symbol", "reason")},
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("store event failed: %s", exc)

    # ---- state ----------------------------------------------------------
    @property
    def open_positions(self) -> List[Position]:
        return [p for p in self.positions.values() if p.status == "open"]

    def open_rounds(self) -> set:
        return {p.round_id for p in self.open_positions}

    def has_round(self, round_id: str) -> bool:
        return any(p.round_id == round_id for p in self.positions.values())

    def position_for(self, symbol: str) -> Optional[Position]:
        for p in self.open_positions:
            if p.symbol == symbol:
                return p
        return None

    def equity(self, marks: Optional[Dict[str, float]] = None) -> float:
        marks = marks or {}
        return self.cash + sum(
            p.qty * marks.get(p.symbol, p.entry_price) for p in self.open_positions)

    # ---- actions --------------------------------------------------------
    def open_position(self, round_id: str, symbol: str, role: str, side: str,
                      strike: float, fill, now: datetime,
                      spot: Optional[float] = None,
                      atr: Optional[float] = None) -> Position:
        fee = fill.qty * fill.avg_price * self.cfg.taker_fee_rate
        pos = Position(
            position_id=self._next_id(symbol), round_id=round_id, symbol=symbol,
            role=role, side=side, strike=strike, qty=fill.qty,
            entry_price=fill.avg_price, entry_time=now.isoformat(),
            entry_top_price=fill.top_price, entry_slippage=fill.slippage_vs_top,
            entry_levels=fill.levels_consumed, entry_spot=spot, entry_atr=atr,
            fees=fee,
        )
        self.cash -= pos.cost + fee
        self.positions[pos.position_id] = pos
        self._sync(pos)
        self.log_event("entry", position_id=pos.position_id, symbol=symbol,
                       role=role, qty=pos.qty, price=pos.entry_price,
                       top_price=fill.top_price, slippage=fill.slippage_vs_top,
                       cash=self.cash)
        log.info("ENTRY  %-28s %-9s qty=%-5.0f @ %.4f (touch %.4f, slip %.4f)",
                 symbol, role, pos.qty, pos.entry_price,
                 fill.top_price or 0.0, fill.slippage_vs_top)
        return pos

    def close_position(self, pos: Position, fill, now: datetime,
                       reason: str) -> None:
        fee = fill.qty * fill.avg_price * self.cfg.taker_fee_rate
        pos.exit_price = fill.avg_price
        pos.exit_time = now.isoformat()
        pos.exit_reason = reason
        pos.exit_slippage = fill.slippage_vs_top
        pos.fees += fee
        pos.status = "closed"
        self.cash += fill.qty * fill.avg_price - fee
        self._finish(pos, "exit")

    def settle_position(self, pos: Position, settlement_price: float,
                        now: datetime,
                        settlement_spot: Optional[float] = None) -> None:
        pos.settlement_spot = settlement_spot
        pos.exit_price = settlement_price
        pos.exit_time = now.isoformat()
        pos.exit_reason = "settled %s" % ("ITM" if settlement_price >= 0.5 else "OTM")
        pos.status = "settled"
        self.cash += pos.qty * settlement_price
        self._finish(pos, "settlement")

    def _sync(self, pos: Position) -> None:
        try:
            self.store.upsert_position(asdict(pos))
        except Exception as exc:  # noqa: BLE001
            log.debug("store upsert failed: %s", exc)

    def _finish(self, pos: Position, kind: str) -> None:
        self.closed.append(pos)
        self.positions.pop(pos.position_id, None)
        self._append(self.trades_path, asdict(pos))
        self._sync(pos)
        self.log_event(kind, position_id=pos.position_id, symbol=pos.symbol,
                       price=pos.exit_price, pnl=pos.pnl, reason=pos.exit_reason,
                       cash=self.cash)
        log.info("%-6s %-28s %-9s @ %.4f  pnl=%+.2f  cash=%.2f",
                 kind.upper(), pos.symbol, pos.role, pos.exit_price or 0.0,
                 pos.pnl or 0.0, self.cash)
