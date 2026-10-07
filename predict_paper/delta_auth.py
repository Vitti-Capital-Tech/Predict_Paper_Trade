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
from typing import Any, Dict, Optional, Tuple

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


class DeltaAuthError(RuntimeError):
    """A rejected signed call, with whatever Delta said about why."""

    def __init__(self, message: str, code: str = "", seen_ip: str = "",
                 status: int = 0):
        super().__init__(message)
        self.code = code
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
            raise DeltaAuthError("%s %s timed out after %.0fs"
                                 % (method, path, timeout)) from exc
        except Exception as exc:  # noqa: BLE001
            raise DeltaAuthError("%s %s failed: %s" % (method, path, exc)) from exc

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
            raise DeltaAuthError(msg, code=code, seen_ip=seen, status=r.status_code)

        return (payload or {}).get("result")

    # ---- calls ----------------------------------------------------------
    def wallet_balances(self) -> Any:
        """Cheapest authenticated read.

        Used as the connection check: one call proves the key, the secret, the
        clock, the entity and the IP allowlist together. Anything wrong with
        any of them shows up here rather than on a live order.
        """
        return self._request("GET", "/v2/wallet/balances")


def check_connection(api_key: str, api_secret: str, base_url: str = GLOBAL
                     ) -> Tuple[bool, str, str]:
    """Verify one set of credentials.

    Returns (ok, message, seen_ip). Never raises: the caller is storing the
    answer against an account, and a failure to connect is itself the answer.
    """
    client = DeltaAuthClient(api_key, api_secret, base_url)
    try:
        result = client.wallet_balances()
    except DeltaAuthError as exc:
        return False, str(exc), exc.seen_ip
    except Exception as exc:  # noqa: BLE001
        return False, str(exc), ""

    rows = result if isinstance(result, list) else []
    funded = [r for r in rows
              if _f(r.get("available_balance")) or _f(r.get("balance"))]
    if not rows:
        return True, "connected; no wallet balances returned", ""
    if not funded:
        return True, "connected; all wallets are empty", ""
    summary = ", ".join(
        "%s %s" % (_fmt(r.get("available_balance") or r.get("balance")),
                   (r.get("asset_symbol") or (r.get("asset") or {}).get("symbol") or "?"))
        for r in funded[:3])
    return True, "connected; %s" % summary, ""


def _f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _fmt(v: Any) -> str:
    f = _f(v)
    return ("%.8f" % f).rstrip("0").rstrip(".") if f else "0"
