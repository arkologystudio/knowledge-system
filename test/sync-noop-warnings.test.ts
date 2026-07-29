/**
 * A no-op sync must be distinguishable from a blind one.
 *
 * The incident this pins: `git pull` failed on every scheduled run for three
 * weeks. Each failure warned to stderr and continued (the warn-and-continue
 * invariant), sync then read HEAD from the un-updated clone, found it equal to
 * `last_commit`, and returned `up_to_date`. `get_health` agreed — 0 stale pages,
 * 100% embed coverage — because the brain WAS perfectly consistent with a
 * snapshot that had stopped advancing. Every surface reported success while the
 * content silently froze.
 *
 * `SyncResult.warnings` is the discriminator. It is advisory ONLY: status and
 * exit codes are unchanged, so warn-and-continue still holds.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('sync no-op warnings', () => {
  let engine: PGLiteEngine;
  const repos: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterEach(() => {
    while (repos.length) {
      const d = repos.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function personMd(title: string): string {
    return ['---', 'type: person', `title: ${title}`, '---', '', `${title} is a person.`].join('\n');
  }

  /** Temp git repo with one commit. `origin` is set only if a URL is given. */
  function mkRepo(originUrl?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-noop-'));
    repos.push(dir);
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people/alice.md'), personMd('Alice'));
    execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
    if (originUrl) {
      execSync(`git remote add origin ${originUrl}`, { cwd: dir, stdio: 'pipe' });
    }
    return dir;
  }

  const SYNC_OPTS = { noEmbed: true, noExtract: true, sourceId: 'default' } as const;

  test('no-op WITHOUT reaching the remote is flagged, even though status stays up_to_date', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo('https://github.com/acme-example/wiki.git');

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, noPull: true });
    expect(first.status).toBe('first_sync');

    // Second run: nothing changed on disk, and --no-pull means we never looked
    // upstream. This is the exact shape the three-week stall returned.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, noPull: true });
    expect(result.status).toBe('up_to_date');
    expect(result.fromCommit).toBe(result.toCommit);

    const codes = (result.warnings ?? []).map((w) => w.code);
    expect(codes).toContain('noop_without_remote_contact');
  });

  test('a genuinely local repo (no origin) gets NO warning — a no-op there is honest', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo(); // no origin at all

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS, noPull: true });
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, noPull: true });

    expect(result.status).toBe('up_to_date');
    expect(result.warnings ?? []).toEqual([]);
  });

  test('a failed pull is recorded on the result, not just warned to stderr', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // A file:// origin is blocked by protocol.file.allow=never, so the pull
    // fails fast and deterministically without touching the network.
    const repo = mkRepo('file:///nonexistent/unreachable.git');

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS, noPull: true });
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(result.status).toBe('up_to_date');
    const codes = (result.warnings ?? []).map((w) => w.code);
    expect(codes).toContain('pull_failed');
    // Both signals fire: the pull failed AND the resulting no-op is untrusted.
    expect(codes).toContain('noop_without_remote_contact');
  });

  test('the pull_failed message preserves git stderr instead of truncating it away', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo('file:///nonexistent/unreachable.git');

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS, noPull: true });
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    const pullFailed = (result.warnings ?? []).find((w) => w.code === 'pull_failed');
    expect(pullFailed).toBeDefined();
    // The old 100-char slice cut off right after the git invocation, so 8,000+
    // log lines recorded the command and never the cause. Anything past that
    // prefix is the part that was being thrown away.
    expect(pullFailed!.message.length).toBeGreaterThan(100);
  });
});
