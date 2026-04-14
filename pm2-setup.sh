#!/bin/bash
# PM2 setup for web-terminal
# Run this once on each server to configure PM2 process management.

set -e

echo "=== Web Terminal PM2 Setup ==="

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
fi

cd "$(dirname "$0")"
WTDIR="$(pwd)"
echo "Working directory: $WTDIR"

# Stop any existing PM2 process
pm2 delete web-terminal 2>/dev/null || true

# Start with PM2
pm2 start server.js \
  --name web-terminal \
  --cwd "$WTDIR" \
  --restart-delay 2000 \
  --max-restarts 10 \
  --exp-backoff-restart-delay 1000

# Save PM2 process list (survives pm2 resurrect)
pm2 save

echo ""
echo "=== Done ==="
echo "PM2 commands:"
echo "  pm2 status          — check running processes"
echo "  pm2 logs web-terminal — view logs"
echo "  pm2 restart web-terminal — restart"
echo "  pm2 stop web-terminal    — stop"
echo ""
echo "To enable auto-start on boot, run:"
echo "  pm2 startup"
echo "  (then run the command it outputs)"
echo "  pm2 save"
