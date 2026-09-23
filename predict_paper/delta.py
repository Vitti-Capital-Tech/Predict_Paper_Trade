"""Thin, read-only client for the Delta Exchange public REST API.

Only public market-data endpoints are used - this system never places a real
order and needs no API key.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger(__name__)

BINARY_CONTRACT_TYPES = "binary_call_options,binary_put_options"


class DeltaError(RuntimeError):
    pass


class DeltaClient:
    def __init__(self, base_url: str = "https://api.delta.exchange",
                 timeout: float = 10.0, max_retries: int = 3):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json",
                                     "User-Agent": "predict-paper/0.1"})

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}{path}"
        last: Optional[Exception] = None
        for attempt in range(self.max_retries):
            try:
                r = self.session.get(url, params=params, timeout=self.timeout)
                if r.status_code == 429:
                    wait = float(r.headers.get("Retry-After", 1.0)) or 1.0
                    log.warning("rate limited on %s, sleeping %.1fs", path, wait)
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                body = r.json()
                if not body.get("success", False):
                    raise DeltaError(f"{path} returned success=false: {body.get('error')}")
                return body.get("result")
            except Exception as exc:  # noqa: BLE001 - retry any transport error
                last = exc
                if attempt == self.max_retries - 1:
                    break
                time.sleep(0.5 * (2 ** attempt))
        raise DeltaError(f"GET {path} failed after {self.max_retries} attempts: {last}")

    # ---- market data ----------------------------------------------------
    def live_binary_products(self) -> List[Dict[str, Any]]:
        """Binary products, with the field that says whether they trade.

        `state` is "live" for every one of these, including a round listed
        minutes ago that will not accept a taker order yet - which is why
        filtering on it changed nothing. `trading_status` is the real signal:

          disrupted_post_only    just listed; limit orders only, no taking
          operational            open for business
          disrupted_cancel_only  winding down; closing only

        Observed on one round: post_only from launch, operational by 311s.
        """
        return self._get("/v2/products", {
            "contract_types": BINARY_CONTRACT_TYPES,
            "states": "live",
            "page_size": 200,
        }) or []

    def binary_tickers(self) -> List[Dict[str, Any]]:
        """All live binary tickers in one call - the main polling endpoint."""
        return self._get("/v2/tickers", {"contract_types": BINARY_CONTRACT_TYPES}) or []

    def orderbook(self, symbol: str) -> Dict[str, Any]:
        return self._get(f"/v2/l2orderbook/{symbol}") or {}

    def candles(self, symbol: str, resolution: str, start: int, end: int) -> List[Dict[str, Any]]:
        rows = self._get("/v2/history/candles", {
            "symbol": symbol, "resolution": resolution,
            "start": int(start), "end": int(end),
        }) or []
        return sorted(rows, key=lambda c: c["time"])

    def product_by_symbol(self, symbol: str) -> Optional[Dict[str, Any]]:
        """Used after expiry to read the authoritative `settlement_price`."""
        try:
            return self._get(f"/v2/products/{symbol}")
        except DeltaError:
            return None

    def settlement_price(self, symbol: str) -> Optional[float]:
        prod = self.product_by_symbol(symbol)
        if not prod:
            return None
        sp = prod.get("settlement_price")
        if sp is None or str(prod.get("state")) == "live":
            return None
        try:
            return float(sp)
        except (TypeError, ValueError):
            return None
