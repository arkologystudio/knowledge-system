/**
 * Cross-process mutual exclusion for git operations on ONE source clone.
 *
 * WHY
 * ---
 * More than one gbrain process can operate the same checkout: the sync loop
 * (`gbrain sync --watch`), the MCP page-write path (`commit_page`), the
 * durability cron (`gbrain sources pull`), and any job worker running a sync.
 * `git pull` writes FETCH_HEAD, and so does the sync cost-estimator's
 * `git fetch origin <branch>` — each marking the current branch *for-merge*.
 * When two of those overlap, the interleaved FETCH_HEAD ends up with more than
 * one merge candidate and `--ff-only` dies:
 *
 *     fatal: Cannot fast-forward to multiple branches.
 *
 * That is not hypothetical. Two independent 5-minute sync loops raced this way
 * on the Arkology brain host for three weeks in July 2026 (reproduced 6/6 by
 * running a fetch and a pull concurrently). It was invisible because a failed
 * pull warns-and-continues, after which sync reads HEAD off the un-advanced
 * clone, sees it equals `last_commit`, and reports `up_to_date`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This only excludes gbrain processes. A human running `git pull` in the
 * checkout, or any other tool, is not serialised by it — the lock is a
 * cooperative convention, not a kernel-enforced one.
 */

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

/**
 * Filename is retained from the original commit_page-only lock so that a
 * process running an older build still interlocks with a newer one during a
 * rolling upgrade. The scope is now every git operation on the clone, not just
 * page writes — hence the module name, not the file name.
 */
export const REPO_LOCK_NAME = 'gbrain-commit-page.lock';

/**
 * A holder that stopped refreshing this long ago is presumed dead even if a
 * process with its pid still exists (pid reuse). Generous: a page write does a
 * pull, a commit and a push, and a large sync pull can be slow on a cold cache.
 */
const DEFAULT_STALE_MS = 15 * 60_000;

/** Poll interval while waiting for a holder to release. */
const POLL_MS = 100;

export interface RepoLockOpts {
  /** How long to wait for the lock before giving up. 0 = try once. */
  timeoutMs?: number;
  /** Age past which a holder is presumed dead and its lock reclaimed. */
  staleMs?: number;
}

export interface RepoLockHandle {
  /** Idempotent. Safe to call more than once. */
  release(): void;
}

/**
 * Re-entrancy, per lock path, per process.
 *
 * The sync path can acquire the lock and then call into code that acquires it
 * again (the cost estimator sits behind the same public entry points as the
 * pull). Without this, a process would deadlock against itself for the whole
 * timeout and then skip its own pull — turning a correctness fix into the very
 * silent-stall it was written to prevent.
 *
 * CAVEAT: because re-entrancy is keyed by process, two genuinely concurrent
 * in-process callers for the SAME clone would both be admitted. That is safe
 * today only because nothing runs them concurrently: page writes are already
 * serialised per repo by `serializeForRepo`, and a sync walks its sources one at
 * a time (two sources cannot share a `local_path` — `resolveRepoPath` rejects
 * it). If either of those ever changes, this needs a real in-process mutex
 * underneath the file lock, not just a depth counter.
 */
const held = new Map<string, { depth: number; fd: number }>();

function lockPathFor(repoPath: string): string {
  const gitDir = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).toString().trim();
  return join(isAbsolute(gitDir) ? gitDir : join(repoPath, gitDir), REPO_LOCK_NAME);
}

/** True when a process with this pid exists and we may signal it. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but belongs to another user — still alive.
    return e?.code === 'EPERM';
  }
}

/**
 * Decide whether an existing lock file may be reclaimed. Fail SAFE: anything we
 * cannot parse or stat is treated as a live holder, because wrongly stealing a
 * live lock reintroduces the concurrent-git bug this module exists to prevent.
 */
function isStale(path: string, staleMs: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Vanished between EEXIST and read — the holder released. Treat as
    // reclaimable; the atomic create below is what actually arbitrates.
    return true;
  }
  const [pidStr, iso] = raw.trim().split(/\s+/, 2);
  const pid = Number(pidStr);

  // A holder whose process is gone is dead regardless of age. This is the case
  // that used to brick the checkout forever: the original lock had no staleness
  // handling at all, so one crashed commit_page blocked every later write.
  if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;

  const ts = Date.parse(iso ?? '');
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > staleMs;
}

function tryCreate(path: string): number | null {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    return fd;
  } catch {
    return null;
  }
}

function makeHandle(path: string): RepoLockHandle {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const entry = held.get(path);
      if (!entry) return;
      entry.depth -= 1;
      if (entry.depth > 0) return;
      held.delete(path);
      try { closeSync(entry.fd); } catch { /* best effort */ }
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * Take the lock without waiting. Returns null if another holder has it.
 *
 * For callers whose work is optional — the sync cost-estimator's fetch is a
 * preview that already falls back to local HEAD — skipping is strictly better
 * than blocking or failing.
 */
export function tryAcquireRepoLock(
  repoPath: string,
  opts: RepoLockOpts = {},
): RepoLockHandle | null {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  let path: string;
  try {
    path = lockPathFor(repoPath);
  } catch {
    // Not a git repo / git unavailable. Nothing to serialise against; let the
    // caller's own git invocation produce the real error.
    return null;
  }

  const existing = held.get(path);
  if (existing) {
    existing.depth += 1;
    return makeHandle(path);
  }

  let fd = tryCreate(path);
  if (fd === null && isStale(path, staleMs)) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
    // Whoever wins this atomic create wins the lock; a concurrent reclaimer
    // simply loses the race and retries on its own schedule.
    fd = tryCreate(path);
  }
  if (fd === null) return null;

  held.set(path, { depth: 1, fd });
  return makeHandle(path);
}

/**
 * Take the lock, waiting up to `timeoutMs`. Returns null on timeout — callers
 * decide what a missed lock means, because the right answer differs: a page
 * write must fail loudly, while a sync must skip its pull AND say so, never
 * silently proceed against a stale clone.
 */
export async function acquireRepoLock(
  repoPath: string,
  opts: RepoLockOpts = {},
): Promise<RepoLockHandle | null> {
  const timeoutMs = opts.timeoutMs ?? 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = tryAcquireRepoLock(repoPath, opts);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Run `fn` under the lock, releasing on every exit path. */
export async function withRepoLock<T>(
  repoPath: string,
  opts: RepoLockOpts,
  fn: () => Promise<T>,
  onUnavailable: () => Promise<T>,
): Promise<T> {
  const handle = await acquireRepoLock(repoPath, opts);
  if (!handle) return onUnavailable();
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

/** Test seam: drop this process's in-memory re-entrancy state. */
export function _resetRepoLockState(): void {
  for (const [, entry] of held) {
    try { closeSync(entry.fd); } catch { /* best effort */ }
  }
  held.clear();
}
