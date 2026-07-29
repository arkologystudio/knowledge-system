#!/usr/bin/env bash
# Install / refresh the kb-vps deployment units from this repo.
#
# Idempotent and safe to re-run. Run it on kb-vps after a `git pull` in
# /root/knowledge-system whenever anything under ops/kb-vps/ has changed:
#
#   cd /root/knowledge-system && git pull --ff-only && ops/kb-vps/install.sh
#
# By default only the guard is installed, because the three service units are
# already live and rewriting them mid-incident is the wrong default. Pass
# --all to sync every unit from the repo (still requires an explicit restart).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_SRC="$REPO_DIR/systemd"
SYSTEMD_DST=/etc/systemd/system
BIN_DST=/usr/local/bin

ALL=0
[ "${1:-}" = "--all" ] && ALL=1

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (writes to $SYSTEMD_DST and $BIN_DST)." >&2
  exit 1
fi

echo "==> installing guard script"
install -m 0755 "$REPO_DIR/gbrain-pull-watch.sh" "$BIN_DST/gbrain-pull-watch"

echo "==> installing guard units"
install -m 0644 "$SYSTEMD_SRC/gbrain-pull-watch.service" "$SYSTEMD_DST/"
install -m 0644 "$SYSTEMD_SRC/gbrain-pull-watch.timer" "$SYSTEMD_DST/"

if [ "$ALL" -eq 1 ]; then
  echo "==> --all: syncing service units (NOT restarting them; do that deliberately)"
  for u in knowledge-system-sync.service knowledge-system-http.service \
           knowledge-system-dream.service knowledge-system-dream.timer; do
    if [ -f "$SYSTEMD_SRC/$u" ]; then
      if [ -f "$SYSTEMD_DST/$u" ] && ! diff -q "$SYSTEMD_SRC/$u" "$SYSTEMD_DST/$u" >/dev/null; then
        cp -a "$SYSTEMD_DST/$u" "$SYSTEMD_DST/$u.bak.$(date -u +%Y%m%dT%H%M%SZ)"
        echo "    $u changed — previous version backed up"
      fi
      install -m 0644 "$SYSTEMD_SRC/$u" "$SYSTEMD_DST/"
    fi
  done
fi

echo "==> reloading systemd"
systemctl daemon-reload
systemctl enable --now gbrain-pull-watch.timer >/dev/null

# The July 2026 incident: a `gbrain autopilot` systemd USER unit ran a second
# 5-minute sync loop against the same clone, racing the system unit's git pull
# on FETCH_HEAD. It is invisible to system-scope systemctl, so check explicitly
# and refuse to leave it running silently.
echo "==> checking for a competing sync loop (the known root cause)"
if systemctl --user is-enabled gbrain-autopilot.service >/dev/null 2>&1 \
   || systemctl --user is-active gbrain-autopilot.service >/dev/null 2>&1; then
  echo "    WARNING: gbrain-autopilot.service (user scope) is present." >&2
  echo "    It dispatches its own sync jobs every 300s and WILL race" >&2
  echo "    knowledge-system-sync's git pull. Disable it:" >&2
  echo "      systemctl --user disable --now gbrain-autopilot.service" >&2
else
  echo "    clean — no competing autopilot loop"
fi

echo "==> verifying guard runs"
if systemctl start gbrain-pull-watch.service; then
  echo "    guard ran; current state:"
  sed 's/^/    /' /var/lib/gbrain/sync-pull-alert.json 2>/dev/null || true
else
  echo "    guard exited non-zero — it is ALARMING. Read:" >&2
  echo "      /var/lib/gbrain/sync-pull-alert.json" >&2
fi

echo "==> done"
