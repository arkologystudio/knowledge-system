#!/usr/bin/env bash
# gbrain-pull-watch — alarm when the wiki stops reaching the brain.
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
# loops racing on the same clone's FETCH_HEAD (see README.md). Then a THIRD
# time, 28 Jul - 18 Aug 2026: the ingest checkpoint silently wedged at a
# 28 July commit while pulls kept SUCCEEDING, so this guard's original
# pull-success check read green for three weeks of staleness — and separately,
# a diverged clone (a put_page write-through file committed locally by hand)
# broke ff-only pulls for a day before anyone noticed via a blocked push.
# See docs/designs/git-canonical-writes.md for the structural fix; this guard
# is Phase 0 of that design.
#
# WHAT IT WATCHES
# ---------------
# Two signals, both required for "the brain is a fresh cache of origin/main":
#
#   1. PULL SUCCESS (mid-pipeline proxy). The signal that separates "nothing
#      changed upstream" from "we never reached upstream": a SUCCESSFUL pull.
#      Absence of success is the alarm. Presence of failures is only
#      corroboration — a run can stall in ways that never log "failed".
#
#   2. INDEXED-COMMIT FRESHNESS (the end-to-end signal). The commit the brain
#      has actually ingested (sources.last_commit) vs. what origin/main reports
#      via ls-remote — asked of the REMOTE directly, so a wedged local clone
#      cannot vouch for itself. A persistent mismatch is the alarm no matter
#      what every other surface says: content exists upstream that the brain
#      has not indexed. This is the check the third incident walked past.
#
# Deliberately detection-only: it does not restart services or touch the brain.
# Exits 1 when alarming so `systemctl --failed` shows it without reading logs.

set -uo pipefail

UNIT=knowledge-system-sync.service
REPO=/srv/brain-repos/arkology
BRANCH=main
# The postgres container holding the brain index (docker-compose service).
PG_CONTAINER=gbrain-pg
PG_DB=gbrain
PG_USER=gbrain
SOURCE_ID=default
# Sync runs every 5 min; 25 min is 5 consecutive missed pulls — long enough that
# one slow or transiently-failing pull doesn't cry wolf. The SAME window bounds
# indexed-commit lag: 5 ticks behind a visible origin/main head is never normal.
WINDOW="25 min ago"
LAG_GRACE_SECS=1500
STATE_DIR=/var/lib/gbrain
STATE_FILE="$STATE_DIR/sync-pull-alert.json"
LAG_SINCE_FILE="$STATE_DIR/index-lag-since"

mkdir -p "$STATE_DIR"

logs=$(journalctl -u "$UNIT" --since "$WINDOW" --no-pager 2>/dev/null)
ok_count=$(printf '%s\n' "$logs" | grep -c 'sync\.git_pull done' || true)
fail_count=$(printf '%s\n' "$logs" | grep -c 'git pull failed' || true)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
now_epoch=$(date -u +%s)

# A repo with no origin, or a deliberate --no-pull deployment, shows neither.
# Only alarm when the service is actually up and evidently not succeeding.
active=$(systemctl is-active "$UNIT" 2>/dev/null || true)

# Concurrent-sync detector. The July incident's root cause was a SECOND sync
# loop (a `gbrain autopilot` systemd USER unit, invisible to system-scope
# systemctl) dispatching its own sync jobs every 300s and racing this one's
# git pull. If anything other than this unit is pulling the same clone, name it
# — that is the single most useful line in a future incident.
rogue=$(pgrep -af 'gbrain (autopilot|jobs work)' 2>/dev/null | grep -v gbrain-pull-watch || true)

