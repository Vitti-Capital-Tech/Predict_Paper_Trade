"""Performance reporting over the trade ledger.

Reports per-leg and per-round results separately: on a strangle the individual
legs lose most of the time by design, so a leg-level win rate reads as a
disaster while the round-level result is what actually matters.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from typing import Any, Dict, List, Optional


def load_trades(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    out: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def _pnl(t: Dict[str, Any]) -> float:
    if t.get("exit_price") is None:
        return 0.0
    return (float(t["exit_price"]) - float(t["entry_price"])) * float(t["qty"]) \
        - float(t.get("fees") or 0.0)


def summarise(trades: List[Dict[str, Any]], starting_cash: Optional[float] = None
              ) -> Dict[str, Any]:
    done = [t for t in trades if t.get("exit_price") is not None]
    if not done:
        return {"trades": 0}

    pnls = [_pnl(t) for t in done]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    cost = sum(float(t["entry_price"]) * float(t["qty"]) for t in done)
    slip = sum(float(t.get("entry_slippage") or 0.0) * float(t["qty"]) for t in done)

    by_round: Dict[str, float] = defaultdict(float)
    by_round_cost: Dict[str, float] = defaultdict(float)
    for t, p in zip(done, pnls):
        by_round[t["round_id"]] += p
        by_round_cost[t["round_id"]] += float(t["entry_price"]) * float(t["qty"])
    round_pnls = list(by_round.values())
    round_wins = [p for p in round_pnls if p > 0]

    by_role: Dict[str, Dict[str, Any]] = {}
    for role in sorted({t.get("role", "?") for t in done}):
        rows = [(t, p) for t, p in zip(done, pnls) if t.get("role") == role]
        rp = [p for _, p in rows]
        by_role[role] = {
            "trades": len(rp),
            "pnl": round(sum(rp), 2),
            "win_rate": round(100.0 * len([p for p in rp if p > 0]) / len(rp), 1),
            "avg_entry": round(
                sum(float(t["entry_price"]) for t, _ in rows) / len(rows), 4),
        }

    by_exit: Dict[str, int] = defaultdict(int)
    for t in done:
        reason = str(t.get("exit_reason") or "")
        bucket = ("take profit" if reason.startswith("take profit")
                  else "stop loss" if reason.startswith("stop loss")
                  else "settled ITM" if "ITM" in reason
                  else "settled OTM" if "OTM" in reason
                  else "other")
        by_exit[bucket] += 1

    total = sum(pnls)
    out: Dict[str, Any] = {
        "trades": len(done),
        "legs_won": len(wins),
        "legs_lost": len(losses),
        "leg_win_rate_pct": round(100.0 * len(wins) / len(done), 1),
        "total_pnl": round(total, 2),
        "total_cost": round(cost, 2),
        "return_on_cost_pct": round(100.0 * total / cost, 2) if cost else 0.0,
        "avg_win": round(sum(wins) / len(wins), 2) if wins else 0.0,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0.0,
        "entry_slippage_cost": round(slip, 2),
        "slippage_pct_of_pnl": (round(100.0 * slip / abs(total), 1) if total else None),
        "rounds": len(round_pnls),
        "round_win_rate_pct": (round(100.0 * len(round_wins) / len(round_pnls), 1)
                               if round_pnls else 0.0),
        "avg_pnl_per_round": round(sum(round_pnls) / len(round_pnls), 2) if round_pnls else 0.0,
        "best_round": round(max(round_pnls), 2) if round_pnls else 0.0,
        "worst_round": round(min(round_pnls), 2) if round_pnls else 0.0,
        "by_role": by_role,
        "by_exit_reason": dict(by_exit),
    }

    # Max drawdown on the round-by-round equity curve.
    equity, peak, max_dd = 0.0, 0.0, 0.0
    for p in round_pnls:
        equity += p
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    out["max_drawdown"] = round(max_dd, 2)

    if starting_cash:
        out["starting_cash"] = starting_cash
        out["ending_cash"] = round(starting_cash + total, 2)
        out["return_pct"] = round(100.0 * total / starting_cash, 2)
    return out


def format_summary(s: Dict[str, Any]) -> str:
    if not s.get("trades"):
        return "No completed trades yet."
    L = []
    L.append("=" * 62)
    L.append("PAPER TRADING SUMMARY")
    L.append("=" * 62)
    L.append("Rounds traded      : %d" % s["rounds"])
    L.append("Legs filled        : %d  (%d won / %d lost, %.1f%%)" % (
        s["trades"], s["legs_won"], s["legs_lost"], s["leg_win_rate_pct"]))
    L.append("")
    L.append("Total P&L          : %+.2f USDT" % s["total_pnl"])
    L.append("Capital deployed   : %.2f USDT" % s["total_cost"])
    L.append("Return on cost     : %+.2f%%" % s["return_on_cost_pct"])
    if "return_pct" in s:
        L.append("Account return     : %+.2f%% (%.2f -> %.2f)" % (
            s["return_pct"], s["starting_cash"], s["ending_cash"]))
    L.append("")
    L.append("Round win rate     : %.1f%%" % s["round_win_rate_pct"])
    L.append("Avg P&L per round  : %+.2f" % s["avg_pnl_per_round"])
    L.append("Best / worst round : %+.2f / %+.2f" % (s["best_round"], s["worst_round"]))
    L.append("Max drawdown       : %.2f" % s["max_drawdown"])
    L.append("")
    L.append("Entry slippage cost: %.2f USDT" % s["entry_slippage_cost"])
    if s.get("slippage_pct_of_pnl") is not None:
        L.append("  ...as %% of |P&L| : %.1f%%" % s["slippage_pct_of_pnl"])
    L.append("")
    L.append("By leg role:")
    for role, r in s["by_role"].items():
        L.append("  %-10s n=%-4d pnl=%+9.2f win=%5.1f%% avg_entry=%.4f" % (
            role, r["trades"], r["pnl"], r["win_rate"], r["avg_entry"]))
    L.append("")
    L.append("By exit reason:")
    for reason, n in sorted(s["by_exit_reason"].items(), key=lambda kv: -kv[1]):
        L.append("  %-14s %d" % (reason, n))
    L.append("=" * 62)
    return "\n".join(L)
