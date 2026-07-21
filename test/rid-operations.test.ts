/**
 * v128 — the op-layer surface of Reference Identifiers.
 *
 *   - `resolve_rid`: identifier → page, source-scoped, plus locators.
 *   - `list_pages`: projects `rid` so a caller enumerating pages can hold a
 *     reference that survives a rename.
 *   - `search`: stamps `rid` onto results post-fusion, which is what makes an
 *     agent's citation outlive the page's slug.
 *
 * The source-scoping assertions here are the load-bearing ones: a RID carries
 * no source, so an unscoped lookup would be a cross-source read of any page by
 * identifier.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations as OPERATIONS } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const resolveRid = () => OPERATIONS.find(o => o.name === 'resolve_rid')!;
const listPages = () => OPERATIONS.find(o => o.name === 'list_pages')!;
const searchOp = () => OPERATIONS.find(o => o.name === 'search')!;

function ctxFor(extra: Record<string, unknown> = {}): any {
  return { engine, config: null, logger: console, dryRun: false, remote: false, ...extra };
}

const PAGE = {
  type: 'note' as const,
  title: 'Widget evaluation',
  compiled_truth: 'A page about widget evaluation and procurement.',
  timeline: '',
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('alpha', 'alpha') ON CONFLICT (id) DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('beta', 'beta') ON CONFLICT (id) DO NOTHING`,
  );
});

describe('resolve_rid', () => {
  test('is registered as a read-scope op', () => {
    expect(resolveRid()).toBeDefined();
    expect(resolveRid().scope).toBe('read');
    expect(resolveRid().mutating).toBeUndefined();
  });

  test('resolves an identifier to its page', async () => {
    const page = await engine.putPage('notes/resolvable', PAGE);
    const out = await resolveRid().handler(ctxFor(), { rid: page.rid }) as any;
    expect(out.resolved).toBe(true);
    expect(out.slug).toBe('notes/resolvable');
    expect(out.title).toBe('Widget evaluation');
    expect(out.rid).toBe(page.rid);
  });

  test('still resolves after the page is RENAMED', async () => {
    // ACCEPTANCE CRITERION: a citation stays valid after the cited page is
    // renamed. The slug in the response changes; the identifier does not.
    const page = await engine.putPage('notes/before-rename', PAGE);
    await engine.updateSlug('notes/before-rename', 'archive/after-rename', { sourceId: 'default' });
    const out = await resolveRid().handler(ctxFor(), { rid: page.rid }) as any;
    expect(out.resolved).toBe(true);
    expect(out.slug).toBe('archive/after-rename');
  });

  test('returns locators for an external identifier this brain does not hold', async () => {
    // "One name, many locators" — an identifier minted elsewhere still answers
    // usefully: we cannot serve the content, but we can say where it lives.
    const out = await resolveRid().handler(ctxFor(), {
      rid: 'orn:google_drive.file:1AbC_dEf',
    }) as any;
    expect(out.resolved).toBe(false);
    expect(out.locators).toHaveLength(1);
    expect(out.locators[0].kind).toBe('external');
    expect(out.locators[0].uri).toContain('drive.google.com');
  });

  test('rejects a malformed identifier with a grammar error, not a silent miss', async () => {
    await expect(resolveRid().handler(ctxFor(), { rid: 'not-a-rid' }))
      .rejects.toThrow(/Invalid rid/);
  });

  test('SOURCE SCOPE: a scalar-scoped caller cannot resolve another source\'s page', async () => {
    const page = await engine.putPage('notes/alpha-only', PAGE, { sourceId: 'alpha' });
    const asAlpha = await resolveRid().handler(ctxFor({ sourceId: 'alpha' }), { rid: page.rid }) as any;
    expect(asAlpha.resolved).toBe(true);
    const asBeta = await resolveRid().handler(ctxFor({ sourceId: 'beta' }), { rid: page.rid }) as any;
    expect(asBeta.resolved).toBe(false);
  });

  test('SOURCE SCOPE: a federated grant is honoured, and an empty grant does not widen', async () => {
    const page = await engine.putPage('notes/federated', PAGE, { sourceId: 'alpha' });
    const granted = await resolveRid().handler(
      ctxFor({ auth: { allowedSources: ['alpha'] } }), { rid: page.rid },
    ) as any;
    expect(granted.resolved).toBe(true);

    const wrongGrant = await resolveRid().handler(
      ctxFor({ auth: { allowedSources: ['beta'] } }), { rid: page.rid },
    ) as any;
    expect(wrongGrant.resolved).toBe(false);
  });

  test('an out-of-scope hit is INDISTINGUISHABLE from an unknown identifier', async () => {
    // Otherwise the op becomes an existence oracle: a caller could probe for
    // pages it cannot read by watching which identifiers answer differently.
    const page = await engine.putPage('notes/secret', PAGE, { sourceId: 'alpha' });
    const outOfScope = await resolveRid().handler(ctxFor({ sourceId: 'beta' }), { rid: page.rid }) as any;
    const unknown = await resolveRid().handler(ctxFor({ sourceId: 'beta' }), {
      rid: 'orn:habitat.page:00000000-0000-4000-8000-000000000000',
    }) as any;
    expect(Object.keys(outOfScope).sort()).toEqual(Object.keys(unknown).sort());
    expect(outOfScope.resolved).toBe(unknown.resolved);
  });

  test('a soft-deleted page is hidden by default and surfaced on request', async () => {
    const page = await engine.putPage('notes/tombstoned', PAGE);
    await engine.softDeletePage('notes/tombstoned', { sourceId: 'default' });
    const hidden = await resolveRid().handler(ctxFor(), { rid: page.rid }) as any;
    expect(hidden.resolved).toBe(false);
    const shown = await resolveRid().handler(ctxFor(), { rid: page.rid, include_deleted: true }) as any;
    expect(shown.resolved).toBe(true);
    expect(shown.deleted_at).toBeDefined();
  });
});

describe('list_pages projects the identifier', () => {
  test('every listed page carries its rid', async () => {
    await engine.putPage('notes/listed-a', PAGE);
    await engine.putPage('notes/listed-b', PAGE);
    const rows = await listPages().handler(ctxFor(), {}) as Array<{ slug: string; rid?: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.rid).toBeDefined();
      expect(r.rid).toMatch(/^orn:habitat\.page:/);
    }
  });
});

describe('search stamps the identifier onto results', () => {
  test('results carry a rid, so a citation survives the page being renamed', async () => {
    // Keyword-only mode keeps this hermetic — no embedding provider needed —
    // and exercises the branch that bypasses hybridSearch, which is the one
    // most likely to be forgotten when adding post-fusion decoration.
    await engine.setConfig('search.mcp_keyword_only', 'true');
    const page = await engine.putPage('notes/citable', PAGE);
    await engine.upsertChunks('notes/citable', [{
      chunk_index: 0,
      chunk_text: 'A page about widget evaluation and procurement.',
      chunk_source: 'compiled_truth',
    }] as never);

    const results = await searchOp().handler(ctxFor(), { query: 'widget evaluation' }) as Array<{ slug: string; rid?: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rid).toBe(page.rid);

    // Rename, re-search: the slug moved, the identifier did not.
    await engine.updateSlug('notes/citable', 'archive/citable', { sourceId: 'default' });
    const after = await searchOp().handler(ctxFor(), { query: 'widget evaluation' }) as Array<{ slug: string; rid?: string }>;
    expect(after[0].slug).toBe('archive/citable');
    expect(after[0].rid).toBe(page.rid);
  });

  test('stamping is FAIL-SOFT — a lookup failure degrades the citation, not retrieval', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    await engine.putPage('notes/failsoft', PAGE);
    await engine.upsertChunks('notes/failsoft', [{
      chunk_index: 0,
      chunk_text: 'A page about widget evaluation and procurement.',
      chunk_source: 'compiled_truth',
    }] as never);

    const broken = Object.create(engine);
    broken.getRidsByPageIds = async () => { throw new Error('identity lookup exploded'); };

    const results = await searchOp().handler(
      ctxFor({ engine: broken }), { query: 'widget evaluation' },
    ) as Array<{ slug: string; rid?: string }>;
    // Retrieval still works; the results simply carry no identifier.
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rid).toBeUndefined();
  });
});
