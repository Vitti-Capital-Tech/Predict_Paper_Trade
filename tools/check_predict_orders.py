#!/usr/bin/env python
"""Does Delta accept API orders on Predict (binary) contracts?

ANSWERED, in the docs, under "Place order errors":

    limit_order_not_allowed_for_binary_options
        "Limit orders are not supported for binary options products."
    stop_orders_not_allowed_for_binary_options
        "Stop orders are not supported for binary options products."

So a limit order on a Predict contract is rejected by design: there is no
maker path on these products, only market orders. That those errors exist at
all is also the proof that binaries ARE orderable through the API.

This script is kept because running it turns a documented claim into an
observed one, and because it is the quickest way to check whether that ever
changes. Expect the --place run to come back with exactly that error code.

What it does, in order:

  1. Read-only checks. Lists live Predict contracts and reads your open orders,
     which proves the key works before anything is placed.
  2. With --place, posts ONE contract, post_only, at the price band's floor
     (0.0001) - the lowest price the venue accepts. Nothing sane sells there,
     so it rests rather than fills. Maximum exposure if the impossible happens
     is $0.0001.
  3. Cancels it immediately, and again in a finally block if anything throws.

Post-only matters twice over: it is the thing being tested, and it guarantees
the order is rejected outright rather than crossing the spread if the price is
somehow marketable.

    export DELTA_API_KEY=...
    export DELTA_API_SECRET=...

    python tools/check_predict_orders.py             # read-only
    python tools/check_predict_orders.py --place     # places and cancels one

Read-only mode changes nothing and is the sensible first run: if listing
orders fails, the key or its permissions are the problem, not the product.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
from typing import Any, Dict, Optional

import requests

BASE = "https://api.delta.exchange"
UA = "python-3.12"


def sign(secret: str, method: str, path: str, query: str, body: str,
         ts: str) -> str:
    """HMAC-SHA256 over method + timestamp + path + query + body, hex."""
    msg = method + ts + path + query + body
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


def call(key: str, secret: str, method: str, path: str,
         query: str = "", payload: Optional[Dict[str, Any]] = None) -> requests.Response:
    body = json.dumps(payload, separators=(",", ":")) if payload is not None else ""
    ts = str(int(time.time()))
    headers = {
        "api-key": key,
        "timestamp": ts,
        "signature": sign(secret, method, path, query, body, ts),
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if body:
        headers["Content-Type"] = "application/json"
    return requests.request(method, BASE + path + query, headers=headers,
                            data=body or None, timeout=20)


def show(label: str, r: requests.Response) -> Any:
    ok = "ok " if r.status_code < 400 else "ERR"
    print("  [%s] %-22s HTTP %s" % (ok, label, r.status_code))
    try:
        body = r.json()
    except ValueError:
        print("       (non-JSON) %s" % r.text[:200])
        return None
    if r.status_code >= 400 or not body.get("success", True):
        err = body.get("error")
        print("       error: %s" % json.dumps(err)[:400])
    return body.get("result")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", action="store_true",
                    help="actually place (and cancel) one post-only contract")
    ap.add_argument("--asset", default="BTC")
    args = ap.parse_args()

    key = os.environ.get("DELTA_API_KEY")
    secret = os.environ.get("DELTA_API_SECRET")
    if not key or not secret:
        print("Set DELTA_API_KEY and DELTA_API_SECRET first.")
        return 2

    # ---- 1. which Predict contracts are live -------------------------------
    print("\n1. Live Predict contracts")
    prods = requests.get(BASE + "/v2/products", timeout=20, params={
        "contract_types": "binary_call_options,binary_put_options",
        "states": "live", "page_size": 100,
    }).json().get("result") or []
    mine = [p for p in prods if (p.get("underlying_asset") or {}).get("symbol") == args.asset]
    if not mine:
        print("  none live for %s right now - rerun in a minute." % args.asset)
        return 1
    for p in mine[:6]:
        print("  %-30s id=%-8s tick=%s band=%s" % (
            p["symbol"], p["id"], p.get("tick_size"),
            (p.get("price_band") or {})))
    target = mine[0]

    # ---- 2. does the key work at all --------------------------------------
    print("\n2. Key and permissions (read-only)")
    show("GET /v2/orders", call(key, secret, "GET", "/v2/orders",
                                "?states=open&page_size=5"))

    if not args.place:
        print("\nRead-only run finished. Nothing was placed.")
        print("Re-run with --place to post one post-only contract at 0.0001")
        print("and cancel it, which is what actually answers the question.")
        return 0

    # ---- 3. the actual test ------------------------------------------------
    print("\n3. Post-only limit order on %s" % target["symbol"])
    print("   1 contract, buy, limit 0.0001 (the price band floor).")
    print("   post_only, so it rests or is rejected - it cannot cross.")

    order_id = None
    try:
        res = show("POST /v2/orders", call(key, secret, "POST", "/v2/orders", "", {
            "product_id": target["id"],
            "size": 1,
            "side": "buy",
            "order_type": "limit_order",
            "limit_price": "0.0001",
            "post_only": True,
            "time_in_force": "gtc",
        }))
        if res:
            order_id = res.get("id")
            print("       state=%s  id=%s  unfilled=%s" % (
                res.get("state"), order_id, res.get("unfilled_size")))
            print("\n   => Predict contracts ACCEPT API limit orders.")
        else:
            print("\n   => Rejected. The error above says whether that is the")
            print("      product, the permissions, or the price.")
    finally:
        if order_id:
            print("\n4. Cancelling")
            show("DELETE /v2/orders", call(key, secret, "DELETE", "/v2/orders", "", {
                "id": order_id, "product_id": target["id"],
            }))
        else:
            print("\n4. Nothing to cancel.")

    print("\nCheck the app as well: a resting order should be visible there.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
