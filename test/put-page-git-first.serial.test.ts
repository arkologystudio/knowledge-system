/**
 * End-to-end: `put_page` on a machine-managed source is git-first.
 *
 * These are the pins for the invariant the whole design exists to establish:
 *
 *   On a machine-managed source, no DB page row exists whose content is not
 *   reachable from a commit on the remote.
 *
 * Real git repositories (bare remote + clone), the real `put_page` handler, the
 * real PGLite engine. The negative cases matter more than the positive one: a
 * push that cannot land must leave NOTHING behind, because "index now, reconcile
 * later" is precisely the half-write that caused the 2026-08-18 incident.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import { MANAGED_SOURCES_KEY } from '../src/core/writer-mode.ts';

let engine: PGLiteEngine;
let root: string;
let remote: string;
let checkout: string;
const originalFileTransport = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function page(body: string): string {
  return `---\ntitle: Managed Page\ntype: note\n---\n\n# Managed Page\n\n${body}\n`;
}

const putPage = operations.find((o) => o.name === 'put_page')!;

function ctx(extra: Record<string, unknown> = {}): any {
  return { engine, remote: false, sourceId: 'default', logger: { warn() {} }, ...extra };
}

async function pageRows(slug: string): Promise<unknown[]> {
  return engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', [slug]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (originalFileTransport === undefined) delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  else process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = originalFileTransport;
});

beforeEach(async () => {
  await resetPgliteState(engine);
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-putpage-gitfirst-'));
  remote = path.join(root, 'remote.git');
  checkout = path.join(root, 'checkout');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, checkout], { stdio: 'ignore' });
  git(checkout, ['config', 'user.name', 'GBrain Test']);
  git(checkout, ['config', 'user.email', 'gbrain-test@example.invalid']);
  fs.writeFileSync(path.join(checkout, 'README.md'), '# Brain\n');
  git(checkout, ['add', 'README.md']);
  git(checkout, ['commit', '-m', 'seed']);
  git(checkout, ['branch', '-M', 'main']);
  git(checkout, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [checkout, 'default']);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('put_page on a machine-managed source', () => {
  beforeEach(async () => {
    await engine.setConfig(MANAGED_SOURCES_KEY, 'default');
  });

  test('commits and pushes the exact caller content, then indexes', async () => {
    const content = page('Anchored in git.');
    const res: any = await putPage.handler(ctx(), { slug: 'wiki/managed', content });

    expect(res.writer_mode).toBe('git-first');
    expect(res.writer_managed).toBe(true);
    expect(res.git_first?.committed).toBe(true);

    // The remote — not merely the local clone — carries the page.
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(remote, ['rev-parse', 'refs/heads/main']));
    // Read the working-tree file rather than `git show`, whose output the test
    // helper trims — the trailing newline is part of the canonical bytes.
    expect(fs.readFileSync(path.join(checkout, 'wiki/managed.md'), 'utf8')).toBe(content);
    expect(git(checkout, ['show', 'HEAD:wiki/managed.md'])).toBe(content.trim());

    // And the index knows about it.
    expect(await pageRows('wiki/managed')).toHaveLength(1);
  });

  test('the committed file carries NO provenance stamps', async () => {
    // The incident's add/add conflict was pure frontmatter noise: identical
    // bodies, divergent machine stamps. Committing the caller's own bytes rather
    // than the DB's re-serialisation removes that collision class entirely.
    await putPage.handler(ctx({ remote: true }), { slug: 'wiki/clean', content: page('No stamps.') });
    const committed = git(checkout, ['show', 'HEAD:wiki/clean.md']);
    expect(committed).not.toContain('ingested_via');
    expect(committed).not.toContain('ingested_at');
    expect(committed).not.toContain('source_kind');
  });

  test('write-through is skipped, so nothing is left uncommitted', async () => {
    const res: any = await putPage.handler(ctx(), { slug: 'wiki/no-droppings', content: page('x') });
    expect(res.write_through).toEqual({ written: false, skipped: 'git_first' });
    // The clone is clean: no untracked page waiting for a human to commit it.
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
  });

  test('re-writing identical content is a no-op commit but still indexes', async () => {
    const content = page('Same bytes twice.');
    await putPage.handler(ctx(), { slug: 'wiki/idem', content });
    const headAfterFirst = git(checkout, ['rev-parse', 'HEAD']);

    const res: any = await putPage.handler(ctx(), { slug: 'wiki/idem', content });
    expect(res.git_first?.unchanged).toBe(true);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(headAfterFirst);
    expect(await pageRows('wiki/idem')).toHaveLength(1);
  });

  test('a push that cannot land writes NO database row', async () => {
    // Break the remote so the push fails after a successful local commit. The
    // brain must not end up holding a page git has never seen — that is the
    // exact state the design forbids.
    fs.rmSync(remote, { recursive: true, force: true });

    await expect(
      putPage.handler(ctx(), { slug: 'wiki/unpushable', content: page('never lands') }),
    ).rejects.toThrow(/git-first write failed/);

    expect(await pageRows('wiki/unpushable')).toHaveLength(0);
  });

  test('a protected slug is refused and writes nothing', async () => {
    await engine.setConfig('writer.commit_page.protected_slugs', 'north-star,voice/*');
    await expect(
      putPage.handler(ctx({ remote: true }), { slug: 'voice/tone', content: page('nope') }),
    ).rejects.toThrow(/git-first write failed/);
    expect(await pageRows('voice/tone')).toHaveLength(0);
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
  });

  test('content with invalid frontmatter is refused rather than committed', async () => {
    await expect(
      putPage.handler(ctx(), { slug: 'wiki/broken', content: 'no frontmatter at all\n' }),
    ).rejects.toThrow(/git-first write failed/);
    expect(await pageRows('wiki/broken')).toHaveLength(0);
  });

  test('a dry run touches neither git nor the index', async () => {
    const head = git(checkout, ['rev-parse', 'HEAD']);
    await putPage.handler(ctx({ dryRun: true }), { slug: 'wiki/dry', content: page('dry') });
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await pageRows('wiki/dry')).toHaveLength(0);
  });
});

describe('put_page on an unmanaged source keeps its pre-existing behaviour', () => {
  test('local-tree still writes through, and does NOT commit', async () => {
    // Declaring nothing must change nothing — the personal-wiki shape, where a
    // human commits from Obsidian, stays exactly as it was.
    const head = git(checkout, ['rev-parse', 'HEAD']);
    const res: any = await putPage.handler(ctx(), { slug: 'wiki/hand-tended', content: page('human commits this') });

    expect(res.writer_mode).toBe('local-tree');
    expect(res.writer_managed).toBe(false);
    expect(res.write_through?.written).toBe(true);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.existsSync(path.join(checkout, 'wiki/hand-tended.md'))).toBe(true);
    expect(await pageRows('wiki/hand-tended')).toHaveLength(1);
  });
});
