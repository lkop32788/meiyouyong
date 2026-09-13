#!/usr/bin/env bash
# deploy.sh — rebuild the OmniClick frontend and deploy it atomically.
#
# Usage:
#   ./deploy.sh            Build frontend/ and deploy to the live webroot
#   ./deploy.sh rollback   Swap the webroot back to the previous release
#
# Layout on the server:
#   /var/www/omniclick-releases/<timestamp>/   immutable build artifacts
#   /var/www/omniclick-web -> <release dir>    symlink, swapped atomically
#
# The symlink swap means nginx never serves a half-copied tree, and a
# failed build leaves the live site untouched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$REPO_ROOT/frontend"
WEBROOT="/var/www/omniclick-web"
RELEASES="/var/www/omniclick-releases"
KEEP_RELEASES=5
WEB_URL="${WEB_URL:-https://37182.club}"   # post-deploy smoke check target

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$FRONTEND" ] || die "frontend/ not found next to deploy.sh"
mkdir -p "$RELEASES" 2>/dev/null || die "cannot create $RELEASES — run as root or with write access"

# list_releases: newest first
list_releases() {
  ls -1d "$RELEASES"/*/ 2>/dev/null | sort -r || true
}

# activate <dir>: atomically point the webroot symlink at <dir>
activate() {
  ln -sfn "$1" "$WEBROOT.tmp-link"
  mv -Tf "$WEBROOT.tmp-link" "$WEBROOT"
}

# ── rollback mode ────────────────────────────────────────────────────────────
if [ "${1:-deploy}" = "rollback" ]; then
  current="$(readlink "$WEBROOT" || true)"
  [ -n "$current" ] || die "webroot is not a symlink-managed deploy; nothing to roll back"
  mapfile -t releases < <(list_releases)
  prev=""
  found=false
  for r in "${releases[@]}"; do
    if $found; then prev="$r"; break; fi
    [[ "${r%/}" == "$current" ]] && found=true
  done
  [ -n "$prev" ] || die "no release older than the current one to roll back to"
  activate "${prev%/}"
  log "rolled back: $WEBROOT -> ${prev%/}"
  exit 0
fi

# ── deploy mode ──────────────────────────────────────────────────────────────
# First run: convert an existing plain-directory webroot into release #0 so
# rollback always has somewhere to go.
if [ -d "$WEBROOT" ] && [ ! -L "$WEBROOT" ]; then
  imported="$RELEASES/00000000-00000000-imported"
  log "importing existing webroot as initial release"
  mv "$WEBROOT" "$imported"
fi

log "building frontend (tsc + vite)..."
(cd "$FRONTEND" && npm run build) || die "build failed — live site untouched"
[ -f "$FRONTEND/dist/index.html" ] || die "dist/index.html missing after build"

stamp="$(date +%Y%m%d-%H%M%S)"
release="$RELEASES/$stamp"
mkdir "$release"
cp -r "$FRONTEND/dist/." "$release/"

activate "$release"
log "deployed: $WEBROOT -> $release"

# prune old releases beyond KEEP_RELEASES
mapfile -t all < <(list_releases)
if [ "${#all[@]}" -gt "$KEEP_RELEASES" ]; then
  for old in "${all[@]:$KEEP_RELEASES}"; do
    rm -rf "$old"
  done
  log "pruned releases beyond the newest $KEEP_RELEASES"
fi

# smoke check
if curl -fsS -m 8 -o /dev/null "$WEB_URL" 2>/dev/null; then
  log "smoke check OK: $WEB_URL -> 200"
else
  log "WARNING: could not verify $WEB_URL from this machine (site may still be fine)"
fi
