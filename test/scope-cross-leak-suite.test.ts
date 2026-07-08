/**
 * Knowledge System T3 — cross-scope LEAK-TEST SUITE (note + artefact classes).
 *
 * Purpose (per the RE-SCOPED T3 task): PROVE, at the operation-handler layer,
 * that per-`source_id` scope isolation holds fail-closed across EVERY read path
 * for BOTH content classes:
 *   - the authored NOTE class (`pages` + its `content_chunks`), and
 *   - the T1 raw-ARTEFACT class (`artifacts` + artefact-scoped `content_chunks`
 *     carrying `page_id = NULL`, migration v123).
 *
 * A caller scoped to source A must NOT be able to read source B's content —
 * notes OR artefacts — through any of:
 *   query · search · get_page · get_chunks · traverse_graph ·
 *   get_backlinks · get_links · list_pages
 *
 * It also pins the two scope-widening invariants the operator called out:
 *   - `__all__` widens ONLY to the caller's grant for a remote caller
 *     (never to the whole brain), and spans everything only for trusted local.
 *   - an explicit out-of-grant `source_id` → `permission_denied`.
 *
 * This is a TEST-ONLY deliverable. It changes no product code — it does not
 * touch operations.ts (kept clear of T2/T4). Enforcement itself already lives
 * in the operations.ts read paths (sourceScopeOpts / resolveRequestedScope /
 * linkReadScopeOpts, v0.34.1 #861 / #876 / #1924 / #2200); this suite is the
 * cross-class regression harness the F4 "app-layer is sufficient for Phase 1"
 * decision rests on.
 *
 * ── ARTEFACT-CLASS SCOPE ENFORCEMENT (T4 — read before extending) ──────────
 * T4 wired artefact chunks INTO the hybrid retrieval path. Every chunk-content
 * read path (search/query → searchKeyword / searchKeywordChunks / searchVector,
 * both engines) now scans `FROM content_chunks cc LEFT JOIN pages p ... LEFT
 * JOIN artifacts a ...` and scopes on the UNIFIED source
 * `COALESCE(p.source_id, a.source_id)`. So the artefact class inherits scope
 * enforcement STRUCTURALLY — via `artifacts.source_id`, routed through the same
 * fail-closed resolvers (sourceScopeOpts / resolveRequestedScope) as pages.
 * Artefact chunks (`page_id = NULL`, `artifact_id` set) surface with a synthetic
 * slug (`artifact:<object_id>`) + `content_class = 'artifact'` tag, ranked in
 * ONE space alongside notes.
 *
 * This suite therefore now exercises REAL, non-vacuous isolation: §4 proves B's
 * artefact IS retrievable in its own scope, and §3 proves a scope-a caller still
 * cannot reach it. get_chunks stays page-/slug-keyed (artefacts have no page
 * slug), and its federated grant is now honored (T4 threads sourceScopeOpts).
 * The pre-T4 "retrieval-wiring TRIPWIRE" (which asserted artefacts were
 * unreachable) has been converted — NOT deleted — into §4's positive +
 * cross-scope coverage.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const op = (name: string) => {
  const found = operations.find(o => o.name === name);
  if (!found) throw new Error(`operation not found: ${name}`);
  return found;
};
const query = op('query');
const search = op('search');
const get_page = op('get_page');
const get_chunks = op('get_chunks');
const traverse_graph = op('traverse_graph');
const get_backlinks = op('get_backlinks');
const get_links = op('get_links');
const list_pages = op('list_pages');

// Distinct, cleanly-tokenizing FTS terms per corpus so a cross-scope bleed
// through the keyword path is unambiguous (no shared stems).
const A_NOTE = 'quokkanote';
const B_NOTE = 'axolotlnote';
const A_ART = 'narwhalart';
const B_ART = 'pangolinart';
const SHARED = 'importantcontext'; // present in BOTH notes — proves widening span

// ── ctx builders — the four real caller shapes ────────────────────────────
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
function baseCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: { engine: 'pglite' } as any,
    logger: logger as any,
    dryRun: false,
    remote: true,
    sourceId: 'scope-a',
    ...overrides,
  };
}
/** Federated remote OAuth client (the deployed shape): grant via allowedSources, no scalar sourceId. */
function fed(allowedSources: string[]): OperationContext {
  return baseCtx({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources } as any });
}
/** Scalar remote client (legacy bearer / CLI-over-transport): ambient ctx.sourceId, no grant array. */
function scalar(sourceId: string): OperationContext {
  return baseCtx({ remote: true, sourceId, auth: undefined });
}
/** Trusted local caller (CLI, ctx.remote === false): the only identity that may span the whole brain. */
function local(sourceId?: string): OperationContext {
  return baseCtx({ remote: false, sourceId, auth: undefined });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema(); // applies migrations through v123 → `artifacts` table present
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  // Two scopes (distinct source_ids). 'default' is re-seeded by the reset helper.
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('scope-a', 'scope-a', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('scope-b', 'scope-b', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);

  // ── NOTE class: a secret note + a link target in each scope ─────────────
  await engine.putPage('a/secret-note', {
    type: 'note', title: 'Alpha secret', compiled_truth: `${A_NOTE} alpha body ${SHARED}`, timeline: '', frontmatter: {},
  }, { sourceId: 'scope-a' });
  await engine.upsertChunks('a/secret-note', [{
    chunk_index: 0, chunk_text: `${A_NOTE} alpha body ${SHARED}`, chunk_source: 'compiled_truth', token_count: 8,
  }], { sourceId: 'scope-a' });
  await engine.putPage('a/target', {
    type: 'note', title: 'Alpha target', compiled_truth: 'alpha target body', timeline: '', frontmatter: {},
  }, { sourceId: 'scope-a' });

  await engine.putPage('b/secret-note', {
    type: 'note', title: 'Beta secret', compiled_truth: `${B_NOTE} beta body ${SHARED}`, timeline: '', frontmatter: {},
  }, { sourceId: 'scope-b' });
  await engine.upsertChunks('b/secret-note', [{
    chunk_index: 0, chunk_text: `${B_NOTE} beta body ${SHARED}`, chunk_source: 'compiled_truth', token_count: 8,
  }], { sourceId: 'scope-b' });
  await engine.putPage('b/target', {
    type: 'note', title: 'Beta target', compiled_truth: 'beta target body', timeline: '', frontmatter: {},
  }, { sourceId: 'scope-b' });

  // In-scope links (must be visible to their own scope).
  await engine.addLink('a/secret-note', 'a/target', 'in-scope A', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'scope-a', toSourceId: 'scope-a' });
  await engine.addLink('b/secret-note', 'b/target', 'in-scope B', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'scope-b', toSourceId: 'scope-b' });
  // Cross-scope far-endpoint link A→B (must NOT surface to a scope-a caller).
  await engine.addLink('a/secret-note', 'b/target', 'CROSS ctx leak', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'scope-a', toSourceId: 'scope-b' });
  // Cross-scope backlink B→A (referrer in scope-b → a scope-a caller must NOT see it).
  await engine.addLink('b/secret-note', 'a/secret-note', 'CROSS back leak', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'scope-b', toSourceId: 'scope-a' });

  // ── ARTEFACT class (T1 / v123): an artefact row + an artefact-scoped chunk
  //    (page_id = NULL) in each scope. The chunk_search_vector trigger makes
  //    each artefact chunk fully FTS-ready — so its absence from search results
  //    is attributable ONLY to the page-join, never to a missing tsvector. ──
  const [artA] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO artifacts (source_id, kind, title, content)
       VALUES ('scope-a', 'document', 'Alpha artefact', $1) RETURNING id`,
    [`${A_ART} alpha artefact body ${SHARED}`],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (artifact_id, chunk_index, chunk_text, chunk_source)
       VALUES ($1, 0, $2, 'compiled_truth')`,
    [artA!.id, `${A_ART} alpha artefact body ${SHARED}`],
  );
  const [artB] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO artifacts (source_id, kind, title, content)
       VALUES ('scope-b', 'document', 'Beta artefact', $1) RETURNING id`,
    [`${B_ART} beta artefact body ${SHARED}`],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (artifact_id, chunk_index, chunk_text, chunk_source)
       VALUES ($1, 0, $2, 'compiled_truth')`,
    [artB!.id, `${B_ART} beta artefact body ${SHARED}`],
  );
});

