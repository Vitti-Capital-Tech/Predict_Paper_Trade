#!/usr/bin/env bash
# One-time setup for the worker on a fresh Ubuntu instance (Lightsail or EC2).
#
# Run it in the instance's SSH session:
#
#   curl -fsSL https://raw.githubusercontent.com/Vitti-Capital-Tech/Predict_Paper_Trade/main/deploy/lightsail/setup.sh | sudo bash
#
# It will stop and ask you to write /etc/predict-worker.env if that file is
# missing, rather than guessing at credentials.
set -euo pipefail

REPO="${REPO:-https://github.com/Vitti-Capital-Tech/Predict_Paper_Trade.git}"
DIR=/opt/predict
ENV_FILE=/etc/predict-worker.env

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2; exit 1
fi

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip git >/dev/null

echo "==> service user"
id -u predict >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin predict

echo "==> code at $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin main
  git -C "$DIR" reset --hard --quiet origin/main
else
  rm -rf "$DIR"
  git clone --quiet "$REPO" "$DIR"
fi
mkdir -p "$DIR/data"

echo "==> python environment"
python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --quiet --upgrade pip
"$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt"

chown -R predict:predict "$DIR"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Fill both in, then: sudo systemctl restart predict-worker
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo
  echo "!! $ENV_FILE was created empty."
  echo "!! Put your Supabase URL and SERVICE ROLE key in it, then run:"
  echo "!!     sudo systemctl enable --now predict-worker"
  echo
fi

echo "==> systemd"
install -m 644 "$DIR/deploy/lightsail/predict-worker.service" \
  /etc/systemd/system/predict-worker.service
systemctl daemon-reload

if grep -q '^SUPABASE_SERVICE_KEY=.\+' "$ENV_FILE"; then
  systemctl enable --now predict-worker
  sleep 3
  systemctl --no-pager --lines=15 status predict-worker || true
else
  echo "==> not starting yet: $ENV_FILE has no key"
fi

echo
echo "Logs:    sudo journalctl -u predict-worker -f"
echo "Update:  sudo bash $DIR/deploy/lightsail/setup.sh && sudo systemctl restart predict-worker"
