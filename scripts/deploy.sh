#!/bin/bash
# Update the production main checkout. Service control refuses busy stops by
# default; --force explicitly discards an in-flight job's progress.
set -euo pipefail

FORCE=0
case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  *) echo "Usage: ./scripts/deploy.sh [--force]" >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo "Too many arguments" >&2; exit 1; }
cd "$(dirname "$0")/.."

for candidate in "$HOME"/.nvm/versions/node/v2[4-9]*/bin /opt/homebrew/bin /usr/local/bin; do
  if [ -x "$candidate/node" ]; then PATH="$candidate:$PATH"; break; fi
done
export PATH
command -v node >/dev/null || { echo "Node 24+ is required" >&2; exit 1; }
[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ] || exit 1
[ "$(git branch --show-current)" = main ] || { echo "Deploy from main, not a development branch." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Working tree is dirty; refusing to deploy." >&2; exit 1; }

git fetch --quiet origin
# Refuse divergence BEFORE taking the service down.
git merge-base --is-ancestor HEAD origin/main || { echo "main has diverged from origin/main." >&2; exit 1; }
BEFORE=$(git rev-parse HEAD)

# Pause, recheck, and signal only the verified owner. Stop before changing
# dependencies or live assets, not after a build during which more work ran.
if [ "$FORCE" -eq 1 ]; then
  node src/server/service.ts stop --force
else
  node src/server/service.ts stop
fi
trap 'echo "Deployment failed. The service may be stopped; inspect the error before running npm run service:start. No broad process kill was attempted." >&2' ERR

# SQLite backup includes committed WAL content. Configuration and backups
# stay under the ignored data directory, private to this user.
node --input-type=module <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './src/server/config.ts';
const configPath = resolve(process.env.CONVERTLY_CONFIG ?? 'config/convertly.json');
const config = loadConfig(configPath);
const directory = join(config.dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, {recursive: true, mode: 0o700});
copyFileSync(configPath, join(directory, 'convertly.json'));
chmodSync(join(directory, 'convertly.json'), 0o600);
const database = join(config.dataDir, 'convertly.db');
if (existsSync(database)) {
  const db = new DatabaseSync(database, {readOnly: true});
  try { await backup(db, join(directory, 'convertly.db')); }
  finally { db.close(); }
  chmodSync(join(directory, 'convertly.db'), 0o600);
}
console.log(`Backup: ${directory}`);
NODE

git merge --ff-only --quiet origin/main
AFTER=$(git rev-parse HEAD)
if [ ! -d node_modules ] || ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json package.json; then
  npm ci --silent
fi
npm run typecheck
npm test
npm run build
# Keep the queue paused, including when upgrading a legacy server that did
# not persist Pause. Resume deliberately in the UI after checking health.
CONVERTLY_START_PAUSED=1 node src/server/service.ts start
trap - ERR
echo "Deployed $(git rev-parse --short HEAD). Check health, then resume the queue in the app."
