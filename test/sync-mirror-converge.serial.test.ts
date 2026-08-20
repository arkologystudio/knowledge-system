/**
 * `gbrain sync` end-to-end on a machine-managed source.
 *
 * The unit tests in `mirror-convergence.serial.test.ts` cover `convergeMirror`
 * itself. This file covers the thing that actually runs in production: the sync
 * path CHOOSING to converge, recovering from the incident state, and reporting
 * the violation through the result rather than only to the log.
 *
 * That last point is the one worth a dedicated test. Violations were previously
 * attached only to the two no-op returns, and a violation almost always coincides
 * with real changes — so the structured warning was dropped in nearly every case
 * it existed for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { performSync } from '../src/commands/sync.ts';
import { MANAGED_SOURCES_KEY } from '../src/core/writer-mode.ts';

let engine: PGLiteEngine;
let root: string;
let remote: string;
let mirror: string;
let author: string;
const originalFileTransport = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function page(name: string, body: string): string {
  return `---\ntitle: ${name}\ntype: note\n---\n\n# ${name}\n\n${body}\n`;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-syncconv-'));
  remote = path.join(root, 'remote.git');
  mirror = path.join(root, 'mirror');
  author = path.join(root, 'author');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, author], { stdio: 'ignore' });
  git(author, ['config', 'user.name', 'GBrain Test']);
  git(author, ['config', 'user.email', 'gbrain-test@example.invalid']);
  fs.mkdirSync(path.join(author, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(author, 'wiki/seed.md'), page('Seed', 'seed body'));
  git(author, ['add', '.']);
  git(author, ['commit', '-m', 'seed']);
  git(author, ['branch', '-M', 'main']);
  git(author, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['clone', remote, mirror], { stdio: 'ignore' });
  git(mirror, ['config', 'user.name', 'GBrain Test']);
  git(mirror, ['config', 'user.email', 'gbrain-test@example.invalid']);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [mirror, 'default']);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function upstream(name: string, body: string): void {
  fs.writeFileSync(path.join(author, `wiki/${name}.md`), page(name, body));
  git(author, ['add', '.']);
  git(author, ['commit', '-m', `add ${name}`]);
  git(author, ['push', 'origin', 'main']);
}

// A function, not a const: `mirror` is assigned per-test in beforeEach.
const syncOpts = (): any => ({ repoPath: mirror, sourceId: 'default', noEmbed: true });

describe('sync on a machine-managed source', () => {
  beforeEach(async () => {
    await engine.setConfig(MANAGED_SOURCES_KEY, 'default');
  });

  test('converges and indexes upstream changes', async () => {
    upstream('alpha', 'first');
    const res: any = await performSync(engine, syncOpts());
    // A fresh brain's first run is a full sync, not an incremental one.
    expect(['synced', 'first_sync']).toContain(res.status);
    expect(git(mirror, ['rev-parse', 'HEAD'])).toBe(git(remote, ['rev-parse', 'refs/heads/main']));
    const rows = await engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', ['wiki/alpha']);
    expect(rows).toHaveLength(1);
  });

  test('RECOVERS from the incident state and reports the violation in the RESULT', async () => {
    // First sync establishes the checkpoint.
    upstream('one', 'one');
    await performSync(engine, syncOpts());

    // Now reproduce the incident: someone commits inside the mirror, and upstream
    // moves on. `--ff-only` would wedge here permanently.
    fs.writeFileSync(path.join(mirror, 'wiki/stray.md'), page('Stray', 'committed into the mirror'));
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'chore: tidy']);
    upstream('two', 'two');

    const res: any = await performSync(engine, syncOpts());

    expect(['synced', 'first_sync']).toContain(res.status);
    expect(git(mirror, ['rev-parse', 'HEAD'])).toBe(git(remote, ['rev-parse', 'refs/heads/main']));

    // The violation reaches the CALLER, not just the journal.
    const warnings = res.warnings ?? [];
    const violation = warnings.find((w: any) => w.code === 'mirror_violation');
    expect(violation).toBeDefined();
    expect(violation.message).toMatch(/local_commits/);

    // Upstream content indexed; the stray never entered the index.
    const two = await engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', ['wiki/two']);
    expect(two).toHaveLength(1);
    const stray = await engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', ['wiki/stray']);
    expect(stray).toHaveLength(0);
  });

  test('--dry-run does NOT converge: no reset, no deletions', async () => {
    // convergeMirror force-moves HEAD and deletes uncommitted files. A command
    // whose entire contract is "show me what would happen" must never be the
    // thing that destroys the tree.
    upstream('preview', 'p');
    const headBefore = git(mirror, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(mirror, 'wiki/uncommitted.md'), page('Uncommitted', 'work in progress'));

    const res: any = await performSync(engine, { ...syncOpts(), dryRun: true });

    expect(fs.existsSync(path.join(mirror, 'wiki/uncommitted.md'))).toBe(true);
    expect(git(mirror, ['rev-parse', 'HEAD'])).toBe(headBefore);
    // And it says WHY the preview does not reflect upstream.
    const warnings = res.warnings ?? [];
    expect(warnings.some((w: any) => /dry-run/i.test(w.message))).toBe(true);
  });

  test('a violation on the FIRST sync still reaches the result', async () => {
    // Declaring a source managed for the first time, with a pre-existing dropping
    // in the tree, is exactly when a violation exists — and it is guaranteed to
    // take the first-sync return path, which used to drop warnings entirely.
    fs.writeFileSync(path.join(mirror, 'wiki/stray.md'), page('Stray', 'pre-existing'));
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'pre-existing local commit']);
    upstream('fresh', 'f');

    const res: any = await performSync(engine, syncOpts());
    const warnings = res.warnings ?? [];
    const violation = warnings.find((w: any) => w.code === 'mirror_violation');
    expect(violation).toBeDefined();
    expect(violation.message).toMatch(/local_commits/);
  });

  test('the checkpoint survives HEAD moving backwards', async () => {
    // Convergence can move HEAD to a commit that is not a descendant of the one
    // the brain last indexed. The delta is an endpoint comparison, so this must
    // produce a correct net result rather than missed pages.
    upstream('keep', 'keep');
    await performSync(engine, syncOpts());

    fs.writeFileSync(path.join(mirror, 'wiki/local-only.md'), page('LocalOnly', 'x'));
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'local']);
    await performSync(engine, syncOpts());

    const res: any = await performSync(engine, syncOpts());
    expect(['synced', 'up_to_date']).toContain(res.status);
    expect(git(mirror, ['rev-parse', 'HEAD'])).toBe(git(remote, ['rev-parse', 'refs/heads/main']));
    const keep = await engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', ['wiki/keep']);
    expect(keep).toHaveLength(1);
  });
});

describe('sync on an UNMANAGED source is untouched', () => {
  test('still pulls, and a divergent clone still fails rather than being reset', async () => {
    // Declaring nothing must change nothing — including keeping the old failure
    // mode, so this change cannot silently reset a checkout someone works in.
    upstream('beta', 'b');
    const res: any = await performSync(engine, syncOpts());
    expect(['synced', 'first_sync']).toContain(res.status);

    fs.writeFileSync(path.join(mirror, 'wiki/mine.md'), page('Mine', 'hand-written'));
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'my work']);
    const localHead = git(mirror, ['rev-parse', 'HEAD']);
    upstream('gamma', 'g');

    await performSync(engine, syncOpts());

    // The local commit is still there: no reset, no quarantine, no data loss.
    expect(git(mirror, ['rev-parse', 'HEAD'])).toBe(localHead);
    expect(fs.existsSync(path.join(mirror, 'wiki/mine.md'))).toBe(true);
  });
});
