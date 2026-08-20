/**
 * Writer-mode derivation pins.
 *
 * The load-bearing property is not "the modes exist" — it is that a
 * machine-managed source CANNOT be configured into the shape that caused the
 * 2026-08-18 incident (DB-authoritative pages living uncommitted inside a tree a
 * machine resets). These tests assert the refusals as hard as the happy paths.
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveWriterMode,
  isManagedSource,
  resolveSourceRepoPath,
  WriterModeError,
  MANAGED_SOURCES_KEY,
  writerModeKeyFor,
} from '../src/core/writer-mode.ts';

/** Minimal engine stub: just the two reads writer-mode performs. */
function fakeEngine(opts: {
  sources?: Record<string, string | null>;
  config?: Record<string, string>;
}): any {
  const sources = opts.sources ?? {};
  const config = opts.config ?? {};
  return {
    async getConfig(key: string) {
      return config[key] ?? null;
    },
    async executeRaw(sql: string, params: unknown[]) {
      if (sql.includes('SELECT local_path FROM sources WHERE id')) {
        const id = String(params[0]);
        return id in sources ? [{ local_path: sources[id] }] : [];
      }
      if (sql.includes('SELECT id FROM sources WHERE id <> $1 AND local_path = $2')) {
        const [self, path] = [String(params[0]), String(params[1])];
        const clash = Object.entries(sources).find(([id, p]) => id !== self && p === path);
        return clash ? [{ id: clash[0] }] : [];
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe('resolveSourceRepoPath', () => {
  test('prefers the source\'s own local_path', async () => {
    const e = fakeEngine({ sources: { default: '/srv/brain' }, config: { 'sync.repo_path': '/other' } });
    expect(await resolveSourceRepoPath(e, 'default')).toBe('/srv/brain');
  });

  test('falls back to sync.repo_path when the source has none', async () => {
    const e = fakeEngine({ sources: { default: null }, config: { 'sync.repo_path': '/fallback' } });
    expect(await resolveSourceRepoPath(e, 'default')).toBe('/fallback');
  });

  test('refuses the fallback when it is another source\'s working tree (#2018)', async () => {
    // Nesting one source's pages inside a sibling's checkout pollutes a repo
    // nobody asked us to write to.
    const e = fakeEngine({
      sources: { default: null, other: '/srv/other' },
      config: { 'sync.repo_path': '/srv/other' },
    });
    expect(await resolveSourceRepoPath(e, 'default')).toBeNull();
  });

  test('returns null when nothing is configured', async () => {
    expect(await resolveSourceRepoPath(fakeEngine({ sources: { default: null } }), 'default')).toBeNull();
  });
});

describe('managed declaration', () => {
  test('parses a comma list with whitespace', async () => {
    const e = fakeEngine({ config: { [MANAGED_SOURCES_KEY]: ' default , wiki ' } });
    expect(await isManagedSource(e, 'default')).toBe(true);
    expect(await isManagedSource(e, 'wiki')).toBe(true);
    expect(await isManagedSource(e, 'other')).toBe(false);
  });

  test('undeclared means unmanaged', async () => {
    expect(await isManagedSource(fakeEngine({}), 'default')).toBe(false);
  });
});

describe('resolveWriterMode — machine-managed sources', () => {
  test('forces git-first', async () => {
    const e = fakeEngine({
      sources: { default: '/srv/brain' },
      config: { [MANAGED_SOURCES_KEY]: 'default' },
    });
    const r = await resolveWriterMode(e, 'default');
    expect(r.mode).toBe('git-first');
    expect(r.managed).toBe(true);
    expect(r.repoPath).toBe('/srv/brain');
  });

  test('REFUSES a local-tree override — this combination is the incident', async () => {
    const e = fakeEngine({
      sources: { default: '/srv/brain' },
      config: { [MANAGED_SOURCES_KEY]: 'default', [writerModeKeyFor('default')]: 'local-tree' },
    });
    await expect(resolveWriterMode(e, 'default')).rejects.toThrow(WriterModeError);
    await expect(resolveWriterMode(e, 'default')).rejects.toThrow(/forced to 'git-first'/);
  });

  test('REFUSES a db-only override', async () => {
    const e = fakeEngine({
      sources: { default: '/srv/brain' },
      config: { [MANAGED_SOURCES_KEY]: 'default', 'writer.mode': 'db-only' },
    });
    await expect(resolveWriterMode(e, 'default')).rejects.toThrow(/forced to 'git-first'/);
  });

  test('accepts a redundant explicit git-first', async () => {
    const e = fakeEngine({
      sources: { default: '/srv/brain' },
      config: { [MANAGED_SOURCES_KEY]: 'default', 'writer.mode': 'git-first' },
    });
    expect((await resolveWriterMode(e, 'default')).mode).toBe('git-first');
  });

  test('managed but no checkout is a hard configuration error, not a silent downgrade', async () => {
    // Degrading to db-only here would recreate the half-write under a different
    // name, so it throws instead.
    const e = fakeEngine({ sources: { default: null }, config: { [MANAGED_SOURCES_KEY]: 'default' } });
    await expect(resolveWriterMode(e, 'default')).rejects.toThrow(/no local checkout/);
  });
});

describe('resolveWriterMode — unmanaged sources', () => {
  test('defaults to local-tree when a checkout exists (pre-existing behaviour)', async () => {
    const e = fakeEngine({ sources: { default: '/home/me/wiki' } });
    const r = await resolveWriterMode(e, 'default');
    expect(r.mode).toBe('local-tree');
    expect(r.managed).toBe(false);
  });

  test('defaults to db-only with no checkout', async () => {
    const r = await resolveWriterMode(fakeEngine({ sources: { default: null } }), 'default');
    expect(r.mode).toBe('db-only');
    expect(r.repoPath).toBeNull();
  });

  test('git-first is available opt-in', async () => {
    const e = fakeEngine({
      sources: { default: '/home/me/wiki' },
      config: { [writerModeKeyFor('default')]: 'git-first' },
    });
    expect((await resolveWriterMode(e, 'default')).mode).toBe('git-first');
  });

  test('per-source override beats the global default', async () => {
    const e = fakeEngine({
      sources: { a: '/repo-a' },
      config: { 'writer.mode': 'db-only', [writerModeKeyFor('a')]: 'local-tree' },
    });
    expect((await resolveWriterMode(e, 'a')).mode).toBe('local-tree');
  });

  test('an unrecognized mode string throws rather than falling back permissively', async () => {
    // The self-upgrade resolver's permissive fallback let a typo silently
    // re-enable a channel; a writer-mode typo must not silently pick a weaker
    // guarantee.
    const e = fakeEngine({ sources: { default: '/repo' }, config: { 'writer.mode': 'git_first' } });
    await expect(resolveWriterMode(e, 'default')).rejects.toThrow(/unrecognized writer mode/);
  });

  test('a repo-requiring mode with no repo throws', async () => {
    const e = fakeEngine({ sources: { default: null }, config: { 'writer.mode': 'local-tree' } });
    await expect(resolveWriterMode(e, 'default')).rejects.toThrow(/requires a local checkout/);
  });

  test('db-only is legal with no repo', async () => {
    const e = fakeEngine({ sources: { default: null }, config: { 'writer.mode': 'db-only' } });
    expect((await resolveWriterMode(e, 'default')).mode).toBe('db-only');
  });
});