// helpers to read results tolerantly (op result shapes vary)
const sourcesOf = (rows: any[]) => new Set(rows.map(r => r.source_id));
const textBlob = (rows: any[]) => JSON.stringify(rows);

// ══════════════════════════════════════════════════════════════════════════
// 1. NOTE class — cross-scope isolation on EVERY read path
//    Primary "scoped to A" identity: a federated OAuth grant [scope-a]
//    (the deployed shape). get_chunks is scalar-only (see its block).
// ══════════════════════════════════════════════════════════════════════════
describe('NOTE class — cross-scope isolation, all read paths (federated grant [scope-a])', () => {
  test('query: A cannot retrieve B\'s note; can retrieve its own', async () => {
    const leaked = (await query.handler(fed(['scope-a']), { query: B_NOTE, expand: false })) as any[];
    expect(leaked.every(r => r.source_id === 'scope-a')).toBe(true);
    expect(textBlob(leaked)).not.toContain(B_NOTE);

    const own = (await query.handler(fed(['scope-a']), { query: A_NOTE, expand: false })) as any[];
    expect(own.length).toBeGreaterThan(0);
    expect([...sourcesOf(own)]).toEqual(['scope-a']);
  });

  test('search: A cannot retrieve B\'s note; can retrieve its own', async () => {
    const leaked = (await search.handler(fed(['scope-a']), { query: B_NOTE })) as any[];
    expect(leaked.every(r => r.source_id === 'scope-a')).toBe(true);
    expect(textBlob(leaked)).not.toContain(B_NOTE);

    const own = (await search.handler(fed(['scope-a']), { query: A_NOTE })) as any[];
    expect(own.length).toBeGreaterThan(0);
    expect([...sourcesOf(own)]).toEqual(['scope-a']);
  });

  test('search: SHARED term returns ONLY scope-a for the grant (no B bleed)', async () => {
    const rows = (await search.handler(fed(['scope-a']), { query: SHARED })) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect([...sourcesOf(rows)]).toEqual(['scope-a']);
  });

  test('get_page: A cannot read B\'s note by slug; can read its own', async () => {
    await expect(get_page.handler(fed(['scope-a']), { slug: 'b/secret-note' })).rejects.toBeInstanceOf(OperationError);
    const own: any = await get_page.handler(fed(['scope-a']), { slug: 'a/secret-note' });
    expect(own.title).toBe('Alpha secret');
  });

  test('traverse_graph: A\'s walk stays in scope-a and never crosses the A→B edge', async () => {
    const nodes = (await traverse_graph.handler(fed(['scope-a']), { slug: 'a/secret-note' })) as any[];
    const slugs = nodes.map(n => n.slug);
    expect(slugs).toContain('a/secret-note');
    expect(slugs).not.toContain('b/target'); // far endpoint of the cross-scope edge
    // Seeding the walk at a B page from a scope-a grant returns nothing.
    const bWalk = (await traverse_graph.handler(fed(['scope-a']), { slug: 'b/secret-note' })) as any[];
    expect(bWalk.length).toBe(0);
  });

  test('get_links: A sees its in-scope link, not the cross-scope far endpoint', async () => {
    const links = (await get_links.handler(fed(['scope-a']), { slug: 'a/secret-note' })) as any[];
    expect(links.map(l => l.to_slug)).toContain('a/target');
    expect(links.map(l => l.to_slug)).not.toContain('b/target');
    expect(textBlob(links)).not.toContain('CROSS ctx leak');
  });

  test('get_backlinks: A does not see the cross-scope B→A referrer', async () => {
    const back = (await get_backlinks.handler(fed(['scope-a']), { slug: 'a/secret-note' })) as any[];
    expect(back.map(l => l.from_slug)).not.toContain('b/secret-note');
    expect(textBlob(back)).not.toContain('CROSS back leak');
  });

  test('list_pages: A enumerates only its own pages', async () => {
    const pages = (await list_pages.handler(fed(['scope-a']), {})) as any[];
    const titles = new Set(pages.map(p => p.title));
    expect(titles.has('Alpha secret')).toBe(true);
    expect(titles.has('Beta secret')).toBe(false);
    expect(titles.has('Beta target')).toBe(false);
  });
});

