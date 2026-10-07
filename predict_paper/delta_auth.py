"""Authenticated Delta Exchange client.

Separate from `delta.py`, which is public market data and signs nothing. Every
call here carries a live account's key and secret, so the two are kept apart
rather than branching inside one client: it should not be possible to reach a
signed call by accident.

Delta's scheme:

    signature = HMAC_SHA256(secret, method + timestamp + path + query + body)

`timestamp` is Unix seconds and `query` includes its leading '?'. Signatures
older than five seconds are rejected, so one is produced immediately before the
request goes out and never cached.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, NamedTuple, Optional, Tuple

import requests

log = logging.getLogger("predict.delta_auth")

# Predict's binary markets are listed on the global entity only. Asked for the
# same binary products on 07 Oct 2026, api.delta.exchange returned twelve and
# api.india.delta.exchange returned none, so an India key cannot trade these.
GLOBAL = "https://api.delta.exchange"
INDIA = "https://api.india.delta.exchange"

# A stale read is worth nothing and the caller asks again shortly, so reads give
# up quickly. Writes are given much longer on purpose: abandoning an order that
# Delta has already accepted leaves a position on the exchange that nothing here
# knows about, which is far worse than waiting.
READ_TIMEOUT = 6.0
WRITE_TIMEOUT = 15.0


def force_ipv4() -> None:
    """Make outbound HTTP use IPv4, so Delta sees the address we whitelisted.

    `api.delta.exchange` publishes AAAA records and this host has an IPv6
    route, so connections went out over v6 and Delta saw
    2406:da1a:... instead of the elastic IPv4 on the allowlist - rejected as
    `ip_not_whitelisted_for_api_key`, which reads like a credentials problem
    rather than a routing one.

    Whitelisting the v6 address instead is not the fix: it is DHCPv6-leased
    with a 400-second lifetime, so an allowlist built on it is one renewal
    away from breaking.

    This changes the whole process, which is intended. The only hosts it talks
    to are Delta and Supabase, both reachable over IPv4, and one predictable
    egress address is worth more here than dual-stack.
    """
    import socket
    import urllib3.util.connection as urllib3_conn

    urllib3_conn.allowed_gai_family = lambda: socket.AF_INET


class DeltaAuthError(RuntimeError):
    """A rejected signed call, with whatever Delta said about why."""

    def __init__(self, message: str, code: str = "", seen_ip: str = "",
                 status: int = 0, indeterminate: bool = False):
        super().__init__(message)
        self.code = code
        # Whether the exchange may have acted on this anyway. A timeout or a
        # 5xx on a write says nothing about whether the order was accepted -
        # and treating that as a refusal is how a leg gets ordered twice. Only
        # a 4xx with a reason is a real refusal.
        self.indeterminate = indeterminate
        # The address Delta saw. It arrives in the error body and is the only
        # authoritative answer to which IP needs whitelisting - inferring it
        # from the host's own interfaces gets IPv6 wrong.
        self.seen_ip = seen_ip
        self.status = status


class DeltaAuthClient:
    def __init__(self, api_key: str, api_secret: str,
                 base_url: str = GLOBAL, timeout: Optional[float] = None):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")
        self._timeout_override = timeout
        self.session = requests.Session()

    # ---- transport ------------------------------------------------------
    def _sign(self, method: str, path: str, query: str, body: str
              ) -> Tuple[str, str]:
        ts = str(int(time.time()))
        message = method + ts + path + query + body
        sig = hmac.new(self.api_secret.encode(), message.encode(),
                       hashlib.sha256).hexdigest()
        return sig, ts

    def _request(self, method: str, path: str,
                 query: str = "", body: Optional[Dict[str, Any]] = None) -> Any:
        # Separators matter: the signature is over this exact string, so the
        # body must be serialised once and both signed and sent unchanged.
        body_str = json.dumps(body, separators=(",", ":")) if body else ""
        sig, ts = self._sign(method, path, query, body_str)
        timeout = self._timeout_override or (
            READ_TIMEOUT if method == "GET" else WRITE_TIMEOUT)

        headers = {
            "api-key": self.api_key,
            "signature": sig,
            "timestamp": ts,
            "Content-Type": "application/json",
            "User-Agent": "predict-worker",
        }
        url = self.base_url + path + query
        try:
            r = self.session.request(method, url, headers=headers,
                                     data=body_str or None, timeout=timeout)
        except requests.Timeout as exc:
            raise DeltaAuthError(
                "%s %s timed out after %.0fs" % (method, path, timeout),
                indeterminate=(method != "GET")) from exc
        except Exception as exc:  # noqa: BLE001
            raise DeltaAuthError(
                "%s %s failed: %s" % (method, path, exc),
                indeterminate=(method != "GET")) from exc

        try:
            payload = r.json()
        except ValueError:
            payload = None

        if r.status_code >= 400 or (payload or {}).get("success") is False:
            err = ((payload or {}).get("error") or {})
            if isinstance(err, str):
                err = {"code": err}
            code = err.get("code") or ""
            seen = str((err.get("context") or {}).get("client_ip") or "")
            msg = code or err.get("message") or "HTTP %d on %s" % (r.status_code, path)
            if seen:
                msg = "%s (Delta saw %s)" % (msg, seen)
            # Delta's own 5xx is its problem, not a verdict on the order.
            raise DeltaAuthError(msg, code=code, seen_ip=seen,
                                 status=r.status_code,
                                 indeterminate=(method != "GET"
                                                and r.status_code >= 500))

        return (payload or {}).get("result")

    # ---- calls ----------------------------------------------------------
    def place_order(self, order: Dict[str, Any]) -> Any:
        """POST /v2/orders.

        Fields used here: product_symbol, size (integer contracts), side
        ('buy'|'sell'), order_type, limit_price (string), time_in_force and
        client_order_id.
        """
        return self._request("POST", "/v2/orders", body=order)

    def open_positions(self) -> Any:
        """What the exchange says this account is holding.

        The authority on that, as against anything recorded here: a write that
        timed out may still have been accepted.
        """
        return self._request("GET", "/v2/positions/margined")

    def cancel_order(self, order_id: Any, product_id: Any) -> Any:
        return self._request("DELETE", "/v2/orders",
                             body={"id": order_id, "product_id": product_id})

    def wallet_balances(self) -> Any:
        """Cheapest authenticated read.

        Used as the connection check: one call proves the key, the secret, the
        clock, the entity and the IP allowlist together. Anything wrong with
        any of them shows up here rather than on a live order.
        """
        return self._request("GET", "/v2/wallet/balances")


def clean_price(price: Optional[float]) -> Optional[str]:
    """A computed price as Delta will accept it.

    Arithmetic on quotes leaves float noise - 0.7000000000000002 - and Delta
    rejects that as `bad_schema`. The inputs are already tick-aligned, so
    rounding to four places only strips the noise.
    """
    if price is None:
        return None
    try:
        f = float(price)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return ("%.4f" % f).rstrip("0").rstrip(".") or "0"


# Delta caps client_order_id, and an over-long one is refused as `bad_schema`.
MAX_COID = 36


def clamp_tag(tag: str) -> str:
    """Keep the tail: the end of the tag is what identifies the leg."""
    s = str(tag or "")
    return s if len(s) <= MAX_COID else s[-MAX_COID:]


class CheckResult(NamedTuple):
    ok: bool
    message: str
    seen_ip: str
    # Settlement-currency balance, which is what a Predict position is sized
    # in. None when the call failed, or when Delta reported no such wallet -
    # those are different from a genuine zero and the caller should not round
    # them together.
    balance: Optional[float]


# Predict settles in USD. Delta reports a wallet per asset, so the figure that
# matters is the one in the settlement currency - a BTC wallet is not spending
# money for this purpose. USDT is accepted as the same thing because Delta
# reports the margin wallet under either name depending on the account.
SETTLEMENT_ASSETS = ("USD", "USDT", "USDC")


def _asset_of(row: Dict[str, Any]) -> str:
    return str(row.get("asset_symbol")
               or (row.get("asset") or {}).get("symbol") or "").upper()


def check_connection(api_key: str, api_secret: str, base_url: str = GLOBAL
                     ) -> CheckResult:
    """Verify one set of credentials and report what the account holds.

    Never raises: the caller is storing the answer, and a failure to connect is
    itself the answer rather than an exception to handle.
    """
    client = DeltaAuthClient(api_key, api_secret, base_url)
    try:
        result = client.wallet_balances()
    except DeltaAuthError as exc:
        return CheckResult(False, str(exc), exc.seen_ip, None)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, str(exc), "", None)

    rows = [r for r in (result or []) if isinstance(r, dict)]
    settlement = [r for r in rows if _asset_of(r) in SETTLEMENT_ASSETS]
    if not settlement:
        held = ", ".join(sorted({_asset_of(r) for r in rows if _asset_of(r)})) or "none"
        return CheckResult(
            True, "connected, but no USD wallet on this account (holds: %s)" % held,
            "", None)

    # available_balance is what can actually be committed; `balance` includes
    # margin already pledged to open positions.
    total = sum(_f(r.get("available_balance") or r.get("balance"))
                for r in settlement)
    return CheckResult(True, "connected; %s USD available" % _fmt(total), "", total)


def _f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _fmt(v: Any) -> str:
    f = _f(v)
    return ("%.8f" % f).rstrip("0").rstrip(".") if f else "0"
