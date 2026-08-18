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
#      has actually ingested (sources.last_commit) vs. what origin reports via
#      ls-remote — asked of the REMOTE directly, so a wedged local clone cannot
#      vouch for itself. A mismatch that PERSISTS WITHOUT THE INDEX ADVANCING
#      is the alarm no matter what every other surface says. This is the check
#      the third incident walked past.
#
# THE GUARD MUST NOT GO QUIETLY BLIND
# -----------------------------------
# A monitor that cannot take its own measurement must never report "ok" — that
# is the exact failure class this guard exists to close, and the first cut of
# this check reproduced it twice (2026-08-18 review):
#
#   - A failed probe (docker/psql hiccup, GitHub blip) must NOT reset the
#     staleness clock. It used to, so an intermittently-failing probe made real
#     staleness permanently un-alarmable: the clock never survived to grace.
#   - A probe that cannot answer emits status `degraded`, not `ok`, and
#     escalates to a hard alarm once blindness itself persists past grace.
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
# one slow or transiently-failing pull doesn't cry wolf.
WINDOW="25 min ago"
# Freshness grace. NOTE the timer fires every 15 min, so a 1500s grace means the
# alarm needs THREE consecutive observations of a non-advancing mismatch:
# >=30 min after first observation, up to ~45 min after the mismatch began.
# Sized to absorb the normal mismatch shapes: commit_page pushes to origin
# without touching last_commit (so every agent write lags until the next tick),
# and a checkpointed sync working through a backlog advances last_commit to the
# checkpoint pin rather than live HEAD.
LAG_GRACE_SECS=1500
# Blindness grace, same shape: warn immediately, alarm once the guard has been
# unable to measure across three consecutive runs.
BLIND_GRACE_SECS=1500
STATE_DIR=/var/lib/gbrain
STATE_FILE="$STATE_DIR/sync-pull-alert.json"
# "<epoch> <indexed_commit>" — the commit is stored so the clock re-anchors when
# the index ADVANCES to a new (still-behind) commit. Without it the timer would
# measure "time since any mismatch", not "time since the index stopped moving",
# and a brain steadily chewing through a backlog would false-alarm.
LAG_STATE_FILE="$STATE_DIR/index-lag-since"
BLIND_STATE_FILE="$STATE_DIR/index-probe-blind-since"

mkdir -p "$STATE_DIR"

# Minimal JSON string escaper: backslash first, then quote, then flatten any
# control whitespace. Every interpolated value goes through this — `pgrep -af`
# output in particular is multi-line and contains quoted command lines, which
# silently produced invalid JSON in the first cut.
json_str() {
  # JSON forbids ALL raw C0 controls, not just the three whitespace ones — an
  # ESC in a captured command line is enough to make the state file unparseable.
  printf '%s' "${1-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '[:cntrl:]' ' '
}

read_epoch() {
  # Echoes a *plausible* epoch from $1, or nothing. A truncated/garbage state
  # file must not become arithmetic input: an empty file read as 0 yields a ~55
  # year lag and an instant false alarm, and a non-numeric one aborts the run
  # under `set -u` BEFORE the state file is written, freezing the operator's
  # view. The length bound matters as much as the digit check: a huge digit
  # string is "numeric" but overflows $(( )) to a NEGATIVE lag, which would
  # make the stale alarm permanently unreachable — precisely the failure this
  # helper exists to prevent, wearing a different hat.
  local v
  v=$(awk '{print $1; exit}' "$1" 2>/dev/null)
  [[ "$v" =~ ^[0-9]{1,11}$ ]] && printf '%s' "$v"
}

sane_epoch() {
  # $1 = candidate, $2 = now. Rejects the future (clock skew, hand-edited file).
  [ -n "${1:-}" ] && [ "$1" -le "$2" ] 2>/dev/null
}

read_field2() {
  local v
  v=$(cat "$1" 2>/dev/null | awk '{print $2}')
  printf '%s' "${v:-}"
}

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
now_epoch=$(date -u +%s)

