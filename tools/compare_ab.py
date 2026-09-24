#!/usr/bin/env python
"""Compare two accounts over the same window.

Raw P&L is the wrong headline for this. The account with the looser guard
takes more trades, so it swings further in whichever direction the period
happened to go, and the bigger number tells you about the week rather than
about the setting. Per round is the comparable figure.

The window matters as much as the metric. An account with weeks of history
compared against one made yesterday is comparing two different markets, so
this starts from the newer account's creation unless told otherwise - the
moment both were live under the rules being compared.

    python tools/compare_ab.py 1 10
    python tools/compare_ab.py 1 10 --since 2026-09-24T12:00:00Z
"""
from __future__ import annotations

import argparse
import collections
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

import requests

NOT_STRATEGY = {"id", "account_id", "updated_at", "created_at"}


def db() -> tuple:
    url = os.environ.get("SUPABASE_URL")
    key = (os.environ.get("SUPABASE_SERVICE_KEY")
           or os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
        raise SystemExit(2)
    return url.rstrip("/") + "/rest/v1", {"apikey": key, "Authorization": "Bearer " + key}


def fetch(base: str, h: Dict[str, str], table: str, **params: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for off in range(0, 20000, 1000):
        p = dict(params, limit="1000", offset=str(off))
        r = requests.get("%s/%s" % (base, table), headers=h, params=p, timeout=30)
        r.raise_for_status()
        rows = r.json()
        out += rows
        if len(rows) < 1000:
            break
    return out


def stats(positions: List[Dict[str, Any]]) -> Dict[str, Any]:
    done = [p for p in positions if p.get("exit_price") is not None]
    by_round: Dict[str, float] = collections.defaultdict(float)
    invested = slippage = 0.0

    for p in done:
        qty = float(p["qty"])
        pnl = (float(p["exit_price"]) - float(p["entry_price"])) * qty - float(p.get("fees") or 0)
        by_round[p["round_id"]] += pnl
        invested += float(p["entry_price"]) * qty
        slippage += float(p.get("entry_slippage") or 0) * qty

    rounds = list(by_round.values())
    won = [v for v in rounds if v > 0]
    total = sum(rounds)
    return {
        "legs": len(done),
        "rounds": len(rounds),
        "pnl": total,
        "per_round": total / len(rounds) if rounds else 0.0,
        "win_rate": 100.0 * len(won) / len(rounds) if rounds else 0.0,
        "invested": invested,
        "return_pct": 100.0 * total / invested if invested else 0.0,
        "slippage": slippage,
        "slip_per_round": slippage / len(rounds) if rounds else 0.0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("a", type=int)
    ap.add_argument("b", type=int)
    ap.add_argument("--since", help="ISO time; default is the newer account's creation")
    args = ap.parse_args()

    try:
        from run_live import load_dotenv
        load_dotenv()
    except Exception:
        pass

    base, h = db()

    # Confirm the two are still twins. A setting changed mid-run invalidates
    # everything measured before it, and that is easy to do by accident.
    cfgs = {}
    for aid in (args.a, args.b):
        rows = fetch(base, h, "strategy_config", select="*", account_id="eq.%d" % aid)
        if not rows:
            print("account %d has no strategy row" % aid)
            return 1
        cfgs[aid] = rows[0]
    keys = (set(cfgs[args.a]) | set(cfgs[args.b])) - NOT_STRATEGY
    differ = sorted(k for k in keys
                    if str(cfgs[args.a].get(k)) != str(cfgs[args.b].get(k)))
    print("Differences in strategy: %s" % (", ".join(differ) or "none"))
    for k in differ:
        print("    %-24s %-16s vs %s" % (k, cfgs[args.a].get(k), cfgs[args.b].get(k)))
    if len(differ) != 1:
        print("\n  Careful: a clean A/B differs in exactly one setting.")

    pos = {aid: fetch(base, h, "positions", select="*", account_id="eq.%d" % aid)
           for aid in (args.a, args.b)}

    # Same window for both, or the comparison is between two periods.
    #
    # Anchoring on "the later account's first trade" breaks in the case that
    # matters most - the first run, before the new account has traded at all.
    # There is no first trade to anchor to, so it fell back to the other
    # account's whole history and reported hundreds of rounds against zero,
    # which reads like a result and is not one. Anchor instead on when the
    # newer account was created: that is when both were live under the rules
    # being compared.
    created = {}
    for aid in (args.a, args.b):
        rows = fetch(base, h, "accounts", select="id,created_at", id="eq.%d" % aid)
        created[aid] = rows[0].get("created_at") if rows else None

    if args.since:
        since = args.since
    elif all(created.values()):
        since = max(created.values())
    else:
        firsts = [f for f in (min((p["entry_time"] for p in rows), default=None)
                              for rows in pos.values()) if f]
        if not firsts:
            print(chr(10) + "Neither account has traded yet. Nothing to compare.")
            return 0
        since = max(firsts)
    print(chr(10) + "Window: from %s (both accounts)" % since)

    for aid in (args.a, args.b):
        pos[aid] = [p for p in pos[aid] if p["entry_time"] >= since]

    names = {}
    for aid in (args.a, args.b):
        rows = fetch(base, h, "accounts", select="id,name", id="eq.%d" % aid)
        names[aid] = rows[0]["name"] if rows else str(aid)

    sa, sb = stats(pos[args.a]), stats(pos[args.b])
    if not sa["rounds"] and not sb["rounds"]:
        print("\nNo settled rounds in the window yet.")
        return 0

    rows = [
        ("rounds settled", "%d", "rounds"),
        ("legs filled", "%d", "legs"),
        ("total P&L", "%+.2f", "pnl"),
        ("P&L per round", "%+.2f", "per_round"),
        ("round win rate", "%.1f%%", "win_rate"),
        ("capital deployed", "%.2f", "invested"),
        ("return on capital", "%+.2f%%", "return_pct"),
        ("slippage paid", "%.2f", "slippage"),
        ("slippage per round", "%.2f", "slip_per_round"),
    ]
    w = 22
    print("\n%-*s %18s %18s" % (w, "", names[args.a][:18], names[args.b][:18]))
    print("-" * (w + 38))
    for label, fmt, key in rows:
        print("%-*s %18s %18s" % (w, label, fmt % sa[key], fmt % sb[key]))

    print()
    if sa["rounds"] < 100 or sb["rounds"] < 100:
        print("  Fewer than 100 rounds on one side. At roughly one round every")
        print("  15 minutes that is under a day - too few to separate a real")
        print("  difference from an ordinary run of luck. Keep it running.")
    else:
        gap = sb["per_round"] - sa["per_round"]
        print("  %s earns %+.2f per round against %s." % (
            names[args.b], gap, names[args.a]))
        print("  It took %d rounds to their %d." % (sb["rounds"], sa["rounds"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
