#!/usr/bin/env bash
# deploy.sh — Install dependencies and start geopoint-saver-simple
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${DATA_DIR:-/opt/geopoint-saver-simple}"
PORT="${PORT:-3001}"
SERVICE="geopoint-saver-simple"
RUN_USER="www-data"

echo "==> GeoPoint Saver Simple — deployment"

# ── Node.js ───────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ERROR: Node.js 18+ required (found $(node -v))"; exit 1
fi
echo "  Node.js $(node -v) OK"

# ── System tools ──────────────────────────────────────────────────────────────
for pkg in xz-utils gpg coreutils; do
  dpkg -l "$pkg" &>/dev/null || apt-get install -y "$pkg"
done

# ── Data directories ──────────────────────────────────────────────────────────
mkdir -p "$DATA_DIR/logs"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR" 2>/dev/null || true
echo "  Data dir: $DATA_DIR"

# ── npm install ───────────────────────────────────────────────────────────────
cd "$APP_DIR"
echo "  Installing npm dependencies..."
npm install --omit=dev
echo "  npm OK"

# ── .env ─────────────────────────────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  ADMIN_SECRET=$(openssl rand -hex 20)
  cat > "$APP_DIR/.env" <<ENVEOF
PORT=$PORT
DATA_DIR=$DATA_DIR
ADMIN_PROXY_SECRET=$ADMIN_SECRET
ENVEOF
  echo "  Generated .env (ADMIN_PROXY_SECRET=$ADMIN_SECRET)"
else
  echo "  .env already exists — skipping"
fi

# ── systemd service ───────────────────────────────────────────────────────────
cat > "/etc/systemd/system/${SERVICE}.service" <<SVCEOF
[Unit]
Description=GeoPoint Saver Simple
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo ""
  echo "  Service is running."
  echo "  App:   http://localhost:$PORT"
  echo "  Admin: http://localhost:$PORT/admin (requires ADMIN_PROXY_SECRET header)"
else
  echo "  ERROR: service failed to start. Check: journalctl -u $SERVICE"
  exit 1
fi
