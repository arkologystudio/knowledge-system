#!/usr/bin/env bash
# gbrain-pull-watch — alarm when the wiki sync stops reaching the remote.
#
# WHY THIS EXISTS
# ---------------
# knowledge-system-sync pulls the wiki every 5 minutes. When `git pull` fails,
# sync warns to stderr and continues (the deliberate warn-and-continue
# invariant), then reads HEAD from the un-advanced clone, finds it equal to
# last_commit, and reports `up_to_date`. `get_health` agrees — 0 stale pages,
# 100% embed coverage — because the brain genuinely IS consistent with a
# snapshot that stopped moving. Every surface reads green while content freezes.
#
# That happened twice in July 2026: 09-14 Jul, and again 23-27 Jul, the second
# time unnoticed for five days. Root cause was two independent 5-minute sync
# loops racing on the same clone's FETCH_HEAD (see README.md). That specific
# cause is fixed, but the DETECTION gap is why it ran for weeks — any future
# cause would be equally silent. Hence this guard.
#
# WHAT IT WATCHES
# ---------------
# The ONE signal that separates "nothing changed upstream" from "we never
# reached upstream": a SUCCESSFUL pull. Absence of success is the alarm.
# Presence of failures is only corroboration — a run can stall in ways that
# never log the word "failed".
#
# Deliberately detection-only: it does not restart services or touch the brain.
# Exits 1 when alarming so `systemctl --failed` shows it without reading logs.

set -uo pipefail

UNIT=knowledge-system-sync.service
# Sync runs every 5 min; 25 min is 5 consecutive missed pulls — long enough that
# one slow or transiently-failing pull doesn't cry wolf.
WINDOW="25 min ago"
STATE_DIR=/var/lib/gbrain
STATE_FILE="$STATE_DIR/sync-pull-alert.json"

mkdir -p "$STATE_DIR"

logs=$(journalctl -u "$UNIT" --since "$WINDOW" --no-pager 2>/dev/null)
ok_count=$(printf '%s\n' "$logs" | grep -c 'sync\.git_pull done' || true)
fail_count=$(printf '%s\n' "$logs" | grep -c 'git pull failed' || true)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# A repo with no origin, or a deliberate --no-pull deployment, shows neither.
# Only alarm when the service is actually up and evidently not succeeding.
active=$(systemctl is-active "$UNIT" 2>/dev/null || true)

# Concurrent-sync detector. The July incident's root cause was a SECOND sync
# loop (a `gbrain autopilot` systemd USER unit, invisible to system-scope
# systemctl) dispatching its own sync jobs every 300s and racing this one's
# git pull. If anything other than this unit is pulling the same clone, name it
# — that is the single most useful line in a future incident.
rogue=$(pgrep -af 'gbrain (autopilot|jobs work)' 2>/dev/null | grep -v gbrain-pull-watch || true)

if [ "$ok_count" -eq 0 ] && [ "$active" = "active" ]; then
  last_ok=$(journalctl -u "$UNIT" --since "30 days ago" --no-pager 2>/dev/null \
    | grep 'sync\.git_pull done' | tail -1 | awk '{print $1, $2, $3}')
  cat > "$STATE_FILE" <<EOF
{
  "status": "alarm",
  "checked_at": "$now",
  "window": "$WINDOW",
  "successful_pulls_in_window": $ok_count,
  "failed_pulls_in_window": $fail_count,
  "last_successful_pull": "${last_ok:-unknown}",
  "concurrent_sync_actors": "${rogue:-none}",
  "meaning": "knowledge-system-sync has not completed a git pull in the window. It will still report up_to_date and get_health will still read clean, because the brain is consistent with a snapshot that has stopped advancing. Wiki content is NOT reaching the brain.",
  "first_checks": [
    "journalctl -u knowledge-system-sync.service | grep -A2 'git pull failed'  # full cause is logged since v0.43.0.12",
    "systemctl --user list-units | grep gbrain   # a second sync loop is the known root cause",
    "cd /srv/brain-repos/arkology && git pull --ff-only   # reproduce by hand"
  ]
}
EOF
  logger -t gbrain-pull-alert -p user.err \
    "ALARM: no successful git pull for $UNIT in $WINDOW (failures seen: $fail_count; last good: ${last_ok:-unknown}). Brain content is frozen while sync still reports up_to_date."
  [ -n "$rogue" ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM detail: another gbrain process is touching the same clone (known root-cause shape): $rogue"
  echo "ALARM: no successful git pull in $WINDOW (failures: $fail_count, last good: ${last_ok:-unknown})" >&2
  [ -n "$rogue" ] && echo "concurrent sync actor(s): $rogue" >&2
  exit 1
fi

cat > "$STATE_FILE" <<EOF
{
  "status": "ok",
  "checked_at": "$now",
  "window": "$WINDOW",
  "successful_pulls_in_window": $ok_count,
  "failed_pulls_in_window": $fail_count,
  "concurrent_sync_actors": "${rogue:-none}"
}
EOF

# Failures alongside successes = flapping, which is what a partially-in-phase
# second sync loop looks like before it becomes a full blackout. Warn, don't alarm.
if [ "$fail_count" -gt 0 ]; then
  logger -t gbrain-pull-alert -p user.warning \
    "git pull is flapping for $UNIT: $fail_count failure(s) and $ok_count success(es) in $WINDOW.${rogue:+ Concurrent actor: $rogue}"
  echo "WARN: flapping — $fail_count failure(s) alongside $ok_count success(es) in $WINDOW" >&2
fi

echo "ok: $ok_count successful pull(s), $fail_count failure(s) in $WINDOW"
exit 0
