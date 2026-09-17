# Delta Predict — Paper Trading System

Paper-trades the strategy on Delta Exchange **Predict** (BTC binary options) without
risking capital. Three pieces:

| Piece | What it does |
|---|---|
| `predict_paper/` (Python) | Polls Delta's public API, applies the rules, simulates fills against the **real order book** |
| `supabase/schema.sql` | Postgres tables for runs, positions, events and market snapshots |
| `web/` (React + Tailwind) | Responsive dashboard that reads Supabase live |

**Design docs:** [HLD](docs/HLD.md) (architecture, data flow, decisions) ·
[LLD](docs/LLD.md) (modules, algorithms, schema, config reference)

The worker is **read-only against Delta** — no API key, no authentication, and it
cannot place a real order.

---

## The market, as it actually works

Verified against the live API, not assumed:

- Symbols are `B-C-BTC-<strike>-<DDMMYYHHMM>` (call) and `B-P-BTC-...` (put).
  The UI's `B-BTC-75600-1609260115` is strike 75600 expiring 16 Sep 2026 01:15 UTC.
- A round lists **~20 minutes before expiry**, and a new one starts **every 15
  minutes**, so about two rounds are live at once.
- Each round has **exactly 3 strikes**, spaced 100 for BTC — so "1st / middle /
  last strike" maps cleanly onto low / mid / high.
- Contracts pay **1.0 USDT if in the money**, 0.0 otherwise, priced 0.0001–0.9999.
- Maker and taker commission are both reported as **0** for binaries.
- Expired products publish a `settlement_price`, so settlement is read from the
  venue rather than inferred from spot.
- Binaries exist on the **global** host (`api.delta.exchange`), not the India host.

---

## Setup

### 1. Python worker

```bash
pip install -r requirements.txt
```

### 2. Supabase

Create a project, then open **SQL Editor → New query**, paste all of
`supabase/schema.sql`, and run it.

Copy `.env.example` to `.env` and fill in:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
```

The **service role** key belongs here and nowhere else — it bypasses RLS so the
worker can write. The dashboard uses the anon key and is read-only.

### 3. Dashboard

```bash
cd web && npm install
```

Copy `web/.env.example` to `web/.env`:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

### 4. Check it all works

```bash
python verify_setup.py
```

---

## Running

Worker (one terminal):

```bash
python run_live.py
```

Dashboard (another terminal):

```bash
npm run dev --prefix web
```

Then open http://localhost:5173. To see the UI with sample data before Supabase
is wired up, open http://localhost:5173/?demo=1.

Other modes:

```bash
python run_live.py --dry-run          # single poll, prints what it sees
python run_live.py --duration 3600    # run an hour, then summarise
python run_live.py --report-only      # summarise an existing ledger
```

---

## Deploying

### What can and cannot go on Vercel

**Vercel hosts the dashboard only.** The worker in `predict_paper/` is a
long-running poller that must stay alive between polls, which serverless
functions cannot do — they are killed after seconds. Vercel will build and serve
`web/`, and nothing else in this repo runs there.

**The worker has to run somewhere that allows a persistent process**: your own
machine, a small VPS, Railway, Render, Fly.io, or a container anywhere. If no
worker is running, the dashboard connects fine and shows nothing, because
nothing is writing to Supabase.

### Vercel setup

`vercel.json` at the repo root already points the build at `web/`, so importing
the repo needs no Root Directory change. Add two environment variables in
**Project Settings → Environment Variables**:

```
VITE_SUPABASE_URL       https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY  <anon key>
```

Vite inlines `VITE_*` variables into the client bundle at build time, so
**redeploy after adding them** — changing them later without a rebuild has no
effect.

### Two things to be aware of

- The anon key is visible in the published bundle. That is normal and safe here:
  RLS grants it read-only access and the worker writes with the service role key.
  But it does mean **anyone with your Vercel URL can read your trading history**.
  If that matters, put Vercel Authentication (Deployment Protection) in front of
  it, or keep the dashboard local and skip Vercel entirely.
- The service role key belongs only in the worker's environment. Never add it to
  Vercel, and never prefix it with `VITE_`.

---

## Trade panel — manual paper trading

The dashboard has a **Trade** tab that clones Delta's Predict panel: strike and
expiry selectors, a 15m candle chart with the strike drawn on it, the YES/NO
buttons with live prices, dollar-denominated investment presets and a slippage
tolerance control.

Sizing matches the app exactly:

```
contracts = round(investment / price)      # $25 at 0.036 -> 694 contracts
invested  = contracts x price              # $24.98
payout    = contracts x 1.00               # $694.00
```

**Clicking YES or NO does not create a position in the browser.** The dashboard
holds the anon key and RLS makes it read-only, and more importantly a fill
invented client-side would bypass the order-book slippage model that makes these
results worth anything. Instead the click queues a `pending` row in
`manual_orders`, and the worker:

1. re-prices the contract against **real L2 depth**,
2. rejects the order if the fill drifted past your slippage tolerance,
3. opens the position through the same code path as a bot entry.

Rejections come back to the panel with a reason (`slippage $0.0812 exceeds
tolerance $0.05`, `insufficient depth`, `market no longer live`).

Manual trades are recorded with `role: manual`, so the reports keep them
distinguishable from the strategy's own wings.

> Requires `supabase/migrations/002_manual_orders.sql` to be run once.

---

## The strategy, and where it was ambiguous

Your original note:

> Give a filter for timings · entry in 1st and last strike, atleast 1:5 odds on
> both · Middle strike entry only if entry has 1:3 odds · exit rule ITM 50 · only
> when BTC ATR is more than 200 · be careful about slippages

Three parts of that could reasonably be read two ways. Rather than silently pick
one, each is a **config flag** — flip it in `config.yaml` and re-run.

**1. What "1:5 odds" means as a price ceiling** — `entry.odds_convention`

| Setting | Reading | Max wing price | Max middle price |
|---|---|---|---|
| `risk_reward` *(default)* | risk 1 to win 5 | **0.1667** | 0.2500 |
| `payout_multiple` | 5× gross payout | 0.2000 | 0.3333 |

**2. What "ITM 50" means** — `exit.mode`

| Setting | Reading |
|---|---|
| `price` *(default)* | close when the contract trades at **0.50** |
| `spot_points` | close when spot is 50 points past the strike |

Defaulted to `price` because with ATR above 200, "50 points past the strike"
fires almost immediately and the rule stops doing any work.

**3. Which legs** — `entry.trade_wings` / `require_both_wings`

Defaults to a **long strangle**: buy the Put at the lowest strike and the Call at
the highest, and skip the round unless *both* clear the odds test, matching
"1:5 odds on **both**".

The middle-strike leg (`entry.trade_middle`) is **off** by default — turn it on
once you have baseline numbers for the wings alone, so you can tell what it adds.

### The timing filter

Two independent axes, both in `config.yaml`:

- **Inside the round** — `min/max_seconds_since_launch`, `min/max_seconds_to_expiry`.
  Defaults avoid the first 30s (book hasn't settled) and the last 3 minutes.
- **Wall clock** — `sessions` (e.g. `["13:00-21:00"]`) with `session_timezone`
  set to `IST` or `UTC`, plus `weekdays`.

---

## Slippage — read this before trusting any number

This is the part that decides whether a result is real. The wings are exactly
where the book is thinnest. A live example measured while building this:

```
B-P-BTC-75400   touch price 0.0320
  buy  30 contracts -> avg 0.0320   (1 level)
  buy 100 contracts -> avg 0.0419   (3 levels)  +31%
  buy 500 contracts -> avg 0.1307  (10 levels)  +308%
