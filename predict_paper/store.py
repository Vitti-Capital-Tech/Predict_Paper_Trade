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
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger(__name__)

# How long to keep believing a column is missing before testing it
# again. Long enough not to retry on every write, short enough that a
# migration takes effect while you are still watching for it.
RETRY_MISSING_COLUMN_SEC = 300.0


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
    def adoptable_positions(self, *a: Any, **k: Any) -> list: return []
    def strategy_configs(self, *a: Any, **k: Any) -> list: return []
    def accounts(self, *a: Any, **k: Any) -> list: return []
    def entered_round_keys(self, *a: Any, **k: Any) -> list: return []
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
        # Columns Supabase rejected, and when. Not a plain set: a column is
        # missing until someone runs the migration, and nothing here notices
        # that they have. Both entry_fills and exit_spot were written, the
        # migrations were run, and the worker went on dropping them for hours
        # because it had decided once and never asked again - which looks
        # exactly like the feature being broken.
        self._missing_columns: Dict[str, float] = {}
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
        # A position adopted from an abandoned run keeps that run's id, so the
        # close lands on the original row. Stamping the current run instead
        # would write a second row and leave the first one open forever -
        # which is the orphan this is all meant to prevent.
        run_id = pos.get("run_id") or self.run_id
        if run_id is None:
            return
        row = {
            "run_id": run_id,
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
            "entry_fills": pos.get("entry_fills") or 1,
            "fills": pos.get("fills") or [],
            "entry_spot": pos.get("entry_spot"),
            "entry_atr": pos.get("entry_atr"),
            "status": pos.get("status", "open"),
            "exit_price": pos.get("exit_price"),
            "exit_time": _iso(pos.get("exit_time")),
            "exit_reason": pos.get("exit_reason"),
            "exit_slippage": pos.get("exit_slippage") or 0,
            "exit_spot": pos.get("exit_spot"),
            "fees": pos.get("fees") or 0,
            "settlement_spot": pos.get("settlement_spot"),
            "account_id": pos.get("account_id"),
        }
        # Columns added by later migrations. If the migration has not been run,
        # PostgREST rejects the whole row, which would silently stop recording
        # positions - so drop the column once and carry on.
        # Ask again now and then, so running a migration is enough on its own
        # and does not silently also require a restart.
        now_ts = time.time()
        for col, dropped_at in list(self._missing_columns.items()):
            if now_ts - dropped_at > RETRY_MISSING_COLUMN_SEC:
                del self._missing_columns[col]
                log.info("re-trying column '%s' - its migration may have been "
                         "run since it was last rejected", col)
        for col in self._missing_columns:
            row.pop(col, None)

        with self._lock:
            ok = self._post("positions", row,
                            prefer="resolution=merge-duplicates,return=minimal",
                            params={"on_conflict": "run_id,position_id"})
            if ok is None and self._last_error:
                for col in ("settlement_spot", "account_id", "entry_fills",
                            "exit_spot", "fills"):
                    if col in row and col in self._last_error:
                        log.warning("column '%s' missing in Supabase - run the "
                                    "matching migration; continuing without it", col)
                        self._missing_columns[col] = time.time()
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

    # ---- remote settings ------------------------------------------------
    def strategy_configs(self) -> Optional[List[Dict[str, Any]]]:
        """Every account's settings row.

        Returns None on any failure, which the caller treats as "keep what you
        have" - a Supabase blip must not silently reset a live strategy to
        defaults. An empty list is a real answer and means no account is
        configured, which is different from not knowing.
        """
        try:
            r = self.session.get("%s/strategy_config" % self.base,
                                 timeout=self.timeout, params={"limit": "200"})
            if r.status_code >= 400:
                self._note_failure("strategy_config -> %s" % r.status_code)
                return None
            return r.json() or []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("strategy_config -> %s" % exc)
            return None

    def entered_round_keys(self) -> Optional[List[Dict[str, Any]]]:
        """Every leg entered recently, whoever owns it - account, round,
        strike, symbol and role.

        Deliberately not filtered to `status = open`. The question this answers
        is "has this account already been in this strike this round", and a
        position closed early answers it just as much as one still open - more
        so, in fact, since re-entering a strike the strategy has just taken
        profit on is the exact case worth refusing.

        Also not filtered the way `adoptable_positions` is, which ignores
        positions a live worker still holds: a worker starting while another
        finishes must still see the rounds its predecessor is in.

        Newest first and capped, because only live rounds are ever looked up.
        At three legs an account and a round every fifteen minutes, a thousand
        rows reaches back further than any round still open.
        """
        try:
            r = self.session.get("%s/positions" % self.base, timeout=self.timeout,
                                 params={"select": "account_id,round_id,symbol,"
                                                   "role,strike",
                                         "order": "entry_time.desc",
                                         "limit": "1000"})
            if r.status_code >= 400:
                self._note_failure("entered rounds -> %s" % r.status_code)
                return None
            return r.json() or []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("entered rounds -> %s" % exc)
            return None

    def accounts(self) -> Optional[List[Dict[str, Any]]]:
        """Accounts, for the balance each strategy is spending and its mode.

        `select=*` rather than naming columns: `mode` arrives with migration
        022, and asking for a column the table does not have yet is a 400 that
        would take every account down with it - including the paper ones that
        were trading perfectly well before.
        """
        try:
            r = self.session.get("%s/accounts" % self.base, timeout=self.timeout,
                                 params={"select": "*", "limit": "200"})
            if r.status_code >= 400:
                self._note_failure("accounts -> %s" % r.status_code)
                return None
            return r.json() or []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("accounts -> %s" % exc)
            return None

    # ---- live credentials -----------------------------------------------
    def credentials_awaiting_check(self) -> List[Dict[str, Any]]:
        """Live accounts whose credentials have been saved but not proven.

        The dashboard cannot run this check itself: Delta authorises by IP and
        the whitelisted address is this host's, not the browser's. So the
        browser sets the status back to 'unverified' and this picks it up.
        """
        try:
            r = self.session.get("%s/delta_credentials" % self.base,
                                 timeout=self.timeout,
                                 params={"select": "account_id",
                                         "status": "eq.unverified",
                                         "limit": "20"})
            if r.status_code >= 400:
                # Before migration 023 the table does not exist. That is not a
                # failure worth counting against the store's health.
                if r.status_code not in (404, 400):
                    self._note_failure("credentials -> %s" % r.status_code)
                return []
            return r.json() or []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("credentials -> %s" % exc)
            return []

    def claim_credential_checks(self) -> List[Dict[str, Any]]:
        """Staged checks for credentials not yet attached to an account.

        The form verifies before it creates, so these arrive with no account
        behind them. Claiming marks them taken in the same statement, so two
        workers cannot both answer one.
        """
        rows = self._post("rpc/claim_delta_checks", {},
                          prefer="return=representation")
        return rows if isinstance(rows, list) else []

    def set_credential_check(self, check_id: str, status: str,
                             balance: Optional[float] = None,
                             message: str = "", seen_ip: str = "") -> None:
        self._post("rpc/set_delta_check", {
            "p_id": check_id,
            "p_status": status,
            "p_balance": balance,
            "p_message": (message or None),
            "p_seen_ip": (seen_ip or None),
        })

    def credentials_decrypted(self, account_id: int) -> Optional[Dict[str, Any]]:
        """Key, secret and entity for one account. service_role only."""
        rows = self._post("rpc/get_delta_credentials_decrypted",
                          {"p_account_id": account_id},
                          prefer="return=representation")
        if not rows:
            return None
        return rows[0] if isinstance(rows, list) else rows

    def set_verification(self, account_id: int, status: str,
                         error: str = "", seen_ip: str = "",
                         balance: Optional[float] = None) -> None:
        """Record the verdict, and the balance it came back with.

        A verification already asks Delta what the account holds, so the
        figure is free. Writing it is what keeps a live account's balance from
        being a snapshot taken once when it was created.
        """
        payload = {
            "p_account_id": account_id,
            "p_status": status,
            "p_error": (error or None),
            "p_seen_ip": (seen_ip or None),
            "p_balance": balance,
        }
        if self._post("rpc/set_delta_verification", payload) is not None:
            return
        # Migration 026 adds p_balance. Until it is run the function does not
        # take one, and sending it fails the whole call - which would leave a
        # check stuck on "verifying" rather than merely missing a balance.
        # Retried without it so the verdict still lands either way.
        payload.pop("p_balance", None)
        self._post("rpc/set_delta_verification", payload)

    # ---- recovery -------------------------------------------------------
    def adoptable_positions(self, stale_after_sec: float = 120.0) -> List[Dict[str, Any]]:
        """Open positions left behind by a worker that is no longer running.

        Positions live in the worker's memory, so a restart, a redeploy or a
        crash used to abandon them: still `open` in the table, never settled,
        impossible to close from the panel. This finds them so a starting
        worker can take them over.

        A run that is still heartbeating owns its positions, and adopting those
        would have two workers settling the same trade and crediting the
        account twice. So a run counts as abandoned only once its heartbeat has
        gone quiet - which a crash produces and a healthy worker never does.
        """
        try:
            r = self.session.get("%s/positions" % self.base, timeout=self.timeout,
                                 params={"status": "eq.open", "limit": "500"})
            if r.status_code >= 400:
                self._note_failure("adoptable positions -> %s" % r.status_code)
                return []
            rows = r.json() or []
        except Exception as exc:  # noqa: BLE001
            self._note_failure("adoptable positions -> %s" % exc)
            return []
        if not rows:
            return []

        try:
            q = self.session.get("%s/runs" % self.base, timeout=self.timeout,
                                 params={"select": "id,last_heartbeat", "limit": "500"})
            beats = {row["id"]: row.get("last_heartbeat")
                     for row in (q.json() or [])} if q.status_code < 400 else {}
        except Exception as exc:  # noqa: BLE001
            self._note_failure("runs heartbeat -> %s" % exc)
            return []

        now = datetime.now(timezone.utc)
        out = []
        for row in rows:
            rid = row.get("run_id")
            if rid == self.run_id:
                continue
            beat = beats.get(rid)
            if beat:
                try:
                    seen = datetime.fromisoformat(str(beat).replace("Z", "+00:00"))
                    if seen.tzinfo is None:
                        seen = seen.replace(tzinfo=timezone.utc)
                    if (now - seen).total_seconds() < stale_after_sec:
                        continue  # another worker is alive and owns this
                except ValueError:
                    pass
            out.append(row)
        return out

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
