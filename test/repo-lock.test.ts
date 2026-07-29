/**
 * Cross-process serialisation of git work on one source clone.
 *
 * The incident: two independent 5-minute sync loops ran against the same
 * checkout. `git pull`'s internal fetch and the cost-estimator's
 * `git fetch origin <branch>` each write FETCH_HEAD marking the branch
 * FOR-MERGE; overlapping writes leave `--ff-only` with two merge candidates and
 * it dies with "Cannot fast-forward to multiple branches". Because a failed
 * pull warns-and-continues, sync then read HEAD off the un-advanced clone and
 * reported `up_to_date` — green on every surface for three weeks.
 *
 * The first test here reproduces the raw race against real git to prove the
 * hazard is real, then proves the lock removes it.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawn } from 'child_process';
import {
  acquireRepoLock,
  tryAcquireRepoLock,
  REPO_LOCK_NAME,
  _resetRepoLockState,
} from '../src/core/repo-lock.ts';

/** Run `rounds` genuinely-concurrent fetch+pull pairs; count --ff-only refusals. */
async function countRaceFailures(clone: string, rounds: number): Promise<number> {
  let hits = 0;
  for (let i = 0; i < rounds; i++) {
    const fetch = spawn('git', ['-C', clone, 'fetch', 'origin', 'main'], { stdio: 'ignore' });
    try {
      execFileSync('git', ['-C', clone, 'pull', '--ff-only'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      const err = `${e?.stderr ?? ''}${e?.message ?? ''}`;
      if (err.includes('Cannot fast-forward to multiple branches')) hits++;
    }
    await new Promise((r) => fetch.on('exit', r));
  }
  return hits;
}

const dirs: string[] = [];

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** An origin repo plus a clone of it, both real git. */
function mkClonePair(): { origin: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-repolock-'));
  dirs.push(root);
  const origin = join(root, 'origin');
  mkdirSync(origin, { recursive: true });
  sh(origin, ['init', '--bare', '--initial-branch=main']);

  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  sh(seed, ['init', '--initial-branch=main']);
  sh(seed, ['config', 'user.email', 't@t.co']);
  sh(seed, ['config', 'user.name', 'T']);
  writeFileSync(join(seed, 'a.md'), '# a\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-m', 'init']);
  sh(seed, ['remote', 'add', 'origin', origin]);
  sh(seed, ['push', '-u', 'origin', 'main']);

  // Extra remote branches make FETCH_HEAD long, widening the window in which a
  // concurrent write can interleave. This is what the real wiki repo looks like
  // (it carries a dozen or so feature branches).
  for (const b of ['x1', 'x2', 'x3', 'x4', 'x5']) {
    sh(seed, ['checkout', '-b', b]);
    sh(seed, ['push', '-u', 'origin', b]);
  }
  sh(seed, ['checkout', 'main']);

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  sh(clone, ['config', 'user.email', 't@t.co']);
  sh(clone, ['config', 'user.name', 'T']);
  return { origin, clone };
}

function lockFile(clone: string): string {
  return join(clone, '.git', REPO_LOCK_NAME);
}

describe('repo-lock', () => {
  beforeEach(() => _resetRepoLockState());

  afterEach(() => {
    _resetRepoLockState();
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test('THE RACE: concurrent fetch + pull --ff-only breaks without the lock', async () => {
    const { clone } = mkClonePair();

    // Reproduce the production failure: an explicit-refspec fetch (what the
    // sync cost-estimator issues) overlapping a pull (what performSync issues).
    // Both write FETCH_HEAD marking main FOR-MERGE; the interleaved file leaves
    // two merge candidates and --ff-only refuses.
    //
    // The fetch MUST be genuinely concurrent — spawn, not execFileSync — or
    // there is no interleaving and this proves nothing.
    const hits = await countRaceFailures(clone, 10);

    // Observed 25/25 locally with the multi-branch origin from mkClonePair.
    // Asserting >0 keeps it meaningful without depending on hitting every time.
    expect(hits).toBeGreaterThan(0);
  });

  test('a second acquirer is refused while the first holds it', () => {
    const { clone } = mkClonePair();
    const a = tryAcquireRepoLock(clone);
    expect(a).not.toBeNull();
    expect(existsSync(lockFile(clone))).toBe(true);

    // Simulate a different process: clear only the in-memory re-entrancy map,
    // leaving the on-disk lock in place, then try again.
    const saved = readFileSync(lockFile(clone), 'utf8');
    _resetRepoLockState();
    writeFileSync(lockFile(clone), saved);

    const b = tryAcquireRepoLock(clone);
    expect(b).toBeNull();
  });

  test('release removes the lock file and lets the next caller in', () => {
    const { clone } = mkClonePair();
    const a = tryAcquireRepoLock(clone)!;
    a.release();
    expect(existsSync(lockFile(clone))).toBe(false);
    const b = tryAcquireRepoLock(clone);
    expect(b).not.toBeNull();
  });

  test('release is idempotent', () => {
    const { clone } = mkClonePair();
    const a = tryAcquireRepoLock(clone)!;
    a.release();
    a.release();
    expect(existsSync(lockFile(clone))).toBe(false);
  });

  test('re-entrant within one process: nested acquire does not deadlock', async () => {
    const { clone } = mkClonePair();
    const outer = await acquireRepoLock(clone, { timeoutMs: 0 });
    expect(outer).not.toBeNull();
    // The sync path acquires around the pull and can reach the estimator, which
    // acquires again. Without re-entrancy that self-deadlocks for the whole
    // timeout and then SKIPS its own pull — the exact silent stall this fixes.
    const inner = await acquireRepoLock(clone, { timeoutMs: 0 });
    expect(inner).not.toBeNull();

    inner!.release();
    // Still held by the outer scope — the file must survive the inner release.
    expect(existsSync(lockFile(clone))).toBe(true);
    outer!.release();
    expect(existsSync(lockFile(clone))).toBe(false);
  });

  test('a lock held by a dead process is reclaimed', () => {
    const { clone } = mkClonePair();
    // pid 2^22 is above Linux's default pid_max and macOS's, so it is reliably
    // absent. Timestamp is fresh, so ONLY the liveness check can reclaim it.
    writeFileSync(lockFile(clone), `4194304 ${new Date().toISOString()}\n`);
    const h = tryAcquireRepoLock(clone);
    expect(h).not.toBeNull();
  });

  test('a fresh lock held by a LIVE process is never stolen', () => {
    const { clone } = mkClonePair();
    // Our own pid is alive by definition.
    writeFileSync(lockFile(clone), `${process.pid} ${new Date().toISOString()}\n`);
    _resetRepoLockState();
    const h = tryAcquireRepoLock(clone);
    expect(h).toBeNull();
  });

  test('an old lock is reclaimed once past staleMs even if the pid is alive', () => {
    const { clone } = mkClonePair();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(lockFile(clone), `${process.pid} ${old}\n`);
    _resetRepoLockState();
    expect(tryAcquireRepoLock(clone, { staleMs: 30 * 60_000 })).not.toBeNull();
  });

  test('an unparseable lock with a live-looking pid is NOT stolen (fail safe)', () => {
    const { clone } = mkClonePair();
    writeFileSync(lockFile(clone), `${process.pid} not-a-date\n`);
    _resetRepoLockState();
    // Wrongly stealing a live lock reintroduces the concurrent-git bug, so an
    // unreadable timestamp must be treated as "held", not "free".
    expect(tryAcquireRepoLock(clone)).toBeNull();
  });

  test('acquireRepoLock waits for a holder and succeeds when it releases', async () => {
    const { clone } = mkClonePair();
    const held = tryAcquireRepoLock(clone)!;

    const saved = readFileSync(lockFile(clone), 'utf8');
    _resetRepoLockState();
    writeFileSync(lockFile(clone), saved);

    setTimeout(() => {
      rmSync(lockFile(clone), { force: true });
    }, 250);

    const started = Date.now();
    const got = await acquireRepoLock(clone, { timeoutMs: 5_000 });
    expect(got).not.toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    got!.release();
    held.release();
  });

  test('acquireRepoLock returns null on timeout rather than hanging', async () => {
    const { clone } = mkClonePair();
    writeFileSync(lockFile(clone), `${process.pid} ${new Date().toISOString()}\n`);
    _resetRepoLockState();
    const got = await acquireRepoLock(clone, { timeoutMs: 300 });
    expect(got).toBeNull();
  });

  test('a non-git path yields no lock instead of throwing', () => {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-notgit-'));
    dirs.push(d);
    expect(tryAcquireRepoLock(d)).toBeNull();
  });

  test('serialised fetch + pull never hits the multiple-branches failure', async () => {
    const { clone } = mkClonePair();
    let failures = 0;
    for (let i = 0; i < 12; i++) {
      // Both operations take the lock, so they cannot interleave FETCH_HEAD —
      // which is the whole point of the fix.
      const l1 = await acquireRepoLock(clone, { timeoutMs: 5_000 });
      try {
        execFileSync('git', ['-C', clone, 'fetch', 'origin', 'main'], { stdio: 'ignore' });
      } finally { l1!.release(); }

      const l2 = await acquireRepoLock(clone, { timeoutMs: 5_000 });
      try {
        execFileSync('git', ['-C', clone, 'pull', '--ff-only'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e: any) {
        const err = `${e?.stderr ?? ''}${e?.message ?? ''}`;
        if (err.includes('Cannot fast-forward to multiple branches')) failures++;
      } finally { l2!.release(); }
    }
    expect(failures).toBe(0);
  });
});
