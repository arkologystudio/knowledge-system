# kb-vps deployment

Operational units for the Arkology Knowledge System host, `kb.arkology.studio`.

This directory lives in this repo on purpose: the repo is already checked out on
that host at `/root/knowledge-system` and `bun link`ed to the `gbrain` binary, so
deploy is `git pull` in that checkout. Anything here therefore arrives on the box
with the engine, needing no separate distribution path. These files were
previously hand-made on the host and tracked nowhere, which meant they would not
have survived a rebuild.

## Layout

| Path | What |
|---|---|
| `gbrain-pull-watch.sh` | Guard: alarms when the wiki sync stops reaching the remote |
| `systemd/gbrain-pull-watch.{service,timer}` | Runs the guard every 15 minutes |
| `systemd/knowledge-system-sync.service` | The 5-minute wiki sync (`gbrain sync --watch`) |
| `systemd/knowledge-system-http.service` | HTTP MCP / OAuth server on :3131 |
| `systemd/knowledge-system-dream.{service,timer}` | Nightly 02:30 maintenance cycle |
| `install.sh` | Idempotent installer |

Secrets are **not** here. They stay in `/etc/gbrain/*.env` (mode 0600) on the
host and are referenced by `EnvironmentFile=`.

## Deploying

```bash
cd /root/knowledge-system
git pull --ff-only
bun install --frozen-lockfile
systemctl restart knowledge-system-sync knowledge-system-http
```

There is no build step — bun runs the TypeScript directly. But
`knowledge-system-sync` is a long-running `--watch` process and will **not** pick
up code changes without that restart.

If anything under `ops/kb-vps/` changed, also run:

```bash
ops/kb-vps/install.sh          # guard only (default)
ops/kb-vps/install.sh --all    # also sync the service units
```

## The failure mode this guards against

`knowledge-system-sync` pulls the wiki every 5 minutes. When `git pull` fails,
sync warns to stderr and continues — the deliberate warn-and-continue invariant.
It then reads HEAD from the un-advanced clone, finds it equal to `last_commit`,
and returns `up_to_date`. `get_health` agrees: 0 stale pages, 100% embed
coverage. The brain genuinely *is* consistent with a snapshot that stopped
moving, so **every surface reads green while content silently freezes.**

It happened twice in July 2026 — 09–14 Jul, and again 23–27 Jul, the second time
unnoticed for five days. It surfaced only indirectly, as `/note/...` links 404ing
on the dashboard.

**The signal that matters is the absence of a successful pull, not the presence
of failures.** A stall can take shapes that never log the word "failed". That is
what the guard watches.

```bash
# Is content actually reaching the brain?
journalctl -u knowledge-system-sync.service --since "1 hour ago" | grep -c 'git_pull done'

# Current guard verdict
cat /var/lib/gbrain/sync-pull-alert.json
```

The guard is detection-only: it never restarts services or touches the brain. It
exits non-zero when alarming, so a stall shows up in `systemctl --failed`.

## Root cause of the July 2026 incident

Two independent 5-minute sync loops were running against the same clone:

1. `knowledge-system-sync.service` — system scope, `gbrain sync --watch --interval 300`
2. `gbrain-autopilot.service` — **user** scope (`~/.config/systemd/user/`), which
   dispatched its own `sync` job every 300s, executed by a `gbrain jobs work` worker

Both ran `git pull` on `/srv/brain-repos/arkology`. `git pull`'s internal fetch
and the sync cost-estimator's `git fetch origin <branch>` each write `FETCH_HEAD`,
marking the current branch *for-merge*. When two pulls overlap, the interleaved
file ends up with more than one merge candidate and `--ff-only` dies:

```
fatal: Cannot fast-forward to multiple branches.
```

Reproduced 100% (6/6) by running a fetch and a pull concurrently on the clone.

Two loops on the same period drift in and out of phase, which is exactly why the
symptom looked like random multi-day blackouts rather than a steady fault. The
user unit was also invisible to system-scope `systemctl list-units`, and
`Linger=no` meant it only ran while a root login session existed — so the failure
correlated with someone being logged into the box.

The autopilot loop was redundant: the nightly `dream` timer had already been
chosen to replace it. It is now disabled, and `install.sh` warns if it returns.

### Two things that made this hard to diagnose

- The pull error was truncated to ~100 characters, which cut off just after the
  git invocation and discarded the reason. Thousands of log lines recorded the
  command and not one recorded the cause. Fixed in v0.43.0.12.
- `console.error` wrote a string containing a newline, and journald splits on
  newlines, so git's stderr landed as a *separate* journal entry from the
  "Warning: git pull failed" line — easy to miss when grepping for the warning.

### Structural fix (v0.43.0.13)

Every gbrain git operation on a source clone now takes one cross-process lock
(`src/core/repo-lock.ts`, file `.git/gbrain-commit-page.lock` — the name is kept
so an older build still interlocks with a newer one). Four actors take it: the
sync pull, the sync cost-estimator's fetch, MCP page writes, and the durability
pull/harden paths.

Behaviour when the lock is contended differs by caller, deliberately:

- **sync pull** waits up to 60s, and if it still cannot get it, SKIPS the pull
  and emits a `pull_failed` warning. Skipping silently would be the very
  stale-brain shape this whole effort exists to prevent.
- **cost-estimator fetch** never waits — it is a preview that already falls back
  to local HEAD, so blocking it behind a real pull would be worse than a
  slightly stale estimate.
- **page writes** wait up to 30s, then fail loudly.

The lock also reclaims a stale holder: if the recorded pid is gone, or the entry
is older than 15 minutes, it is taken over. The original page-write lock had no
staleness handling at all, so one crashed `commit_page` would have blocked the
checkout forever — a latent bug that got much worse once sync depended on the
same lock.

This only excludes *gbrain* processes. A human running `git pull` in the
checkout is not serialised by it.

## Source `default` is permanently `unmanaged-remote`

`sources_status` reports:

```json
{ "remote_url": null, "clone_remote_url": "wiki-gh:arkologystudio/arkology-wiki.git",
  "clone_state": "unmanaged-remote" }
```

This is **correct and should not be "fixed"**. The clone's remote is an SSH host
alias backed by a deploy key, and `parseRemoteUrl` accepts HTTPS only, so the URL
cannot be recorded in config. Recording the HTTPS equivalent would put config and
clone in disagreement — that is `url-drift`, and sync refuses to run on it. The
source is pulled by the systemd unit, not by gbrain's own clone management.