// ── get_chunks is a source-scoped content-read op. T4 threads the full
//    sourceScopeOpts (federated array > scalar > nothing) so BOTH the scalar
//    transport AND the federated grant are honored — and both fail closed
//    against foreign scopes. ──
describe('NOTE class — get_chunks scope behaviour', () => {
  test('scalar scope-a: reads own chunks, denied B\'s chunks', async () => {
    const own = (await get_chunks.handler(scalar('scope-a'), { slug: 'a/secret-note' })) as any[];
    expect(own.length).toBeGreaterThan(0);
    const cross = (await get_chunks.handler(scalar('scope-a'), { slug: 'b/secret-note' })) as any[];
    expect(cross.length).toBe(0);
  });

  test('federated grant [scope-a]: honors the grant — reads own chunks, denied B\'s chunks', async () => {
    // T4 fix: the handler now threads sourceScopeOpts(ctx), so a federated
    // caller's allowedSources grant is honored (was: fell closed to 'default',
    // returning nothing even for the caller's own pages). Still fails CLOSED
    // against out-of-grant scopes — no scope-b content leaks.
    const cross = (await get_chunks.handler(fed(['scope-a']), { slug: 'b/secret-note' })) as any[];
    expect(cross.length).toBe(0);
    const ownViaFed = (await get_chunks.handler(fed(['scope-a']), { slug: 'a/secret-note' })) as any[];
    expect(ownViaFed.length).toBeGreaterThan(0); // grant honored → own chunks returned
  });

  test('two-source grant [scope-a,scope-b]: reads either scope\'s chunks', async () => {
    const a = (await get_chunks.handler(fed(['scope-a', 'scope-b']), { slug: 'a/secret-note' })) as any[];
    const b = (await get_chunks.handler(fed(['scope-a', 'scope-b']), { slug: 'b/secret-note' })) as any[];
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });
});

