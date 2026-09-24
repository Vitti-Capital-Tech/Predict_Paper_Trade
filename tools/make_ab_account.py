#!/usr/bin/env python
"""Clone an account's strategy so two of them differ in exactly one setting.

An A/B between two accounts only means something if they are twins. Copying
settings by hand through the dashboard does not give you that: miss one field
and the difference you measure is not the difference you set.

So this copies the whole strategy_config row verbatim, overrides one column,
and then reads both rows back and prints every column that differs. If that
list is not exactly the column you asked for, the experiment is not clean and
it says so.

    python tools/make_ab_account.py --verify                  # compare existing
    python tools/make_ab_account.py --source 1 \\
        --name "BTC no spread guard" --set max_spread_frac=2.0 --create

Both accounts still need the same market conditions to be comparable, which
means running them over the same period. Starting one a day late is the same
mistake in a different place.
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Dict, List, Optional

import requests

# Columns that are identity or bookkeeping rather than strategy.
NOT_STRATEGY = {"id", "account_id", "updated_at", "created_at"}


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print("Set %s (or put it in .env and run via run_live's loader)." % name)
        raise SystemExit(2)
    return v


class Db:
    def __init__(self) -> None:
        self.url = env("SUPABASE_URL").rstrip("/") + "/rest/v1"
        key = os.environ.get("SUPABASE_SERVICE_KEY") or env("SUPABASE_SERVICE_ROLE_KEY")
        self.h = {"apikey": key, "Authorization": "Bearer " + key,
                  "Content-Type": "application/json"}

    def get(self, table: str, **params: str) -> List[Dict[str, Any]]:
        r = requests.get("%s/%s" % (self.url, table), headers=self.h,
                         params=params, timeout=20)
        r.raise_for_status()
        return r.json()

    def post(self, table: str, row: Dict[str, Any]) -> Dict[str, Any]:
        r = requests.post("%s/%s" % (self.url, table), headers={
            **self.h, "Prefer": "return=representation"}, json=row, timeout=20)
        if r.status_code >= 400:
            print("  insert into %s failed: %s %s" % (table, r.status_code, r.text[:300]))
            raise SystemExit(1)
        return r.json()[0]

    def patch(self, table: str, row: Dict[str, Any], **params: str) -> None:
        r = requests.patch("%s/%s" % (self.url, table), headers=self.h,
                           params=params, json=row, timeout=20)
        if r.status_code >= 400:
            print("  update %s failed: %s %s" % (table, r.status_code, r.text[:300]))
            raise SystemExit(1)


def strategy_of(db: Db, account_id: int) -> Optional[Dict[str, Any]]:
    rows = db.get("strategy_config", select="*", account_id="eq.%d" % account_id)
    return rows[0] if rows else None


def diff(a: Dict[str, Any], b: Dict[str, Any]) -> List[str]:
    keys = (set(a) | set(b)) - NOT_STRATEGY
    return sorted(k for k in keys if str(a.get(k)) != str(b.get(k)))


def report(db: Db, left: int, right: int, expected: List[str]) -> int:
    la, lb = strategy_of(db, left), strategy_of(db, right)
    if not la or not lb:
        print("  one of the accounts has no strategy row.")
        return 1

    d = diff(la, lb)
    print("\nColumns that differ between account %d and %d:" % (left, right))
    for k in d:
        print("    %-26s %-18s vs %s" % (k, la.get(k), lb.get(k)))
    if not d:
        print("    (none)")

    extra = [k for k in d if k not in expected]
    missing = [k for k in expected if k not in d]
    print()
    if extra:
        print("  NOT A CLEAN TEST: these also differ and will confound it:")
        for k in extra:
            print("      %s" % k)
    if missing:
        print("  NOT SET: expected these to differ but they do not:")
        for k in missing:
            print("      %s" % k)
    if not extra and not missing:
        print("  Clean: the accounts differ in exactly %s." % ", ".join(expected))
        return 0
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=int, default=1, help="account to clone")
    ap.add_argument("--name", help="name for the new account")
    ap.add_argument("--set", action="append", default=[], metavar="COL=VALUE",
                    help="column to override on the clone; repeatable")
    ap.add_argument("--create", action="store_true", help="actually create it")
    ap.add_argument("--verify", nargs=2, type=int, metavar=("A", "B"),
                    help="compare two existing accounts instead")
    args = ap.parse_args()

    try:
        from run_live import load_dotenv
        load_dotenv()
    except Exception:
        pass

    db = Db()

    overrides: Dict[str, Any] = {}
    for item in args.set:
        col, _, val = item.partition("=")
        try:
            overrides[col] = float(val)
        except ValueError:
            overrides[col] = {"true": True, "false": False}.get(val.lower(), val)

    if args.verify:
        return report(db, args.verify[0], args.verify[1], sorted(overrides) or [])

    src_acct = db.get("accounts", select="*", id="eq.%d" % args.source)
    if not src_acct:
        print("No account %d." % args.source)
        return 1
    src_acct = src_acct[0]
    src_cfg = strategy_of(db, args.source)
    if not src_cfg:
        print("Account %d has no strategy_config row." % args.source)
        return 1

    for col in overrides:
        if col not in src_cfg:
            print("Column '%s' is not on strategy_config." % col)
            print("If you just added it, run the migration first.")
            return 1

    name = args.name or ("%s (B)" % src_acct["name"])
    print("Clone of account %d (%s)" % (args.source, src_acct["name"]))
    print("  new name        : %s" % name)
    print("  starting balance: %s" % src_acct["starting_balance"])
    for col, val in overrides.items():
        print("  override        : %s  %s -> %s" % (col, src_cfg.get(col), val))

    if not args.create:
        print("\nDry run. Add --create to make it.")
        return 0

    acct = db.post("accounts", {
        "name": name,
        "starting_balance": src_acct["starting_balance"],
        "balance": src_acct["starting_balance"],
    })
    new_id = acct["id"]
    print("\n  created account id=%s" % new_id)

    # A verbatim copy, minus identity, plus the overrides. Copying the whole
    # row is the point: picking fields by hand is how twins stop being twins.
    row = {k: v for k, v in src_cfg.items() if k not in NOT_STRATEGY}
    row.update(overrides)
    row["account_id"] = new_id

    existing = strategy_of(db, new_id)
    if existing:
        db.patch("strategy_config", row, account_id="eq.%d" % new_id)
        print("  updated its strategy row")
    else:
        db.post("strategy_config", row)
        print("  copied the strategy row")

    return report(db, args.source, new_id, sorted(overrides))


if __name__ == "__main__":
    sys.exit(main())
