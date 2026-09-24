#!/usr/bin/env python
"""Run the Delta Predict paper-trading engine.

  python run_live.py --config config.yaml
  python run_live.py --duration 3600          # run for an hour, then report
  python run_live.py --report-only            # summarise an existing ledger
  python run_live.py --dry-run                # one poll, show what it sees
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

from predict_paper.config import Config
from predict_paper.engine import Engine
from predict_paper.report import format_summary, load_trades, summarise


def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader so Supabase credentials need no extra dependency.
    Existing environment variables always win."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def setup_logging(verbose: bool, log_file: str) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S")
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    root.addHandler(console)

    os.makedirs(os.path.dirname(log_file) or ".", exist_ok=True)
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)

    logging.getLogger("urllib3").setLevel(logging.WARNING)


def main() -> int:
    ap = argparse.ArgumentParser(description="Delta Predict paper trading")
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--duration", type=float, default=None,
                    help="stop after N seconds")
    ap.add_argument("--iterations", type=int, default=None,
                    help="stop after N polls")
    ap.add_argument("--run-name", default=None, help="override ledger name")
    ap.add_argument("--dry-run", action="store_true",
                    help="single poll, no looping")
    ap.add_argument("--report-only", action="store_true",
                    help="summarise the existing ledger and exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    load_dotenv()
    cfg = Config.load(args.config) if os.path.exists(args.config) else Config()
    if args.run_name:
        cfg.run_name = args.run_name

    setup_logging(args.verbose,
                  os.path.join(cfg.data_dir, "run_%s.log" % cfg.run_name))
    log = logging.getLogger("run")

    if not os.path.exists(args.config):
        log.warning("config %s not found - using built-in defaults", args.config)

    trades_path = os.path.join(cfg.data_dir, "trades_%s.jsonl" % cfg.run_name)

    if args.report_only:
        print(format_summary(summarise(load_trades(trades_path),
                                       cfg.portfolio.starting_cash)))
        return 0

    engine = Engine(cfg)
    if args.dry_run:
        engine.poll_once()
        # Close the run. Engine.__init__ registers one, and only run() closes
        # it, so a dry run used to leave a row marked running for ever.
        try:
            engine.store.finish_run(engine.portfolio.cash, "stopped")
        except Exception:  # noqa: BLE001
            pass
        log.info("dry run complete")
    else:
        engine.run(max_iterations=args.iterations, duration_sec=args.duration)

    print()
    print(format_summary(summarise(load_trades(trades_path),
                                   cfg.portfolio.starting_cash)))
    open_pos = engine.portfolio.open_positions
    if open_pos:
        print("\nStill open (%d):" % len(open_pos))
        for p in open_pos:
            print("  %-28s %-9s qty=%-5.0f entry=%.4f" % (
                p.symbol, p.role, p.qty, p.entry_price))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