logs=$(journalctl -u "$UNIT" --since "$WINDOW" --no-pager 2>/dev/null)
ok_count=$(printf '%s\n' "$logs" | grep -c 'sync\.git_pull done' || true)
fail_count=$(printf '%s\n' "$logs" | grep -c 'git pull failed' || true)
# A pull that TIMES OUT logs `sync.git_pull error` and returns early without
# ever printing "git pull failed"; a lock-contended pull logs `skipped`. Both
# are total stalls that would otherwise be reported as "failures: 0".
stall_count=$(printf '%s\n' "$logs" | grep -cE 'sync\.git_pull (error|skipped)' || true)

# A repo with no origin, or a deliberate --no-pull deployment, shows neither.
# Only alarm when the service is actually up and evidently not succeeding.
active=$(systemctl is-active "$UNIT" 2>/dev/null || true)

# Concurrent-sync detector. The July incident's root cause was a SECOND sync
# loop (a `gbrain autopilot` systemd USER unit, invisible to system-scope
# systemctl) dispatching its own sync jobs every 300s and racing this one's
# git pull. If anything other than this unit is pulling the same clone, name it
# — that is the single most useful line in a future incident.
rogue=$(pgrep -af 'gbrain (autopilot|jobs work)' 2>/dev/null | grep -v gbrain-pull-watch | paste -sd';' - || true)

# ── Check 2: indexed-commit freshness (end-to-end) ──────────────────────────
# origin_head comes from ls-remote — the remote's own answer, never the local
# clone's opinion of the remote. The refspec is exact: a bare `main` also
# matches a TAG named main, which would return two SHAs.
ls_out=$(timeout 20 git -C "$REPO" ls-remote --heads origin "refs/heads/$BRANCH" 2>/dev/null)
ls_rc=$?
origin_head=$(printf '%s\n' "$ls_out" | awk -v r="refs/heads/$BRANCH" '$2==r {print $1; exit}')

# indexed_commit comes from the brain DB — what ingestion has actually
# processed, not what the clone has fetched.
indexed_commit=$(timeout 15 docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT last_commit FROM sources WHERE id='${SOURCE_ID}'" 2>/dev/null | tr -d '[:space:]')

lag_alarm=0
blind_alarm=0
probe_blind=0
lag_state=
lag_secs=0
blind_secs=0

if [ "$ls_rc" -ne 0 ]; then
  lag_state="origin_unreachable"          # network/auth — cannot measure
elif [ -z "$origin_head" ]; then
  lag_state="origin_branch_missing"       # REPO/BRANCH misconfigured — permanently blind
elif [ -z "$indexed_commit" ]; then
  lag_state="indexed_commit_unreadable"   # container renamed, psql/auth broken, source id gone
elif [ "$origin_head" = "$indexed_commit" ]; then
  lag_state="fresh"
else
  lag_state="lagging"
fi

case "$lag_state" in
  fresh)
    # The only state that clears the clocks. Everything else either measures a
    # mismatch (keep counting) or fails to measure (keep whatever we had).
    rm -f "$LAG_STATE_FILE" "$BLIND_STATE_FILE"
    ;;
  lagging)
    rm -f "$BLIND_STATE_FILE"
    prev_epoch=$(read_epoch "$LAG_STATE_FILE")
    prev_commit=$(read_field2 "$LAG_STATE_FILE")
    if ! sane_epoch "$prev_epoch" "$now_epoch" || [ "$prev_commit" != "$indexed_commit" ]; then
      # First observation, unusable/future anchor, or the index ADVANCED to a
      # new commit — re-anchor.
      lag_since=$now_epoch
    else
      lag_since=$prev_epoch
    fi
    printf '%s %s\n' "$lag_since" "$indexed_commit" > "$LAG_STATE_FILE"
    lag_secs=$(( now_epoch - lag_since ))
    if [ "$lag_secs" -ge "$LAG_GRACE_SECS" ]; then
      lag_state="stale"
      lag_alarm=1
    else
      lag_state="lagging_within_grace"
    fi
    ;;
  *)
    # PROBE FAILURE. Critically, the lag clock is left ALONE — not reset.
    # Resetting it here is what made an intermittently-failing probe able to
    # mask indefinite staleness. If a lag was already being tracked, it keeps
    # accruing and can still alarm on a later successful measurement.
    probe_blind=1
    prev_epoch=$(read_epoch "$LAG_STATE_FILE")
    if sane_epoch "$prev_epoch" "$now_epoch"; then
      lag_secs=$(( now_epoch - prev_epoch ))
      # A blind run must not RETRACT a stale verdict the last real measurement
      # already reached. Without this, one docker hiccup turns a confirmed
      # alarm (exit 1, latched in `systemctl --failed`) into exit 0 while
      # index_lag_seconds sits in the same file saying "still stale". The last
      # measurement stands until a measurement contradicts it.
      [ "$lag_secs" -ge "$LAG_GRACE_SECS" ] && lag_alarm=1 && lag_state="stale_unverified"
    fi
    blind_since=$(read_epoch "$BLIND_STATE_FILE")
    if ! sane_epoch "$blind_since" "$now_epoch"; then
      blind_since=$now_epoch
      printf '%s\n' "$blind_since" > "$BLIND_STATE_FILE"
    fi
    blind_secs=$(( now_epoch - blind_since ))
    [ "$blind_secs" -ge "$BLIND_GRACE_SECS" ] && blind_alarm=1
    ;;
