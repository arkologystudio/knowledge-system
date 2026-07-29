/**
 * Source Mirror — end-to-end harness behaviour against a real git repository:
 * seed, idempotency, rename-as-move, forget, per-leg isolation, dry-run, the
 * allowlist under adversarial titles, and the guarantee that authored content is
 * never touched.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ridFor } from '../src/mirror/frontmatter';
import { objectToPath } from '../src/mirror/paths';
import { runMirror } from '../src/mirror/run';
import { stateFilePath } from '../src/mirror/state';
import { CollectingNotifier } from '../src/mirror/notify';
import type { MirrorConfig, RunOptions } from '../src/mirror/types';
import {
  FakeLeg,
  ThrowingLeg,
  cleanupRepo,
  commitCount,
  makeTempRepo,
  obj,
  trackedFiles,
} from './mirror-test-helpers';

const repos: string[] = [];
function repo(): string {
  const dir = makeTempRepo();
  repos.push(dir);
  return dir;
}
afterEach(() => {
  while (repos.length) cleanupRepo(repos.pop() as string);
});

const APPLY: RunOptions = { dryRun: false };
const DRY: RunOptions = { dryRun: true };

function config(
  repoRoot: string,
  legs: MirrorConfig['legs'],
  extra?: Partial<MirrorConfig>,
): MirrorConfig {
  return { repoRoot, legs, ...extra };
}

function gitDiffNames(dir: string, ref = 'HEAD'): string[] {
  const out = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', ref], {
    cwd: dir,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

describe('seed + idempotency', () => {
  test('a first apply writes markdown under sources/, commits, and records state', async () => {
    const dir = repo();
    const leg = new FakeLeg('drive', 'google_drive.file', [
      obj({ upstreamId: 'a', title: 'Alpha', body: 'alpha body' }),
      obj({ upstreamId: 'b', title: 'Beta', body: 'beta body' }),
    ]);
    const before = commitCount(dir);
    const report = await runMirror(config(dir, [leg]), APPLY);

    expect(report.ok).toBe(true);
    expect(commitCount(dir)).toBe(before + 1); // exactly one per-leg commit
    const mirrored = trackedFiles(dir, 'sources');
    expect(mirrored.length).toBe(2);
    expect(mirrored.every(f => f.startsWith('sources/drive/'))).toBe(true);
    expect(existsSync(stateFilePath(dir))).toBe(true);
    // The commit only ever touches sources/** and .mirror/** — never authored trees.
    expect(gitDiffNames(dir).every(f => f.startsWith('sources/') || f.startsWith('.mirror/'))).toBe(true);
  });

  test('re-running with no upstream change produces no second commit', async () => {
    const dir = repo();
    const leg = new FakeLeg('drive', 'google_drive.file', [
      obj({ upstreamId: 'a', title: 'Alpha', body: 'alpha body' }),
    ]);
    await runMirror(config(dir, [leg]), APPLY);
    const afterSeed = commitCount(dir);
    const stateBytes = readFileSync(stateFilePath(dir), 'utf8');

    const report = await runMirror(config(dir, [leg]), APPLY);
    expect(report.legs[0].plan?.unchanged).toBe(true);
    expect(commitCount(dir)).toBe(afterSeed); // no new commit
    expect(readFileSync(stateFilePath(dir), 'utf8')).toBe(stateBytes); // state untouched
  });
});

describe('rename preserves identity', () => {
  test('a retitle moves the file and keeps the same ref_id', async () => {
    const dir = repo();
    const before = obj({ upstreamId: 'x', title: 'Original Name', body: 'stable body' });
    const leg = new FakeLeg('drive', 'google_drive.file', [before]);
    await runMirror(config(dir, [leg]), APPLY);
    const oldPath = objectToPath(leg, before);
    const rid = ridFor(leg, before);
    expect(readFileSync(join(dir, oldPath), 'utf8')).toContain(`ref_id: "${rid}"`);

    const renamed = obj({ upstreamId: 'x', title: 'Brand New Name', body: 'stable body' });
    leg.setObjects([renamed]);
    await runMirror(config(dir, [leg]), APPLY);

    const newPath = objectToPath(leg, renamed);
    expect(existsSync(join(dir, oldPath))).toBe(false); // old file moved away
    expect(existsSync(join(dir, newPath))).toBe(true);
    expect(readFileSync(join(dir, newPath), 'utf8')).toContain(`ref_id: "${rid}"`); // identity preserved
    expect(trackedFiles(dir, 'sources').length).toBe(1); // a move, not a duplicate
  });
});

describe('forget', () => {
  test('dropping an object (under the guard threshold) deletes its file', async () => {
    const dir = repo();
    const keep = obj({ upstreamId: 'k', title: 'Keep', body: 'k' });
    const drop = obj({ upstreamId: 'd', title: 'Drop', body: 'd' });
    const leg = new FakeLeg('drive', 'google_drive.file', [keep, drop]);
    await runMirror(config(dir, [leg]), APPLY);
    expect(existsSync(join(dir, objectToPath(leg, drop)))).toBe(true);

    leg.setObjects([keep]); // 1 of 2 forgotten = 0.5, not > 0.5 → allowed
    await runMirror(config(dir, [leg]), APPLY);
    expect(existsSync(join(dir, objectToPath(leg, drop)))).toBe(false);
    expect(existsSync(join(dir, objectToPath(leg, keep)))).toBe(true);
  });
});

describe('mass-deletion guard end-to-end', () => {
  test('an empty upstream leaves the mirrored files intact and reports the trip', async () => {
    const dir = repo();
    const items = Array.from({ length: 4 }, (_, i) =>
      obj({ upstreamId: `i${i}`, title: `T${i}`, body: `b${i}` }),
    );
    const leg = new FakeLeg('drive', 'google_drive.file', items);
    const notifier = new CollectingNotifier();
    await runMirror(config(dir, [leg], { notifier }), APPLY);
    const afterSeed = commitCount(dir);

    leg.setObjects([]); // simulate an auth glitch returning nothing
    const report = await runMirror(config(dir, [leg], { notifier }), APPLY);
    expect(report.ok).toBe(false);
    expect(report.legs[0].guardTripped).toBe(true);
    expect(trackedFiles(dir, 'sources').length).toBe(4); // nothing deleted
    expect(commitCount(dir)).toBe(afterSeed); // no destructive commit
  });
});

describe('per-leg isolation', () => {
  test('one leg failing does not stop another leg from committing', async () => {
    const dir = repo();
    const bad = new ThrowingLeg('notion', 'notion.page');
    const good = new FakeLeg('drive', 'google_drive.file', [
      obj({ upstreamId: 'a', title: 'A', body: 'a' }),
    ]);
    const notifier = new CollectingNotifier();
    const report = await runMirror(config(dir, [bad, good], { notifier }), APPLY);

    expect(report.ok).toBe(false);
    expect(report.legs.find(l => l.legId === 'notion')?.ok).toBe(false);
    expect(report.legs.find(l => l.legId === 'drive')?.ok).toBe(true);
    expect(trackedFiles(dir, 'sources/drive').length).toBe(1); // good leg still committed
    expect(notifier.failures.map(f => f.legId)).toContain('notion');
  });
});

describe('dry-run', () => {
  test('computes the plan but writes nothing and commits nothing', async () => {
    const dir = repo();
    const leg = new FakeLeg('drive', 'google_drive.file', [
      obj({ upstreamId: 'a', title: 'A', body: 'a' }),
    ]);
    const before = commitCount(dir);
    const report = await runMirror(config(dir, [leg]), DRY);

    expect(report.dryRun).toBe(true);
    expect(report.legs[0].plan?.changes[0].kind).toBe('new');
    expect(commitCount(dir)).toBe(before);
    expect(trackedFiles(dir, 'sources').length).toBe(0);
    expect(existsSync(stateFilePath(dir))).toBe(false);
  });
});

describe('allowlist under adversarial input', () => {
  test('a traversal-styled title still lands under sources/ and never escapes', async () => {
    const dir = repo();
    const evil = obj({ upstreamId: 'e', title: '../../wiki/secret', body: 'nope' });
    const leg = new FakeLeg('drive', 'google_drive.file', [evil]);
    await runMirror(config(dir, [leg]), APPLY);
    const files = trackedFiles(dir, 'sources');
    expect(files.length).toBe(1);
    expect(files[0].startsWith('sources/drive/')).toBe(true);
    expect(existsSync(join(dir, 'wiki/secret'))).toBe(false);
  });

  test('an authored file outside sources/ is never touched by a run', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'wiki/note.md'), '# authored\nhand-written thinking\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'authored note'], { cwd: dir });
    const authoredBefore = readFileSync(join(dir, 'wiki/note.md'), 'utf8');

    const leg = new FakeLeg('drive', 'google_drive.file', [
      obj({ upstreamId: 'a', title: 'A', body: 'a' }),
    ]);
    await runMirror(config(dir, [leg]), APPLY);

    expect(readFileSync(join(dir, 'wiki/note.md'), 'utf8')).toBe(authoredBefore);
    expect(gitDiffNames(dir).some(f => f.startsWith('wiki/'))).toBe(false);
  });
});
