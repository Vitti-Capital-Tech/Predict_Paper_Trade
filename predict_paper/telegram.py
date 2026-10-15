"""Telegram alerts for the worker.

Two kinds of message, routed differently:

  * Errors - something failed and a person may need to act. They go to the
    admin group (TELEGRAM_ERROR_CHAT_ID), which watches every account, AND to
    the account's own chat, so the owner hears about their own account too.
    Faults with no account - the database, the engine itself - go to the admin
    group only. Warnings - things already handled - skip the group and go to
    the account's chat alone; the group asked for bugs only.
  * Trades - an entry, an exit, a settlement. They go to the account's own
    chat, so each account's owner sees their own book and nobody else's.

Nothing here may slow the trading loop. Sends are queued and made by one
background thread; a slow or unreachable Telegram costs the engine nothing,
and a failure to alert is logged rather than raised.

Identical errors within TELEGRAM_DEDUPE_SEC (default 60) are sent once, so a
fault that repeats every cycle produces one message rather than thirty.

This bot must not be shared with another engine. Telegram allows one
getUpdates consumer per bot; a second one is refused with 409 Conflict, and
the two would take each other's /start links. Option_Scope runs its own bot -
this one needs a separate token from @BotFather.

Env:
  TELEGRAM_BOT_TOKEN       required to send anything
  TELEGRAM_ERROR_CHAT_ID   optional - where every error goes
  TELEGRAM_CHAT_ID         optional - fallback when nothing else is set
  TELEGRAM_DEDUPE_SEC      optional - default 60
"""
from __future__ import annotations

import logging
import os
import queue
import threading
import time
from datetime import datetime, timezone
from html import escape
from typing import Callable, Dict, Optional

import requests

log = logging.getLogger("predict.telegram")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
ERROR_CHAT = os.environ.get("TELEGRAM_ERROR_CHAT_ID", "").strip()
DEFAULT_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
DEDUPE_SEC = float(os.environ.get("TELEGRAM_DEDUPE_SEC", "60") or 60)

API = "https://api.telegram.org/bot%s/%s"

# Levels, as the alert handbook describes them. The icon is the first thing
# read on a phone lock screen, so it carries the urgency.
RED, AMBER, YELLOW = "red", "amber", "yellow"
# AMBER was a warning sign and "CHECK SOON", which the admin group read as
# just as urgent as red. It is the level for a record to look at, not money at
# risk now, and says so.
_ICON = {RED: "\U0001F6A8", AMBER: "\U0001F535", YELLOW: "\U0001F7E1"}
_LABEL = {RED: "ACT NOW", AMBER: "REVIEW (not urgent)", YELLOW: "NOTE"}


def enabled() -> bool:
    return bool(TOKEN)


class _Sender:
    """One background thread draining a queue, so a send never blocks a cycle."""

    def __init__(self) -> None:
        self.q: "queue.Queue[tuple]" = queue.Queue(maxsize=500)
        self.session = requests.Session()
        self._last: Dict[str, float] = {}
        self._lock = threading.Lock()
        t = threading.Thread(target=self._run, name="telegram-send", daemon=True)
        t.start()

    def submit(self, chat_id: str, text: str, dedupe_key: Optional[str]) -> None:
        if not TOKEN or not chat_id:
            return
        if dedupe_key:
            now = time.time()
            with self._lock:
                if now - self._last.get(dedupe_key, 0.0) < DEDUPE_SEC:
                    return
                self._last[dedupe_key] = now
                if len(self._last) > 2000:            # bounded
                    cutoff = now - DEDUPE_SEC
                    self._last = {k: v for k, v in self._last.items() if v >= cutoff}
        try:
            self.q.put_nowait((chat_id, text))
        except queue.Full:
            log.warning("telegram queue full - dropping a message")

    def _run(self) -> None:
        while True:
            chat_id, text = self.q.get()
            for attempt in range(3):
                try:
                    r = self.session.post(API % (TOKEN, "sendMessage"), timeout=10, data={
                        "chat_id": chat_id, "text": text, "parse_mode": "HTML",
                        "disable_web_page_preview": "true"})
                    if r.status_code == 429:
                        # Telegram says how long; honour it rather than guessing.
                        wait = float((r.json().get("parameters") or {})
                                     .get("retry_after", 2))
                        time.sleep(min(wait, 60))
                        continue
                    if r.status_code >= 400:
                        log.warning("telegram send to %s refused: %s %s",
                                    chat_id, r.status_code, r.text[:200])
                    break
                except Exception as exc:  # noqa: BLE001
                    log.warning("telegram send failed (%d): %s", attempt + 1, exc)
                    time.sleep(2 * (attempt + 1))
            # Stay well inside Telegram's per-chat limit.
            time.sleep(1.1)


_sender: Optional[_Sender] = None