esac

# ── Check 1: pull success ───────────────────────────────────────────────────
pull_alarm=0
if [ "$ok_count" -eq 0 ] && [ "$active" = "active" ]; then
  pull_alarm=1
fi

rogue_j=$(json_str "$rogue")
lag_state_j=$(json_str "$lag_state")
origin_head_j=$(json_str "${origin_head:-unknown}")
indexed_commit_j=$(json_str "${indexed_commit:-unknown}")

if [ "$pull_alarm" -eq 1 ] || [ "$lag_alarm" -eq 1 ] || [ "$blind_alarm" -eq 1 ]; then
  last_ok=$(journalctl -u "$UNIT" --since "30 days ago" --no-pager 2>/dev/null \
    | grep 'sync\.git_pull done' | tail -1 | awk '{print $1, $2, $3}')
  last_ok_j=$(json_str "${last_ok:-unknown}")
  cat > "$STATE_FILE.tmp" <<EOF
{
  "status": "alarm",
  "checked_at": "$now",
  "window": "$WINDOW",
  "successful_pulls_in_window": $ok_count,
  "failed_pulls_in_window": $fail_count,
  "stalled_pulls_in_window": $stall_count,
  "last_successful_pull": "$last_ok_j",
  "concurrent_sync_actors": "${rogue_j:-none}",
  "freshness": "$lag_state_j",
  "origin_head": "$origin_head_j",
  "indexed_commit": "$indexed_commit_j",
  "index_lag_seconds": $lag_secs,
  "probe_blind_seconds": $blind_secs,
  "alarms": { "pull": $pull_alarm, "stale_index": $lag_alarm, "probe_blind": $blind_alarm },
  "meaning": "The brain is not a verifiably fresh cache of origin/main. pull=sync cannot advance the clone; stale_index=commits reachable on origin/main are not in the brain index and the index is not advancing; probe_blind=this guard cannot take its own measurement and has not been able to for longer than its grace window. get_health can read clean throughout, because the brain IS consistent with a snapshot that stopped advancing.",
  "first_checks": [
    "journalctl -u knowledge-system-sync.service | grep -A2 'git pull failed'  # full cause is logged since v0.43.0.12",
    "cd /srv/brain-repos/arkology && git status -sb   # ahead/diverged = someone wrote to the mirror (see docs/designs/git-canonical-writes.md)",
    "systemctl --user list-units | grep gbrain   # a second sync loop is a known root cause",
    "docker exec gbrain-pg psql -U gbrain -d gbrain -c 'SELECT id,last_commit,last_sync_at FROM sources'   # what the brain actually indexed",
    "git -C /srv/brain-repos/arkology ls-remote --heads origin refs/heads/main   # what the remote actually has"
  ]
}
EOF
  # Atomic publish: operators and tooling read this file on a timer, and a
  # truncate-then-write can be caught mid-flight. Same .tmp+rename convention
  # the engine's write-through uses.
  mv -f "$STATE_FILE.tmp" "$STATE_FILE"
  [ "$pull_alarm" -eq 1 ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM: no successful git pull for $UNIT in $WINDOW (failures: $fail_count, stalls: $stall_count; last good: ${last_ok:-unknown}). Brain content is frozen while sync still reports up_to_date."
  [ "$lag_alarm" -eq 1 ] && [ "$lag_state" = "stale_unverified" ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM: brain index was STALE at the last successful measurement (${lag_secs}s and counting) and this run could not re-measure (probe blind). Verdict retained until a measurement contradicts it."
  [ "$lag_alarm" -eq 1 ] && [ "$lag_state" != "stale_unverified" ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM: brain index is STALE — origin/main is ${origin_head:0:12} but the brain indexed ${indexed_commit:0:12}, not advancing for ${lag_secs}s (> ${LAG_GRACE_SECS}s). Content on origin/main is not reaching the brain."
  [ "$blind_alarm" -eq 1 ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM: freshness check has been BLIND for ${blind_secs}s (> ${BLIND_GRACE_SECS}s), state=$lag_state. The brain may be stale and this guard cannot tell. Fix the probe before trusting any green reading."
  [ -n "$rogue" ] && logger -t gbrain-pull-alert -p user.err \
    "ALARM detail: another gbrain process is touching the same clone (known root-cause shape): $rogue"
  [ "$pull_alarm" -eq 1 ] && echo "ALARM: no successful git pull in $WINDOW (failures: $fail_count, stalls: $stall_count, last good: ${last_ok:-unknown})" >&2
  [ "$lag_alarm" -eq 1 ] && echo "ALARM: stale index — origin ${origin_head:0:12} vs indexed ${indexed_commit:0:12}, not advancing for ${lag_secs}s" >&2
  [ "$blind_alarm" -eq 1 ] && echo "ALARM: freshness probe blind for ${blind_secs}s (state=$lag_state)" >&2
  [ -n "$rogue" ] && echo "concurrent sync actor(s): $rogue" >&2
  exit 1
fi

# Not alarming. But a guard that cannot measure must not claim "ok" — that is
# the failure class this whole file exists to close.
# Keyed on "could not measure", NOT on elapsed blind time: the FIRST blind run
# is already a run whose freshness reading is absent, and `ok` would misreport
# it as verified.
overall="ok"
[ "$probe_blind" -eq 1 ] && overall="degraded"

cat > "$STATE_FILE.tmp" <<EOF
{
  "status": "$overall",
  "checked_at": "$now",
  "window": "$WINDOW",
  "successful_pulls_in_window": $ok_count,
  "failed_pulls_in_window": $fail_count,
  "stalled_pulls_in_window": $stall_count,
  "concurrent_sync_actors": "${rogue_j:-none}",
  "freshness": "$lag_state_j",
  "origin_head": "$origin_head_j",
  "indexed_commit": "$indexed_commit_j",
  "index_lag_seconds": $lag_secs,
  "probe_blind_seconds": $blind_secs,
  "alarms": { "pull": 0, "stale_index": 0, "probe_blind": 0 }
}
EOF
mv -f "$STATE_FILE.tmp" "$STATE_FILE"

# Failures alongside successes = flapping, which is what a partially-in-phase
# second sync loop looks like before it becomes a full blackout. Warn, don't alarm.
if [ "$fail_count" -gt 0 ] || [ "$stall_count" -gt 0 ]; then
  logger -t gbrain-pull-alert -p user.warning \
    "git pull is flapping for $UNIT: $fail_count failure(s), $stall_count stall(s) and $ok_count success(es) in $WINDOW.${rogue:+ Concurrent actor: $rogue}"
  echo "WARN: flapping — $fail_count failure(s), $stall_count stall(s) alongside $ok_count success(es) in $WINDOW" >&2
fi

if [ "$overall" = "degraded" ]; then
  logger -t gbrain-pull-alert -p user.warning \
    "freshness check is BLIND (state=$lag_state, ${blind_secs}s so far, alarms at ${BLIND_GRACE_SECS}s). Pull check still active. Brain freshness is currently UNVERIFIED."
  echo "DEGRADED: freshness probe blind for ${blind_secs}s (state=$lag_state) — freshness unverified" >&2
fi

echo "$overall: $ok_count successful pull(s), $fail_count failure(s), $stall_count stall(s) in $WINDOW; freshness=$lag_state (origin ${origin_head:0:12}, indexed ${indexed_commit:0:12})"
exit 0
