#!/usr/bin/env bash
# ops/install.sh — install and enable the OmniClick systemd units.
#
# Idempotent: safe to re-run after editing a unit file.
#
# Usage:
#   sudo ./ops/install.sh            install + enable + start everything
#   sudo ./ops/install.sh status     show current state, change nothing
#   sudo ./ops/install.sh uninstall  stop, disable and remove the units

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/ops/systemd"
UNIT_DST="/etc/systemd/system"

SERVICES=(omniclick-gateway omniclick-realtime omniclick-queue)
TIMERS=(omniclick-scheduler)

# One consumer instance per channel type. Must match config/rabbitmq.php, which
# must in turn match the channelTypes array in gateway/lib/amqpClient.js.
CONSUMERS=(whatsapp whatsapp_qr facebook line email telegram sms)

log()  { printf '\033[1;34m[ops]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ops] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v systemctl >/dev/null || die "systemd not available"

# Unit files hardcode WorkingDirectory=/root/omni-click-apps/...; refuse to
# install silently broken units if the checkout lives somewhere else.
if [ "$REPO_ROOT" != "/root/omni-click-apps" ]; then
    die "unit files expect the repo at /root/omni-click-apps, found $REPO_ROOT — edit ops/systemd/*.service first"
fi

case "${1:-install}" in
status)
    for u in "${SERVICES[@]}"; do
        printf '  %-28s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo inactive)"
    done
    for t in "${TIMERS[@]}"; do
        printf '  %-28s %s\n' "$t.timer" "$(systemctl is-active "$t.timer" 2>/dev/null || echo inactive)"
    done
    for c in "${CONSUMERS[@]}"; do
        printf '  %-28s %s\n' "omniclick-consumer@$c" "$(systemctl is-active "omniclick-consumer@$c" 2>/dev/null || echo inactive)"
    done
    exit 0
    ;;

uninstall)
    for c in "${CONSUMERS[@]}"; do
        systemctl disable --now "omniclick-consumer@$c" 2>/dev/null || true
    done
    rm -f "$UNIT_DST/omniclick-consumer@.service"
    for u in "${SERVICES[@]}"; do
        systemctl disable --now "$u" 2>/dev/null || true
        rm -f "$UNIT_DST/$u.service"
    done
    for t in "${TIMERS[@]}"; do
        systemctl disable --now "$t.timer" 2>/dev/null || true
        rm -f "$UNIT_DST/$t.timer" "$UNIT_DST/$t.service"
    done
    systemctl daemon-reload
    log "units removed"
    exit 0
    ;;

install) ;;
*) die "unknown command: $1" ;;
esac

log "installing units into $UNIT_DST"
install -m 0644 "$UNIT_SRC"/*.service "$UNIT_SRC"/*.timer "$UNIT_DST/"
systemctl daemon-reload

# A hand-started `node server.js` left over from before does not belong to any
# unit; systemd would start a second copy and the port bind would fail.
for port in 3001 3002; do
    pid="$(ss -lntpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
    if [ -n "$pid" ] && ! systemctl status omniclick-gateway omniclick-realtime 2>/dev/null | grep -q "$pid"; then
        log "stopping unsupervised process on :$port (pid $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
    fi
done

for u in "${SERVICES[@]}"; do
    log "enabling $u"
    systemctl enable --now "$u"
done

for t in "${TIMERS[@]}"; do
    log "enabling $t.timer"
    systemctl enable --now "$t.timer"
done

for c in "${CONSUMERS[@]}"; do
    log "enabling omniclick-consumer@$c"
    systemctl enable --now "omniclick-consumer@$c"
done

log "done — current state:"
exec "$0" status