def _get() -> Optional[_Sender]:
    global _sender
    if not TOKEN:
        return None
    if _sender is None:
        _sender = _Sender()
    return _sender


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def notify_failure(level: str, account: str, what: str, error: str = "",
                   extra: str = "", chat_id: str = "",
                   warning: bool = False) -> None:
    """An error a person may need to act on.

    Laid out like the Option_Scope handbook - Account, What, Error, an optional
    detail line, the time - so the same handbook reading works for both.

    `warning` marks something the engine has already handled - a buy Delta
    was slow to confirm, which reconciliation then finds - as against a bug.
    The admin group asked for bugs only, so a warning goes to the account's
    own chat and nowhere else.
    """
    s = _get()
    if not s:
        return
    if warning:
        dests = [chat_id] if chat_id else []
        if not dests:
            return
    else:
        # Both: the admin group watches every account, and the owner hears
        # about their own. A chat that is both - the owner linked the admin
        # group - gets it once. Neither set falls back to the default chat.
        dests = [d for d in dict.fromkeys([ERROR_CHAT, chat_id]) if d] or (
            [DEFAULT_CHAT] if DEFAULT_CHAT else [])
    lines = ["%s <b>DELTA GLOBAL %s</b>" % (_ICON.get(level, ""), _LABEL.get(level, "ALERT")),
             "<b>Account:</b> %s" % escape(account or "-"),
             "<b>What:</b> %s" % escape(what)]
    if error:
        lines.append("<b>Error:</b> %s" % escape(str(error)[:300]))
    if extra:
        lines.append("<code>%s</code>" % escape(extra[:200]))
    lines.append(_stamp())
    text = "\n".join(lines)
    for dest in dests:
        s.submit(dest, text, "%s|%s|%s|%s" % (dest, account, what, error))


def notify_system(title: str, detail: str = "", level: str = RED) -> None:
    """A fault in the engine itself rather than in one account - the database,
    for instance. Always to the error group, or the default chat."""
    s = _get()
    if not s:
        return
    dest = ERROR_CHAT or DEFAULT_CHAT
    text = "%s <b>%s</b>\n%s\n%s" % (_ICON.get(level, ""), escape(title),
                                     escape(detail), _stamp())
    s.submit(dest, text, "sys|%s" % title)


def notify_resolved(title: str, detail: str = "") -> None:
    """The all-clear after a system fault. Never de-duplicated: a recovery is
    news every time, and missing one would leave an outage looking unresolved."""
    s = _get()
    if not s:
        return
    dest = ERROR_CHAT or DEFAULT_CHAT
    s.submit(dest, "✅ <b>%s</b>\n%s\n%s" % (escape(title), escape(detail), _stamp()), None)


def notify_trade(account: str, title: str, detail: str = "",
                 pnl: Optional[float] = None, chat_id: str = "") -> None:
    """A normal trade message - not an error, no action needed. To the
    account's own chat; skipped when the account has not connected one, so
    trade chatter never lands in the error group."""
    s = _get()
    if not s or not chat_id:
        return
    lines = ["<b>%s</b>" % escape(title), "<b>Account:</b> %s" % escape(account)]
    if detail:
        lines.append(escape(detail))
    if pnl is not None:
        lines.append("<b>P&amp;L:</b> %s$%.2f" % ("+" if pnl >= 0 else "-", abs(pnl)))
    lines.append(_stamp())
    s.submit(chat_id, "\n".join(lines), None)


def reply(chat_id: str, text: str) -> None:
    s = _get()
    if s:
        s.submit(chat_id, text, None)


# ---------------------------------------------------------------- linking --
def start_link_listener(on_start: Callable[[str, str, str], Optional[str]]) -> None:
    """Long-poll for `/start <code>` and hand each to `on_start`.

    The dashboard writes a random code against an account and opens
    t.me/<bot>?start=<code>. Pressing Start sends `/start <code>` here;
    `on_start(code, chat_id, who)` binds that chat to the account and returns
    the account name, or None if the code matches nothing.

    One consumer per bot - see the module docstring.
    """
    if not TOKEN:
        return

    def run() -> None:
        session = requests.Session()
        offset = None
        while True:
            try:
                params = {"timeout": 50, "allowed_updates": '["message"]'}
                if offset is not None:
                    params["offset"] = offset
                r = session.get(API % (TOKEN, "getUpdates"), params=params, timeout=60)
                if r.status_code == 409:
                    # Another process is polling this bot. Fatal for linking,
                    # and almost always means the token is shared.
                    log.error("telegram getUpdates 409: another process is using "
                              "this bot - give Predict its own bot token")
                    time.sleep(60)
                    continue
                body = r.json() if r.content else {}
                for upd in body.get("result", []):
                    offset = upd["update_id"] + 1
                    msg = upd.get("message") or {}
                    text = (msg.get("text") or "").strip()
                    chat = msg.get("chat") or {}
                    chat_id = str(chat.get("id") or "")
                    if not chat_id:
                        continue
                    # Setting up the error group needs its numeric id, which
                    # Telegram shows nowhere obvious. Add the bot to the group
                    # and send /chatid; it answers with the number to put in
                    # TELEGRAM_ERROR_CHAT_ID.
                    if text.split("@")[0] == "/chatid":
                        reply(chat_id, "This chat's id is <code>%s</code>" % chat_id)
                        continue
                    if not text.startswith("/start"):
                        continue
                    parts = text.split(maxsplit=1)
                    code = parts[1].strip() if len(parts) > 1 else ""
                    who = chat.get("title") or chat.get("username") or chat.get("first_name") or ""
                    if not code:
                        reply(chat_id, "Open the link from the Predict dashboard to "
                                       "connect an account.")
                        continue
                    try:
                        name = on_start(code, chat_id, who)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("telegram link failed: %s", exc)
                        name = None
                    if name:
                        reply(chat_id, "✅ Connected to <b>%s</b>. Trade updates "
                                       "for this account will arrive here." % escape(name))
                        log.info("TELEGRAM linked %s -> chat %s", name, chat_id)
                    else:
                        reply(chat_id, "That link has expired or was already used. "
                                       "Generate a new one from the dashboard.")
            except Exception as exc:  # noqa: BLE001
                log.warning("telegram listener: %s", exc)
                time.sleep(5)

    threading.Thread(target=run, name="telegram-listen", daemon=True).start()