# ── Check 2: indexed-commit freshness (end-to-end) ──────────────────────────
# origin_head comes from ls-remote — the remote's own answer, never the local
# clone's opinion of the remote. indexed_commit comes from the brain DB — what
# ingestion has actually processed, not what the clone has fetched.
origin_head=$(timeout 20 git -C "$REPO" ls-remote origin "$BRANCH" 2>/dev/null | awk '{print $1}' || true)
indexed_commit=$(timeout 15 docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT last_commit FROM sources WHERE id='${SOURCE_ID}'" 2>/dev/null | tr -d '[:space:]' || true)

lag_alarm=0
lag_state="fresh"
lag_secs=0
if [ -z "$origin_head" ]; then
  # Remote unreachable: check 1 owns reachability failures — don't double-alarm,
  # but say so rather than claiming freshness we cannot verify.
  lag_state="origin_unreachable"
  rm -f "$LAG_SINCE_FILE"
elif [ -z "$indexed_commit" ]; then
  # DB unreadable from here (container renamed, psql failure). The check is
  # blind, which is itself worth a warning line — a blind guard reads as green.
  lag_state="indexed_commit_unreadable"
  rm -f "$LAG_SINCE_FILE"
elif [ "$origin_head" = "$indexed_commit" ]; then
  lag_state="fresh"
  rm -f "$LAG_SINCE_FILE"
else
  # Mismatch. Normal for one tick (a push mid-window); an alarm only when it
  # PERSISTS past the grace window, tracked across runs in LAG_SINCE_FILE.
  if [ -f "$LAG_SINCE_FILE" ]; then
    lag_since=$(cat "$LAG_SINCE_FILE" 2>/dev/null || echo "$now_epoch")
  else
    lag_since=$now_epoch
    echo "$now_epoch" > "$LAG_SINCE_FILE"
  fi
  lag_secs=$(( now_epoch - lag_since ))
  if [ "$lag_secs" -ge "$LAG_GRACE_SECS" ]; then
    lag_state="stale"
    lag_alarm=1
  else
    lag_state="lagging_within_grace"
  fi
fi

# ── Check 1: pull success ───────────────────────────────────────────────────
pull_alarm=0
if [ "$ok_count" -eq 0 ] && [ "$active" = "active" ]; then
  pull_alarm=1
fi

if [ "$pull_alarm" -eq 1 ] || [ "$lag_alarm" -eq 1 ]; then
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
  "freshness": "$lag_state",
  "origin_head": "${origin_head:-unknown}",
  "indexed_commit": "${indexed_commit:-unknown}",
  "index_lag_seconds": $lag_secs,
  "meaning": "The brain is not a fresh cache of origin/main. pull_alarm=$pull_alarm (sync cannot advance the clone), stale_index_alarm=$lag_alarm (commits reachable on origin/main are not in the brain index). get_health can still read clean throughout, because the brain IS consistent with a snapshot that stopped advancing.",
  "first_checks": [
    "journalctl -u knowledge-system-sync.service | grep -A2 'git pull failed'  # full cause is logged since v0.43.0.12",
    "cd /srv/brain-repos/arkology && git status -sb   # ahead/diverged = someone wrote to the mirror (see docs/designs/git-canonical-writes.md)",
    "systemctl --user list-units | grep gbrain   # a second sync loop is a known root cause",
    "docker exec gbrain-pg psql -U gbrain -d gbrain -c \\"SELECT id,last_commit,last_sync_at FROM sources\\"   # what the brain actually indexed"
  ]
}
EOF
  [ "$pull_alarm" -eq 1 ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM: no successful git pull for $UNIT in $WINDOW (failures seen: $fail_count; last good: ${last_ok:-unknown}). Brain content is frozen while sync still reports up_to_date."
  [ "$lag_alarm" -eq 1 ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM: brain index is STALE — origin/main is ${origin_head:0:12} but the brain indexed ${indexed_commit:0:12}, mismatch persisting ${lag_secs}s (> ${LAG_GRACE_SECS}s). Content on origin/main is not reaching the brain."
  [ -n "$rogue" ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM detail: another gbrain process is touching the same clone (known root-cause shape): $rogue"
  [ "$pull_alarm" -eq 1 ] && echo "ALARM: no successful git pull in $WINDOW (failures: $fail_count, last good: ${last_ok:-unknown})" >&2
  [ "$lag_alarm" -eq 1 ] && echo "ALARM: stale index — origin ${origin_head:0:12} vs indexed ${indexed_commit:0:12} for ${lag_secs}s" >&2
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
  "concurrent_sync_actors": "${rogue:-none}",
  "freshness": "$lag_state",
  "origin_head": "${origin_head:-unknown}",
  "indexed_commit": "${indexed_commit:-unknown}",
  "index_lag_seconds": $lag_secs
}
EOF

# Failures alongside successes = flapping, which is what a partially-in-phase
# second sync loop looks like before it becomes a full blackout. Warn, don't alarm.
if [ "$fail_count" -gt 0 ]; then
  logger -t gbrain-pull-alert -p user.warning \
    "git pull is flapping for $UNIT: $fail_count failure(s) and $ok_count success(es) in $WINDOW.${rogue:+ Concurrent actor: $rogue}"
  echo "WARN: flapping — $fail_count failure(s) alongside $ok_count success(es) in $WINDOW" >&2
fi

# A blind freshness check must not read as silence.
if [ "$lag_state" = "indexed_commit_unreadable" ]; then
  logger -t gbrain-pull-alert -p user.warning \
    "freshness check is BLIND: cannot read sources.last_commit from container '$PG_CONTAINER'. Pull check still active; fix the DB probe."
  echo "WARN: freshness check blind (cannot read indexed commit from $PG_CONTAINER)" >&2
fi

echo "ok: $ok_count successful pull(s), $fail_count failure(s) in $WINDOW; freshness=$lag_state (origin ${origin_head:0:12}, indexed ${indexed_commit:0:12})"
exit 0
