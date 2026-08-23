#!/usr/bin/env bash
# Run ON the remote server (e.g. 111.228.6.222) to update FlowMate in place.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wjh2113/flowmate-work-assistant/main/deploy/remote-update.sh | bash
# Or after cloning:
#   FLOWMATE_DIR=/path/to/flowmate-work-assistant bash deploy/remote-update.sh
set -euo pipefail

FLOWMATE_DIR="${FLOWMATE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
FLOWMATE_PORT="${FLOWMATE_PORT:-3003}"
SERVICE_NAME="${SERVICE_NAME:-flowmate}"
REPO_URL="${REPO_URL:-https://github.com/wjh2113/flowmate-work-assistant.git}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing command: $1" >&2; exit 1; }
}

need_cmd node
need_cmd npm
need_cmd git

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22+ required (current: $(node -v))" >&2
  exit 1
fi

if [ ! -d "$FLOWMATE_DIR/.git" ]; then
  echo "Cloning into $FLOWMATE_DIR ..."
  mkdir -p "$(dirname "$FLOWMATE_DIR")"
  git clone "$REPO_URL" "$FLOWMATE_DIR"
fi

cd "$FLOWMATE_DIR"
echo "==> Pull latest"
git fetch origin main
git checkout main
git pull --ff-only origin main

if [ ! -f .env ]; then
  echo "ERROR: $FLOWMATE_DIR/.env not found. Copy .env.example and fill DATABASE_URL, API keys, PORT=$FLOWMATE_PORT" >&2
  exit 1
fi

echo "==> Install & build"
npm ci
npm run build

restart_service() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all 2>/dev/null | grep -q "${SERVICE_NAME}.service"; then
    echo "==> Restart systemd: $SERVICE_NAME"
    sudo systemctl restart "$SERVICE_NAME"
    sudo systemctl status "$SERVICE_NAME" --no-pager -l || true
    return 0
  fi
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
    echo "==> Restart pm2: $SERVICE_NAME"
    pm2 restart "$SERVICE_NAME"
    pm2 save || true
    return 0
  fi
  echo "==> No systemd/pm2 service '$SERVICE_NAME'. Start manually:"
  echo "    cd $FLOWMATE_DIR && PORT=$FLOWMATE_PORT npm start"
}

restart_service

echo "==> Health check"
sleep 2
curl -fsS "http://127.0.0.1:${FLOWMATE_PORT}/api/health" | head -c 400 || true
echo ""
echo "Done. Public URL: https://usertool.aidigitcloud.cn/"
