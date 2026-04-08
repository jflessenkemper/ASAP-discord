#!/usr/bin/env bash
set -euo pipefail

VM_NAME="${VM_NAME:-asap-bot-vm}"
VM_ZONE="${VM_ZONE:-australia-southeast1-c}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/asap-bot}"
BRANCH="${BRANCH:-origin/main}"

# Deploy bot runtime to VM with Playwright browser downloads disabled to avoid
# ENOSPC failures during npm install on small disks.
gcloud compute ssh "$VM_NAME" --zone="$VM_ZONE" --command "
  set -euo pipefail
  sudo chown -R \$USER:\$USER '$REMOTE_ROOT'
  cd '$REMOTE_ROOT'
  git fetch origin
  git reset --hard '$BRANCH'
  cd server
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  export npm_config_playwright_skip_browser_download=true
  npm ci
  npm run build
  pm2 restart asap-bot --update-env
  pm2 status asap-bot | cat
"
