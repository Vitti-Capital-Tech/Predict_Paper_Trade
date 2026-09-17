"""Supabase persistence for the worker.

Talks to PostgREST directly with `requests` rather than pulling in a client
library, so there is one HTTP dependency and no version drift.

Every method is best-effort: if Supabase is unreachable the engine keeps
trading on its local JSONL ledger rather than dying mid-round.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger(__name__)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class NullStore:
    """Used when Supabase is not configured - the engine runs local-only."""

    enabled = False
    run_id = None

    def start_run(self, *a: Any, **k: Any) -> None: return None
    def upsert_position(self, *a: Any, **k: Any) -> None: return None
    def log_event(self, *a: Any, **k: Any) -> None: return None
    def snapshot(self, *a: Any, **k: Any) -> None: return None
    def heartbeat(self, *a: Any, **k: Any) -> None: return None
    def finish_run(self, *a: Any, **k: Any) -> None: return None
    def pending_manual_orders(self, *a: Any, **k: Any) -> list: return []
    def adjust_account_balance(self, *a: Any, **k: Any) -> None: return None
    def resolve_manual_order(self, *a: Any, **k: Any) -> None: return None


class SupabaseStore:
    enabled = True

    def __init__(self, url: str, service_key: str, timeout: float = 10.0):
        self.base = url.rstrip("/") + "/rest/v1"
        self.timeout = timeout
        self.run_id: Optional[int] = None
        self._lock = threading.Lock()
        self._failures = 0
        self._last_error = ""
        self._missing_columns: set = set()
        self.session = requests.Session()
        self.session.headers.update({
            "apikey": service_key,
            "Authorization": "Bearer %s" % service_key,
            "Content-Type": "application/json",
        })

    # ---- transport ------------------------------------------------------
    def _post(self, table: str, rows: Any, prefer: str = "return=minimal",
              params: Optional[Dict[str, str]] = None) -> Optional[List[Dict]]:
        url = "%s/%s" % (self.base, table)
        try:
            r = self.session.post(url, json=rows, timeout=self.timeout,
                                  params=params or {},
                                  headers={"Prefer": prefer})
            if r.status_code >= 400:
                self._note_failure("%s -> %s %s" % (table, r.status_code, r.text[:200]))
                return None
            self._failures = 0
            self._last_error = ""
            if "return=representation" in prefer and r.content:
                return r.json()
            return []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("%s -> %s" % (table, exc))
            return None

    def _patch(self, table: str, payload: Dict[str, Any],
               params: Dict[str, str]) -> None:
        url = "%s/%s" % (self.base, table)
        try:
            r = self.session.patch(url, json=payload, params=params,
                                   timeout=self.timeout,
                                   headers={"Prefer": "return=minimal"})
            if r.status_code >= 400:
                self._note_failure("%s patch -> %s %s" % (table, r.status_code, r.text[:200]))
        except Exception as exc:  # noqa: BLE001
            self._note_failure("%s patch -> %s" % (table, exc))

    def _note_failure(self, msg: str) -> None:
        self._last_error = msg
        self._failures += 1
        # Warn on the first few, then go quiet so a long outage cannot flood the log.
        if self._failures <= 3 or self._failures % 50 == 0:
            log.warning("supabase write failed (%d): %s", self._failures, msg)

    # ---- api ------------------------------------------------------------
    def start_run(self, run_name: str, config: Dict[str, Any],
                  starting_cash: float) -> Optional[int]:
        rows = self._post("runs", {
            "run_name": run_name,
            "status": "running",
            "starting_cash": starting_cash,
            "cash": starting_cash,
            "config": config,
        }, prefer="return=representation")
        if rows:
            self.run_id = rows[0].get("id")
            log.info("supabase: run #%s registered (%s)", self.run_id, run_name)
        return self.run_id

    def upsert_position(self, pos: Dict[str, Any]) -> None:
        if self.run_id is None:
            return
        row = {
            "run_id": self.run_id,
            "position_id": pos["position_id"],
            "round_id": pos["round_id"],
            "symbol": pos["symbol"],
            "role": pos["role"],
            "side": pos["side"],
            "strike": pos["strike"],
            "qty": pos["qty"],
            "entry_price": pos["entry_price"],
            "entry_time": _iso(pos["entry_time"]),
            "entry_top_price": pos.get("entry_top_price"),
            "entry_slippage": pos.get("entry_slippage") or 0,
            "entry_levels": pos.get("entry_levels") or 0,
            "entry_spot": pos.get("entry_spot"),
            "entry_atr": pos.get("entry_atr"),
            "status": pos.get("status", "open"),
            "exit_price": pos.get("exit_price"),
            "exit_time": _iso(pos.get("exit_time")),
            "exit_reason": pos.get("exit_reason"),
            "exit_slippage": pos.get("exit_slippage") or 0,
            "fees": pos.get("fees") or 0,
            "settlement_spot": pos.get("settlement_spot"),
            "account_id": pos.get("account_id"),
        }
        # Columns added by later migrations. If the migration has not been run,
        # PostgREST rejects the whole row, which would silently stop recording
        # positions - so drop the column once and carry on.
        for col in list(self._missing_columns):
            row.pop(col, None)

        with self._lock:
            ok = self._post("positions", row,
                            prefer="resolution=merge-duplicates,return=minimal",
                            params={"on_conflict": "run_id,position_id"})
            if ok is None and self._last_error:
                for col in ("settlement_spot", "account_id"):
                    if col in row and col in self._last_error:
                        log.warning("column '%s' missing in Supabase - run the "
                                    "matching migration; continuing without it", col)
                        self._missing_columns.add(col)
                        row.pop(col, None)
                        self._post("positions", row,
                                   prefer="resolution=merge-duplicates,return=minimal",
                                   params={"on_conflict": "run_id,position_id"})
                        break

    def log_event(self, kind: str, round_id: Optional[str] = None,
                  symbol: Optional[str] = None, reason: Optional[str] = None,
                  **payload: Any) -> None:
        if self.run_id is None:
            return
        with self._lock:
            self._post("events", {
                "run_id": self.run_id,
                "ts": datetime.now(timezone.utc).isoformat(),
                "kind": kind,
                "round_id": round_id,
                "symbol": symbol,
                "reason": reason,
                "payload": payload,
            })

    def snapshot(self, spot: Optional[float], atr: Optional[float],
                 atr_pass: bool, rounds: List[Dict[str, Any]]) -> None:
        if self.run_id is None:
            return
        with self._lock:
            self._post("market_snapshots", {
                "run_id": self.run_id,
                "ts": datetime.now(timezone.utc).isoformat(),
                "spot": spot, "atr": atr, "atr_pass": atr_pass,
                "rounds": rounds,
            })

    def heartbeat(self, cash: float) -> None:
        if self.run_id is None:
            return
        self._patch("runs",
                    {"last_heartbeat": datetime.now(timezone.utc).isoformat(),
                     "cash": cash},
                    {"id": "eq.%d" % self.run_id})

    # ---- manual orders from the trade panel -----------------------------
    def pending_manual_orders(self) -> List[Dict[str, Any]]:
        url = "%s/manual_orders" % self.base
        try:
            r = self.session.get(url, timeout=self.timeout, params={
                "status": "eq.pending", "order": "created_at.asc", "limit": "25",
            })
            if r.status_code >= 400:
                self._note_failure("manual_orders -> %s" % r.status_code)
                return []
            return r.json() or []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("manual_orders -> %s" % exc)
            return []

    def resolve_manual_order(self, order_id: int, status: str,
                             position_id: Optional[str] = None,
                             fill_price: Optional[float] = None,
                             contracts: Optional[float] = None,
                             reject_reason: Optional[str] = None) -> None:
        payload: Dict[str, Any] = {
            "status": status,
            "run_id": self.run_id,
            "position_id": position_id,
            "fill_price": fill_price,
            "contracts": contracts,
            "reject_reason": reject_reason,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        self._patch("manual_orders", payload, {"id": "eq.%d" % int(order_id)})

    def adjust_account_balance(self, account_id: int, delta: float) -> None:
        """Move a paper account's balance by `delta`, atomically.

        Uses the SQL function from migration 004 rather than read-modify-write,
        so a debit and a credit arriving together cannot clobber each other.
        """
        if not account_id:
            return
        with self._lock:
            self._post("rpc/adjust_account_balance",
                       {"p_account_id": int(account_id), "p_delta": float(delta)})

    def finish_run(self, cash: float, status: str = "stopped") -> None:
        if self.run_id is None:
            return
        self._patch("runs",
                    {"status": status, "cash": cash,
                     "last_heartbeat": datetime.now(timezone.utc).isoformat()},
                    {"id": "eq.%d" % self.run_id})


def build_store(url: Optional[str] = None, key: Optional[str] = None):
    """Create a store from explicit args or the environment.

    Reads SUPABASE_URL and SUPABASE_SERVICE_KEY (falling back to
    SUPABASE_SERVICE_ROLE_KEY). Returns a NullStore when unset.
    """
    url = url or os.environ.get("SUPABASE_URL")
    key = (key or os.environ.get("SUPABASE_SERVICE_KEY")
           or os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not url or not key:
        log.info("Supabase not configured - running with the local ledger only")
        return NullStore()
    return SupabaseStore(url, key)