```

**Size, not direction, is the dominant risk.** At 500 contracts you pay 4× the
touch price, which turns a 1:5 bet into roughly a 1:6.6 bet before the market
has moved at all. Filling at mid or at mark — as most naive backtests do —
would have manufactured edge that does not exist.

So the engine:

- defaults to `fills.model: orderbook`, walking real L2 depth level by level;
- **re-tests the odds rule against the price actually paid**, not the touch
  price, and skips the leg if slippage broke the threshold;
- refetches the book at execution time so real latency is in the fill;
- rejects rather than silently under-fills when depth is short
  (`allow_partial: false`);
- skips legs whose spread exceeds `max_spread_frac` of mid;
- tracks slippage cost separately, shown on the dashboard.

`fills.model` can be set to `best_quote` or `mark` to see how much of any
apparent edge is a fill-model artifact. If the strategy only works under `mark`,
it does not work.

**Start with `size_contracts: 100` or lower** and check the reported slippage
before scaling.

---

## Reading the results

On a strangle most individual legs lose by design — one wing is meant to expire
worthless. A leg-level win rate near 25% is normal and not a failure signal.

**Judge `round_win_rate` and `avg_pnl_per_round`**, which the dashboard and the
CLI summary both report separately from leg stats.

---

## Project layout

```
predict_paper/
  config.py      dataclasses + YAML, every ambiguous rule as a flag
  delta.py       read-only Delta REST client (retries, rate-limit handling)
  indicators.py  Wilder ATR with caching
  rounds.py      symbol parsing, round assembly, 1st/middle/last classification
  fills.py       order-book walk and slippage model
  strategy.py    entry/exit/timing/ATR rules, every decision with a reason
  portfolio.py   positions, settlement, P&L, JSONL ledger
  store.py       Supabase writes (best-effort; never breaks the trading loop)
  engine.py      the poll loop
  report.py      summary statistics
run_live.py      CLI entry point
verify_setup.py  pre-flight checks
supabase/schema.sql
web/             React + Tailwind dashboard
data/            local ledger + logs (gitignored)
```

If Supabase is unreachable the worker keeps trading and keeps writing
`data/trades_<run>.jsonl`; only the dashboard goes stale.

---

## Limitations, stated plainly

- **No historical backtest.** Delta does not serve historical order books for
  these contracts, so the only honest way to evaluate this is forward paper
  trading. Results accumulate as it runs.
- Fills assume your order does not move the book — reasonable at 100 contracts,
  less so at 1000.
- Queue position is not modelled; every fill is treated as a taker.
- Fees are set to 0 because the venue currently reports 0 for binaries. If that
  changes, set `portfolio.taker_fee_rate`.
- The ATR gate uses `BTCUSDT` candles. Do not switch it to `BTCUSD` — that
  series is stale and flat, which would silently disable the filter.
