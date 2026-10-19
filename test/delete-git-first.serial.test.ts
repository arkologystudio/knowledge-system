/**
 * Deletions in git-first mode.
 *
 *   - `delete_page` on a machine-managed source must remove the file from git
 *     (git rm + commit + PUSH) before tombstoning the index row. Previously it
 *     only soft-deleted the row and the file stayed in origin.
 *   - Sync must tombstone pages whose files were removed — including pages a
 *     git-first put_page indexed (NULL source_path), which the full-sync
 *     reconcile used to spare forever on a managed source.
 *   - Sync deletes are SOFT (recoverable), and a re-added file resurrects.
 *
 * Real git (bare remote + clone), real handlers, real PGLite.
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

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\ntype: note\n---\n\n# ${title}\n\n${body}\n`;
}

const putPage = operations.find((o) => o.name === 'put_page')!;
const deletePage = operations.find((o) => o.name === 'delete_page')!;

function ctx(extra: Record<string, unknown> = {}): any {
  return { engine, remote: false, sourceId: 'default', logger: { warn() {} }, ...extra };
}

async function row(slug: string): Promise<{ slug: string; deleted_at: unknown; source_path: string | null } | undefined> {
  const rows = await engine.executeRaw<{ slug: string; deleted_at: unknown; source_path: string | null }>(
    'SELECT slug, deleted_at, source_path FROM pages WHERE slug = $1 AND source_id = $2',
    [slug, 'default'],
  );
  return rows[0];
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-delete-gitfirst-'));
  remote = path.join(root, 'remote.git');
  checkout = path.join(root, 'checkout');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, checkout], { stdio: 'ignore' });
  git(checkout, ['config', 'user.name', 'GBrain Test']);
  git(checkout, ['config', 'user.email', 'gbrain-test@example.invalid']);
  fs.mkdirSync(path.join(checkout, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'wiki/keep.md'), page('Keep', 'Stays.'));
  git(checkout, ['add', '-A']);
  git(checkout, ['commit', '-m', 'seed']);
  git(checkout, ['branch', '-M', 'main']);
  git(checkout, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [checkout, 'default']);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('delete_page on a machine-managed source', () => {
  beforeEach(async () => {
    await engine.setConfig(MANAGED_SOURCES_KEY, 'default');
    await engine.setConfig('writer.commit_page.enabled', 'true');
  });

  test('git rm + commit + push, then soft-delete', async () => {
    await putPage.handler(ctx(), { slug: 'wiki/doomed', content: page('Doomed', 'Going away.') });
    expect(fs.existsSync(path.join(checkout, 'wiki/doomed.md'))).toBe(true);

    const res: any = await deletePage.handler(ctx(), { slug: 'wiki/doomed' });
    expect(res.status).toBe('soft_deleted');
    expect(res.git?.committed).toBe(true);

    // Gone from the remote, not merely the clone.
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(remote, ['rev-parse', 'refs/heads/main']));
    expect(() => git(remote, ['cat-file', '-e', 'refs/heads/main:wiki/doomed.md'])).toThrow();
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
    // Index row tombstoned (recoverable), and the other page untouched.
    expect((await row('wiki/doomed'))?.deleted_at ?? null).not.toBeNull();
    expect(git(remote, ['show', 'refs/heads/main:wiki/keep.md'])).toContain('Stays.');
  });

  test('uses the indexed source_path for sync-imported pages', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    fs.mkdirSync(path.join(checkout, 'Meetings'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'Meetings/Weekly Sync.md'), page('Weekly Sync', 'Agenda.'));
    git(checkout, ['add', '-A']);
    git(checkout, ['commit', '-m', 'add meeting']);
    git(checkout, ['push', 'origin', 'main']);
    await performSync(engine, { repoPath: checkout, ...SYNC_OPTS });

    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = 'Meetings/Weekly Sync.md'`,
    );
    expect(rows).toHaveLength(1);
    const res: any = await deletePage.handler(ctx(), { slug: rows[0].slug });
    expect(res.git?.committed).toBe(true);
    expect(() => git(remote, ['cat-file', '-e', 'refs/heads/main:Meetings/Weekly Sync.md'])).toThrow();
  });

  test('a push failure fails the delete and leaves both git and the index untouched', async () => {
    await putPage.handler(ctx(), { slug: 'wiki/sticky', content: page('Sticky', 'Stays put.') });
    const before = git(remote, ['rev-parse', 'refs/heads/main']);
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused by test" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    await expect(deletePage.handler(ctx(), { slug: 'wiki/sticky' })).rejects.toThrow(/push/);
    expect(git(remote, ['rev-parse', 'refs/heads/main'])).toBe(before);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(before);   // rolled back
    expect(fs.existsSync(path.join(checkout, 'wiki/sticky.md'))).toBe(true);
    expect((await row('wiki/sticky'))?.deleted_at).toBeNull();
  });

  test('a file already absent from git still tombstones the row', async () => {
    await engine.putPage('wiki/db-only-ghost', { type: 'note', title: 'Ghost', compiled_truth: 'x' }, { sourceId: 'default' });
    const res: any = await deletePage.handler(ctx(), { slug: 'wiki/db-only-ghost' });
    expect(res.status).toBe('soft_deleted');
    expect(res.git?.committed).toBe(false);
  });

  test('remote callers are gated exactly like a git-first put_page', async () => {
    await putPage.handler(ctx(), { slug: 'wiki/gated', content: page('Gated', 'x') });
    await engine.setConfig('writer.commit_page.enabled', 'false');
    await expect(deletePage.handler(ctx({ remote: true }), { slug: 'wiki/gated' })).rejects.toThrow(/disabled/);
    expect((await row('wiki/gated'))?.deleted_at).toBeNull();
  });
});

describe('delete_page on an unmanaged source keeps the DB-only soft-delete', () => {
  test('no git activity', async () => {
    await engine.putPage('wiki/local', { type: 'note', title: 'Local', compiled_truth: 'x' }, { sourceId: 'default' });
    const head = git(checkout, ['rev-parse', 'HEAD']);
    const res: any = await deletePage.handler(ctx(), { slug: 'wiki/local' });
    expect(res.status).toBe('soft_deleted');
    expect(res.git).toBeUndefined();
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
  });
});

describe('sync propagates file removals', () => {
  test('full sync on a managed source tombstones a git-first page whose file was removed', async () => {
    await engine.setConfig(MANAGED_SOURCES_KEY, 'default');
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath: checkout, ...SYNC_OPTS });
    // Indexed via put_page's importFromContent → NULL source_path.
    await putPage.handler(ctx(), { slug: 'wiki/orphan', content: page('Orphan', 'x') });
    await engine.executeRaw(`UPDATE pages SET source_path = NULL WHERE slug = 'wiki/orphan'`);
    expect((await row('wiki/orphan'))?.source_path).toBeNull();

    git(checkout, ['rm', '-q', 'wiki/orphan.md']);
    git(checkout, ['commit', '-m', 'remove orphan']);

    const result = await performSync(engine, { repoPath: checkout, full: true, ...SYNC_OPTS });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect((await row('wiki/orphan'))?.deleted_at ?? null).not.toBeNull();   // soft, recoverable
    expect((await row('wiki/keep'))?.deleted_at).toBeNull();
  });

  test('full sync on an UNMANAGED source still spares NULL-source_path pages (#1433 guard)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath: checkout, ...SYNC_OPTS });
    await engine.putPage('manual/note', { type: 'note', title: 'Manual', compiled_truth: 'x' }, { sourceId: 'default' });
    await performSync(engine, { repoPath: checkout, full: true, ...SYNC_OPTS });
    expect((await row('manual/note'))?.deleted_at).toBeNull();
  });

  test('incremental sync soft-deletes, and re-adding the file resurrects the page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    fs.writeFileSync(path.join(checkout, 'wiki/flip.md'), page('Flip', 'v1'));
    git(checkout, ['add', '-A']);
    git(checkout, ['commit', '-m', 'add flip']);
    await performSync(engine, { repoPath: checkout, ...SYNC_OPTS });
    expect((await row('wiki/flip'))?.deleted_at).toBeNull();

    git(checkout, ['rm', '-q', 'wiki/flip.md']);
    git(checkout, ['commit', '-m', 'remove flip']);
    const del = await performSync(engine, { repoPath: checkout, ...SYNC_OPTS });
    expect(del.deleted).toBe(1);
    expect((await row('wiki/flip'))?.deleted_at ?? null).not.toBeNull();
    expect(await engine.getPage('wiki/flip')).toBeNull();

    git(checkout, ['revert', '--no-edit', 'HEAD']);
    await performSync(engine, { repoPath: checkout, ...SYNC_OPTS });
    expect((await row('wiki/flip'))?.deleted_at).toBeNull();
    expect(await engine.getPage('wiki/flip')).not.toBeNull();
  });
});
