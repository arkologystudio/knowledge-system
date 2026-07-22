/**
 * Shared fixtures for the Source Mirror harness tests: an in-memory fake leg, a
 * throwing leg (for per-leg isolation), and a disposable git repo. No network,
 * no real credentials — the harness is fully exercisable on synthetic input.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RidNamespace } from '../src/core/rid';
import type { MirrorSource, SourceObject } from '../src/mirror/types';

/** Build a SourceObject with sensible defaults. */
export function obj(
  partial: Partial<SourceObject> & { upstreamId: string; title: string; body: string },
): SourceObject {
  return { upstreamMtime: '2026-07-01T00:00:00.000Z', ...partial };
}

/** An in-memory leg that yields a fixed (mutable) set of objects. */
export class FakeLeg implements MirrorSource {
  constructor(
    public readonly id: string,
    public readonly namespace: RidNamespace,
    private objects: SourceObject[],
  ) {}
  setObjects(objects: SourceObject[]): void {
    this.objects = objects;
  }
  async *list(): AsyncIterable<SourceObject> {
    for (const o of this.objects) yield o;
  }
}

/** A leg whose enumeration throws — used to prove one leg's failure is isolated. */
export class ThrowingLeg implements MirrorSource {
  constructor(
    public readonly id: string,
    public readonly namespace: RidNamespace,
    private readonly message = 'upstream unavailable',
  ) {}
  async *list(): AsyncIterable<SourceObject> {
    throw new Error(this.message);
  }
}

/** Create a disposable git repo with an initial commit, so HEAD exists. Returns its path. */
export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-test-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Mirror Test']);
  g(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# brain\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

/** Remove a temp repo. */
export function cleanupRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Number of commits reachable from HEAD. */
export function commitCount(dir: string): number {
  const out = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return parseInt(out.trim(), 10);
}

/** Tracked files matching a repo-relative prefix (via `git ls-files`). */
export function trackedFiles(dir: string, prefix = ''): string[] {
  const out = execFileSync('git', ['ls-files', prefix || '.'], { cwd: dir, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}
