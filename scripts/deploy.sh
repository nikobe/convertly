#!/bin/bash
#
# Pull, build and restart Convertly on the machine it is run on.
#
# Written to be safe to run over SSH from a non-interactive shell, which is
# where most of the awkwardness comes from: nvm is not loaded, PATH is bare,
# and nothing inherits a terminal.
#
#   ./scripts/deploy.sh          pull, build, restart
#   ./scripts/deploy.sh --force  restart even if a job is running
#
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

cd "$(dirname "$0")/.."
REPO="$PWD"

# ── find a usable node ──────────────────────────────────────────────────
# nvm's shell function does not exist here, so resolve the binary directly.
for candidate in \
  "$HOME"/.nvm/versions/node/v2[4-9]*/bin \
  /opt/homebrew/bin /usr/local/bin
do
  [ -x "$candidate/node" ] && PATH="$candidate:$PATH" && break
done
export PATH

command -v node >/dev/null || { echo "✗ no node found"; exit 1; }
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 24 ] || { echo "✗ node $(node -v) is too old — needs 24+ for native TypeScript"; exit 1; }

PORT=$(node -p 'try{require("./config/convertly.json").port ?? 8973}catch(e){8973}')
BASE="http://127.0.0.1:$PORT"

# ── refuse to interrupt real work ───────────────────────────────────────
# Restarting mid-encode throws away that job's progress. The queue requeues
# it, so nothing is lost permanently, but hours of encoding might be.
if [ "$FORCE" -eq 0 ] && curl -sf -m 5 "$BASE/api/queue" >/dev/null 2>&1; then
  RUNNING=$(curl -s -m 5 "$BASE/api/queue" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).items.filter(i=>i.state==="running").length' 2>/dev/null || echo 0)
  if [ "${RUNNING:-0}" -gt 0 ]; then
    echo "✗ a job is encoding right now — deploying would discard its progress."
    echo "  Pause the queue and let it finish, or re-run with --force."
    exit 1
  fi
fi

# ── pull ────────────────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree is dirty here; refusing to pull over local changes:"
  git status --short | sed 's/^/    /'
  exit 1
fi

BEFORE=$(git rev-parse --short HEAD)
git fetch --quiet origin
git merge --ff-only --quiet origin/main
AFTER=$(git rev-parse --short HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "· already at $AFTER"
else
  echo "· $BEFORE → $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'
fi

# ── install and build only when they can have changed ───────────────────
if [ "$BEFORE" != "$AFTER" ] && ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json package.json; then
  echo "· dependencies changed, running npm ci"
  npm ci --silent
fi

echo "· building"
npm run build --silent >/dev/null

# ── restart ─────────────────────────────────────────────────────────────
# SIGTERM so the server can stop its encoder; SIGKILL would orphan the ffmpeg.
pkill -f "node src/server/index.ts" 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -f "node src/server/index.ts" >/dev/null || break
  sleep 0.5
done

# Anything of ours still encoding is an orphan. Only our own temp paths are
# matched, so a media server's own transcodes are left well alone.
ORPHANS=$(pgrep -fl "ffmpeg" 2>/dev/null | grep "convertly-tmp" | awk '{print $1}' || true)
if [ -n "$ORPHANS" ]; then
  echo "· reaping $(echo "$ORPHANS" | wc -l | tr -d ' ') orphaned encode(s) from a previous run"
  echo "$ORPHANS" | xargs kill 2>/dev/null || true
  sleep 1
fi

mkdir -p "$REPO/data"
nohup node src/server/index.ts > "$REPO/data/server.log" 2>&1 &
disown 2>/dev/null || true

# ── confirm it came back ────────────────────────────────────────────────
for _ in $(seq 1 30); do
  if curl -sf -m 2 "$BASE/api/health" >/dev/null 2>&1; then
    echo "✓ running at $AFTER on port $PORT"
    curl -s "$BASE/api/health" | node -p '
      const h = JSON.parse(require("fs").readFileSync(0,"utf8"));
      h.checks.filter(c=>!c.ok).map(c=>`    ✗ ${c.label}: ${c.detail}`).join("\n") || "    all checks green"
    '
    exit 0
  fi
  sleep 1
done

echo "✗ it did not come back up. Last lines of data/server.log:"
tail -15 "$REPO/data/server.log" | sed 's/^/    /'
exit 1
