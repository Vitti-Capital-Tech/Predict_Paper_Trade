#!/usr/bin/env python
"""Check that everything is wired up before starting a real paper run.

  python verify_setup.py
"""
from __future__ import annotations

import os
import sys

def ok(msg):   print("  [ok]   %s" % msg)
def bad(msg):  print("  [FAIL] %s" % msg)
def warn(msg): print("  [warn] %s" % msg)


def main() -> int:
    failures = 0

    # Same .env loading as run_live.py, so this works standalone.
    try:
        from run_live import load_dotenv
        load_dotenv()
    except Exception:
        pass

    print("\n1. Delta Exchange market data")
    try:
        from predict_paper.delta import DeltaClient
        from predict_paper.rounds import build_rounds
        c = DeltaClient()
        tickers = c.binary_tickers()
        ok("reached the API, %d binary tickers live" % len(tickers))
        rounds = build_rounds(tickers, "BTC", c.live_binary_products())
        if rounds:
            r = rounds[0]
            ok("parsed round %s strikes=%s spot=%s" % (r.round_id, r.strikes, r.spot))
        else:
            warn("no live BTC rounds right now (they list ~20 min before expiry)")
    except Exception as exc:
        bad("market data failed: %s" % exc); failures += 1

    print("\n2. BTC ATR feed")
    try:
        from predict_paper.indicators import AtrGate
        gate = AtrGate(DeltaClient(), "BTCUSDT", "5m", 14, 200.0)
        passes, atr = gate.passes()
        if atr is None:
            bad("no ATR value returned"); failures += 1
        else:
            ok("ATR(14, 5m) = %.1f -> gate %s" % (atr, "OPEN" if passes else "CLOSED"))
    except Exception as exc:
        bad("ATR failed: %s" % exc); failures += 1

    print("\n3. Config")
    try:
        from predict_paper.config import Config
        cfg = Config.load("config.yaml") if os.path.exists("config.yaml") else Config()
        ok("wing entry <= %.4f, middle entry <= %.4f (%s)" % (
            cfg.wing_max_price, cfg.middle_max_price, cfg.entry.odds_convention))
        ok("exit mode '%s' at %.2f" % (cfg.exit.mode, cfg.exit.take_profit_price))
        ok("fill model '%s', size %d contracts" % (
            cfg.fills.model, cfg.entry.size_contracts))
    except Exception as exc:
        bad("config failed: %s" % exc); failures += 1

    print("\n4. Supabase")
    url = os.environ.get("SUPABASE_URL")
    key = (os.environ.get("SUPABASE_SERVICE_KEY")
           or os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not url or not key:
        warn("SUPABASE_URL / SUPABASE_SERVICE_KEY not set -"
             " the worker will run local-only (no dashboard)")
    else:
        try:
            import requests
            r = requests.get("%s/rest/v1/runs?select=id&limit=1" % url.rstrip("/"),
                             headers={"apikey": key, "Authorization": "Bearer %s" % key},
                             timeout=10)
            if r.status_code == 200:
                ok("connected, 'runs' table reachable")
            elif r.status_code in (401, 403):
                bad("key rejected (%d) - check the SERVICE ROLE key" % r.status_code)
                failures += 1
            elif r.status_code == 404:
                bad("'runs' table missing - run supabase/schema.sql first")
                failures += 1
            else:
                bad("unexpected %d: %s" % (r.status_code, r.text[:120])); failures += 1
        except Exception as exc:
            bad("connection failed: %s" % exc); failures += 1

    print()
    if failures:
        print("%d check(s) failed." % failures)
    else:
        print("All checks passed - start with:  python run_live.py")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
