/**
 * Wikilinks and markdown links into ANY folder, and bare `[[name]]` links,
 * on the DB extraction paths (put_page auto-link, `extract --source db`,
 * `extract --stale`).
 *
 * Found on the Octopi brain: `[[concepts/x]]` produced an edge but
 * `[[notes/x]]` (folder outside DIR_PATTERN) and `[[x]]` (basename) did not,
 * and `extract --stale` — what its timer runs — resolved no bare wikilinks
 * at all, because it used a null resolver.
 *
 * Contract pinned here:
 *   - An exact path in any folder resolves in every mode (it is a plain link).
 *   - Bare basenames resolve when unique by default ('unique'); `true` keeps
 *     the #972 all-matches behaviour; `false` turns basename matching off.
 *   - Dangling targets never produce edges.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { linkPathCandidates, resolveBasenameMode, extractEntityRefs } from '../../src/core/link-extraction.ts';
import { operations, REMOTE_AUTO_LINK_HINT } from '../../src/core/operations.ts';

let engine: PGLiteEngine;
const ENV = 'GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME';
const savedEnv = process.env[ENV];

beforeAll(async () => {
  delete process.env[ENV];
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
});

beforeEach(async () => {
  for (const t of ['content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'pages']) {
    try { await (engine as any).db.exec(`DELETE FROM ${t}`); } catch { /* ok */ }
  }
  try { await (engine as any).db.exec(`DELETE FROM config WHERE key = 'link_resolution.global_basename'`); } catch { /* ok */ }
}, 15_000);

async function page(slug: string, body = '') {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' });
}

async function targets(slug: string): Promise<Array<{ to: string; type: string; source: string | null }>> {
  const links = await engine.getLinks(slug);
  return links
    .map((l: any) => ({ to: l.to_slug, type: l.link_type, source: l.link_source ?? null }))
    .sort((a, b) => a.to.localeCompare(b.to));
}

describe('pure helpers', () => {
  test('linkPathCandidates walks page folder → ancestors → root, with slugified forms', () => {
    expect(linkPathCandidates('wiki/projects/alpha', '../notes/x.md')).toEqual([
      'wiki/notes/x', 'notes/x',
    ]);
    const c = linkPathCandidates('sources/a', 'Notes/My Note');
    expect(c).toContain('Notes/My Note');
    expect(c).toContain('notes/my-note');
    // Never escapes the brain root.
    expect(linkPathCandidates('a', '../../etc/passwd')).toEqual([]);
  });

  test('extractEntityRefs emits generic .md links but not DIR_PATTERN ones twice', () => {
    const refs = extractEntityRefs('[A](../notes/a.md) and [B](../concepts/b.md) and [C](https://x.io/c.md)');
    expect(refs.filter((r) => r.needsResolution).map((r) => r.slug)).toEqual(['../notes/a']);
    expect(refs.filter((r) => !r.needsResolution).map((r) => r.slug)).toEqual(['concepts/b']);
  });

  test('resolveBasenameMode: unset → unique; true → all; false → off', async () => {
    expect(await resolveBasenameMode(engine)).toBe('unique');
    await engine.setConfig('link_resolution.global_basename', 'true');
    expect(await resolveBasenameMode(engine)).toBe('all');
    await engine.setConfig('link_resolution.global_basename', 'false');
    expect(await resolveBasenameMode(engine)).toBe('off');
    await engine.setConfig('link_resolution.global_basename', 'unique');
    expect(await resolveBasenameMode(engine)).toBe('unique');
  });
});

describe('extract --source db', () => {
  test('[[notes/x]], [[Notes/My Note]] and a relative .md link resolve by exact path in any folder', async () => {
    await page('notes/x');
    await page('notes/my-note');
    await page('sources/paper');
    await page('wiki/hub', 'See [[notes/x]], [[Notes/My Note|mine]] and [the paper](../sources/paper.md). Missing: [[notes/nope]].');
    await engine.setConfig('link_resolution.global_basename', 'false'); // exact paths need no basename mode

    await runExtract(engine, ['links', '--source', 'db']);
    const t = await targets('wiki/hub');
    expect(t.map((x) => x.to)).toEqual(['notes/my-note', 'notes/x', 'sources/paper']);
    // Typed like ordinary markdown edges, not basename guesses.
    for (const x of t) expect(x.source).toBe('markdown');
  });

  test('bare [[x]] resolves when its basename is unique (default)', async () => {
    await page('notes/solo');
    await page('wiki/hub', 'Link to [[solo]].');
    await runExtract(engine, ['links', '--source', 'db']);
    expect(await targets('wiki/hub')).toEqual([
      { to: 'notes/solo', type: 'wikilink_basename', source: 'wikilink-resolved' },
    ]);
  });

  test('an ambiguous basename links nowhere by default, everywhere under `true`', async () => {
    await page('notes/dup');
    await page('archive/dup');
    await page('wiki/hub', 'Which one: [[dup]]?');

    await runExtract(engine, ['links', '--source', 'db']);
    expect(await targets('wiki/hub')).toEqual([]);

    await engine.setConfig('link_resolution.global_basename', 'true');
    await runExtract(engine, ['links', '--source', 'db']);
    expect((await targets('wiki/hub')).map((x) => x.to)).toEqual(['archive/dup', 'notes/dup']);
  });

  test('DIR_PATTERN links are unchanged and not duplicated', async () => {
    await page('concepts/graph');
    await page('wiki/hub', 'See [[concepts/graph]].');
    await runExtract(engine, ['links', '--source', 'db']);
    expect((await targets('wiki/hub')).map((x) => x.to)).toEqual(['concepts/graph']);
  });
});

describe('extract --stale (what scheduled timers run)', () => {
  test('resolves any-folder and bare wikilinks', async () => {
    await page('notes/x');
    await page('notes/solo');
    await page('wiki/hub', 'See [[notes/x]] and [[solo]].');
    await runExtract(engine, ['--stale']);
    expect((await targets('wiki/hub')).map((x) => x.to)).toEqual(['notes/solo', 'notes/x']);
  });
});

describe('put_page', () => {
  const putPage = operations.find((o) => o.name === 'put_page')!;
  const doc = (body: string) => `---\ntitle: Hub\ntype: note\n---\n\n${body}\n`;

  test('local put_page auto-links an any-folder wikilink', async () => {
    await page('notes/x');
    await putPage.handler({ engine, remote: false } as never, { slug: 'wiki/hub', content: doc('See [[notes/x]].') });
    expect((await targets('wiki/hub')).map((x) => x.to)).toEqual(['notes/x']);
  });

  test('remote put_page reports the skip with a hint about where edges come from', async () => {
    await page('notes/x');
    const res: any = await putPage.handler(
      { engine, remote: true, sourceId: 'default', logger: { warn() {} } } as never,
      { slug: 'wiki/remote-hub', content: doc('See [[notes/x]].') },
    );
    expect(res.auto_links).toEqual({ skipped: 'remote', hint: REMOTE_AUTO_LINK_HINT });
    expect(REMOTE_AUTO_LINK_HINT).toMatch(/extract --stale/);
    // ...and the next stale extraction builds the edge.
    await runExtract(engine, ['--stale']);
    expect((await targets('wiki/remote-hub')).map((x) => x.to)).toEqual(['notes/x']);
  });
});
