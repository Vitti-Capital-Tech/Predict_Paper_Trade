# Hosting the worker on AWS Lightsail

The cheapest durable home for the worker, and the one that needs no tooling on
your own machine — everything happens in the AWS console and a browser SSH
window. **$5/month**, fixed.

Use this if you don't have Docker locally. If you do, and you want builds and
deploys wired into CI, [the Fargate setup](../aws/README.md) is the other path.

---

## 1. Create the instance

Lightsail → **Create instance**

| Field | Value |
|---|---|
| Region | **Mumbai, ap-south-1** (any is fine; this is nearest you) |
| Platform | **Linux/Unix** |
| Blueprint | **OS Only → Ubuntu 24.04 LTS** |
| Plan | **$5/month** (1 GB RAM, 2 vCPU) |
| Name | `predict-worker` |

Pick **OS Only**, not an app blueprint — there is no web server here.

The $5 plan is right. The worker idles at well under 100 MB; the cheaper $3.50
plan also works, but 512 MB leaves nothing for an `apt upgrade`.

Click **Create instance** and wait for it to turn *Running*.

## 2. Open a terminal

On the instance card, click the **orange terminal icon**. That's browser SSH —
no key files, no PuTTY, nothing to configure.

## 3. Run the setup

Paste this in:

```bash
curl -fsSL https://raw.githubusercontent.com/Vitti-Capital-Tech/Predict_Paper_Trade/main/deploy/lightsail/setup.sh | sudo bash
```

It installs Python, clones the repo to `/opt/predict`, builds a virtualenv,
creates a `predict` service user, and installs the systemd unit. It will stop
and tell you the credentials file is empty — that's expected.

## 4. Add the credentials

```bash
sudo nano /etc/predict-worker.env
```

Fill in both lines:

```
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
```

That is the **service role** key, not the anon key — the worker needs to write.
`Ctrl+O`, `Enter`, `Ctrl+X` to save and quit. The file is mode 0600 and owned by
root, so only a sudoer can read it.

Then start it:

```bash
sudo systemctl enable --now predict-worker
```

## 5. Check it's alive

```bash
sudo journalctl -u predict-worker -f
```

Healthy output looks like:

```
paper engine starting | cash=10000.00 | wing<=0.1667 ...
ROUND  BTC-2009261930   strikes=[81000.0, 81100.0, 81200.0] ...
SKIP   BTC-2009261930   ATR gate: 97.6 <= 200
```

`SKIP ... ATR gate` is the volatility filter holding entries back, not an error.
Place a trade from the dashboard and you should see `MANUAL filled` within a few
seconds.

`Ctrl+C` stops following the log; it does not stop the worker.

---

## Everyday use

Deploy the latest code:

```bash
sudo bash /opt/predict/deploy/lightsail/setup.sh && sudo systemctl restart predict-worker
```

Other things you'll want:

```bash
sudo systemctl status predict-worker     # is it up?
sudo systemctl restart predict-worker    # restart
sudo systemctl stop predict-worker       # stop (survives reboot as stopped)
sudo journalctl -u predict-worker -n 100 # last 100 lines
```

`Restart=always` covers both crashes and instance reboots, so it comes back on
its own.

## Two things worth knowing

**Restarts are safe now.** Positions live in the worker's memory, so a restart
used to strand anything open. The worker now adopts open positions from runs
whose heartbeat has gone quiet, and closes them against their original row. It
waits `adopt_stale_after_sec` (120s) before adopting, which is what stops two
workers settling the same trade twice.

**Run exactly one.** Don't leave the worker running on your laptop once this is
live, and don't create a second instance. Two workers would both fill the same
queued orders and double-credit every account. The staleness window is a safety
net, not a lock.