// ── Scalar-remote transport (legacy bearer / CLI-over-transport) on the
//    content-bearing ops — the other real "scoped to A" identity. ──
describe('NOTE class — scalar-remote (ctx.sourceId) isolation', () => {
  test('search / query / get_page under scalar scope-a cannot reach B', async () => {
    const s = (await search.handler(scalar('scope-a'), { query: B_NOTE })) as any[];
    expect(s.every(r => r.source_id === 'scope-a')).toBe(true);
    const q = (await query.handler(scalar('scope-a'), { query: B_NOTE, expand: false })) as any[];
    expect(q.every(r => r.source_id === 'scope-a')).toBe(true);
    await expect(get_page.handler(scalar('scope-a'), { slug: 'b/secret-note' })).rejects.toBeInstanceOf(OperationError);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Scope-widening invariants: __all__ and out-of-grant source_id
// ══════════════════════════════════════════════════════════════════════════
describe('scope widening — __all__ narrows to grant for remote, spans all for local', () => {
  test('remote federated [scope-a] + source_id=__all__ widens ONLY to the grant', async () => {
    const rows = (await query.handler(fed(['scope-a']), { query: SHARED, source_id: '__all__', expand: false })) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect([...sourcesOf(rows)]).toEqual(['scope-a']); // NOT scope-b, despite __all__
    expect(textBlob(rows)).not.toContain(B_NOTE);
  });

  test('trusted local + source_id=__all__ spans every source', async () => {
    const rows = (await query.handler(local(undefined), { query: SHARED, source_id: '__all__', expand: false })) as any[];
    const srcs = sourcesOf(rows);
    expect(srcs.has('scope-a')).toBe(true);
    expect(srcs.has('scope-b')).toBe(true);
  });

  test('list_pages: a two-source grant [scope-a,scope-b] widens to the union, no more', async () => {
    const pages = (await list_pages.handler(fed(['scope-a', 'scope-b']), {})) as any[];
    const titles = new Set(pages.map(p => p.title));
    expect(titles.has('Alpha secret')).toBe(true);
    expect(titles.has('Beta secret')).toBe(true);
  });
});

describe('scope widening — out-of-grant source_id is permission_denied', () => {
  test('federated [scope-a] requesting source_id=scope-b → permission_denied', async () => {
    let err: unknown;
    try {
      await query.handler(fed(['scope-a']), { query: SHARED, source_id: 'scope-b', expand: false });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe('permission_denied');
  });

  test('federated [scope-a] requesting an in-grant source_id=scope-a is allowed', async () => {
    const rows = (await query.handler(fed(['scope-a']), { query: A_NOTE, source_id: 'scope-a', expand: false })) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect([...sourcesOf(rows)]).toEqual(['scope-a']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. ARTEFACT class (T1 / v123) — cross-scope isolation on every read path.
//    Confirms the artefact class does NOT bleed across scope through any op.
//    T4 wired artefact chunks INTO the hybrid retrieval path (scoped via
//    artifacts.source_id), so these are now REAL, exercised isolation tests:
//    B's artefact IS retrievable-ready and reachable in-scope (§4), yet a
//    scope-a caller must never see it here. (Pre-T4 this held vacuously because
//    artefact content was unreachable by any read op at all.)
// ══════════════════════════════════════════════════════════════════════════
describe('ARTEFACT class — no cross-scope bleed through any read path', () => {
  test('search / query: A never surfaces B\'s artefact content', async () => {
    for (const caller of [fed(['scope-a']), scalar('scope-a')]) {
      const s = (await search.handler(caller, { query: B_ART })) as any[];
      expect(s.every(r => r.source_id === 'scope-a')).toBe(true);
      expect(textBlob(s)).not.toContain(B_ART);
      const q = (await query.handler(caller, { query: B_ART, expand: false })) as any[];
      expect(q.every(r => r.source_id === 'scope-a')).toBe(true);
      expect(textBlob(q)).not.toContain(B_ART);
    }
  });

  test('search under an __all__ / all-sources remote grant [scope-a] still yields no B artefact', async () => {
    const rows = (await query.handler(fed(['scope-a']), { query: B_ART, source_id: '__all__', expand: false })) as any[];
    expect(textBlob(rows)).not.toContain(B_ART);
  });

  test('artefacts are not addressable via page-/slug-/graph-keyed ops (no artefact slug exists)', async () => {
    // list_pages enumerates `pages` only — artefacts (a separate table) never appear.
    const pages = (await list_pages.handler(fed(['scope-a', 'scope-b']), {})) as any[];
    expect(pages.find(p => p.title === 'Alpha artefact')).toBeUndefined();
    expect(pages.find(p => p.title === 'Beta artefact')).toBeUndefined();
    // The artefact object_id / title is not a page slug, so get_page / get_chunks
    // cannot name it: a local caller (widest possible) still 404s / returns nothing.
    await expect(get_page.handler(local('scope-b'), { slug: 'Beta artefact' })).rejects.toBeInstanceOf(OperationError);
    expect(((await get_chunks.handler(local('scope-b'), { slug: 'Beta artefact' })) as any[]).length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. ARTEFACT retrieval (T4) — in-scope retrievable + content-class-tagged,
//    cross-scope isolated. This block REPLACES the pre-T4 "retrieval-wiring
//    TRIPWIRE": artefact chunks are now surfaced by search/query through the
//    unified hybrid path (LEFT JOIN artifacts, scoped via artifacts.source_id),
//    so the "inherits the same enforcement via source_id" property is now
//    genuinely EXERCISED — positive in-scope retrieval below, cross-scope
//    isolation in §3. Turning the tripwire GREEN by isolating, not deleting.
// ══════════════════════════════════════════════════════════════════════════
describe('ARTEFACT retrieval (T4) — surfaced in-scope, tagged, isolated', () => {
  test('the artefact chunk IS fully FTS-indexed (retrieval-ready at the SQL layer)', async () => {
    const [row] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks
        WHERE artifact_id IS NOT NULL
          AND search_vector @@ websearch_to_tsquery('english', $1)`,
      [A_ART],
    );
    expect(row!.n).toBeGreaterThan(0);
  });

  test('OWNER\'s search/query NOW surfaces its own artefact, tagged content_class=artifact', async () => {
    for (const caller of [scalar('scope-a'), fed(['scope-a'])]) {
      const s = (await search.handler(caller, { query: A_ART })) as any[];
      expect(s.length).toBeGreaterThan(0);
      expect(textBlob(s)).toContain(A_ART);
      const artHits = s.filter(r => r.content_class === 'artifact');
      expect(artHits.length).toBeGreaterThan(0);
      // Every artefact hit is scope-a's, carries its artifact_id + synthetic slug.
      expect(artHits.every(r => r.source_id === 'scope-a')).toBe(true);
      expect(artHits.every(r => typeof r.artifact_id === 'number')).toBe(true);
      expect(artHits.every(r => typeof r.slug === 'string' && r.slug.startsWith('artifact:'))).toBe(true);

      const q = (await query.handler(caller, { query: A_ART, expand: false })) as any[];
      expect(q.length).toBeGreaterThan(0);
      expect(q.some(r => r.content_class === 'artifact')).toBe(true);
    }
  });

  test('cross-scope: A\'s search for B\'s artefact term returns nothing (real, exercised isolation)', async () => {
    for (const caller of [scalar('scope-a'), fed(['scope-a'])]) {
      const s = (await search.handler(caller, { query: B_ART })) as any[];
      expect(s.some(r => r.content_class === 'artifact' && r.source_id !== 'scope-a')).toBe(false);
      expect(textBlob(s)).not.toContain(B_ART);
    }
  });

  test('unified space: a query matching BOTH classes returns notes AND artefacts, each tagged', async () => {
    // SHARED appears in scope-a's note body AND its artefact body. One ranked
    // query returns both classes, scoped to the caller, each tagged.
    const rows = (await search.handler(fed(['scope-a']), { query: SHARED })) as any[];
    expect(rows.every(r => r.source_id === 'scope-a')).toBe(true);
    const classes = new Set(rows.map(r => r.content_class));
    expect(classes.has('note')).toBe(true);
    expect(classes.has('artifact')).toBe(true);
    // No scope-b content in the unified list.
    expect(textBlob(rows)).not.toContain(B_ART);
    expect(textBlob(rows)).not.toContain(B_NOTE);
  });
});
