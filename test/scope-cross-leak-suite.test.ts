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
 * ── ARTEFACT-CLASS FINDING (read before extending) ────────────────────────
 * The artefact class inherits scope enforcement STRUCTURALLY, not by an
 * artefact-specific filter: every chunk-content read path
 * (search/query → searchKeyword/hybridSearch) is `... FROM content_chunks cc
 * JOIN pages p ON p.id = cc.page_id ...` and scopes via `p.source_id`. Artefact
 * chunks have `page_id = NULL`, so the INNER JOIN drops them BEFORE any source
 * filter runs. And no read op addresses an artefact directly — get_page /
 * get_chunks / get_links / get_backlinks / traverse_graph / list_pages are all
 * page-/slug-/graph-keyed, and artefacts have no slug and are absent from
 * `pages` and `links`.
 *
 * Net: artefacts CANNOT leak across scope today — because artefact content is
 * not reachable through ANY current read op at all. Isolation therefore holds,
 * but VACUOUSLY: the "inherits the same enforcement via source_id" property is
 * not yet exercised for artefacts. That property goes live only when a future
 * task wires artefact chunks into retrieval (surfacing `page_id IS NULL` chunks
 * scoped via `artifacts.source_id` — a LEFT JOIN / UNION on the artefact side).
 * THAT wiring is the real future leak surface. The `retrieval-wiring TRIPWIRE`
 * block below fails loudly the day artefact chunks start surfacing, forcing the
 * next author to add positive + cross-scope isolation coverage on the artefact
 * source path. This is the precise gap reported to the conductor for separate
 * scoping — NOT a leak in shipped code.
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

// ── get_chunks is a scalar-source op (handler uses ctx.sourceId only). Cover
//    both the scalar transport (enforced) and the federated grant (fails
//    closed to 'default' — a functionality gap, documented, NOT a leak). ──
describe('NOTE class — get_chunks scope behaviour', () => {
  test('scalar scope-a: reads own chunks, denied B\'s chunks', async () => {
    const own = (await get_chunks.handler(scalar('scope-a'), { slug: 'a/secret-note' })) as any[];
    expect(own.length).toBeGreaterThan(0);
    const cross = (await get_chunks.handler(scalar('scope-a'), { slug: 'b/secret-note' })) as any[];
    expect(cross.length).toBe(0);
  });

  test('federated grant [scope-a]: fails closed (defaults to \'default\'), never returns scope-b chunks', async () => {
    // The handler threads only scalar ctx.sourceId; a federated caller has none,
    // so the engine defaults to 'default'. This does NOT honor the grant for the
    // caller's own pages (a functionality gap flagged for the conductor), but it
    // fails CLOSED — no scope-b content leaks.
    const cross = (await get_chunks.handler(fed(['scope-a']), { slug: 'b/secret-note' })) as any[];
    expect(cross.length).toBe(0);
    const ownViaFed = (await get_chunks.handler(fed(['scope-a']), { slug: 'a/secret-note' })) as any[];
    expect(ownViaFed.length).toBe(0); // grant not honored here → own chunks not returned either (fail-closed)
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
//    (See the header FINDING: isolation currently holds because artefact
//    content is unreachable by any read op, not because a per-op artefact
//    filter runs.)
// ══════════════════════════════════════════════════════════════════════════
describe('ARTEFACT class — no cross-scope bleed through any read path', () => {
  test('search / query: A never surfaces B\'s artefact content', async () => {
    for (const caller of [fed(['scope-a']), scalar('scope-a')]) {
      const s = (await search.handler(caller, { query: B_ART })) as any[];
      expect(textBlob(s)).not.toContain(B_ART);
      const q = (await query.handler(caller, { query: B_ART, expand: false })) as any[];
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
// 4. ARTEFACT retrieval-wiring TRIPWIRE (current-state confirm).
//    Documents WHY §3's isolation currently holds: artefact chunks are not
//    surfaced by ANY retrieval path (search/query INNER JOIN `pages`, and
//    artefact chunks carry page_id = NULL). These assertions PASS today and
//    MUST FAIL the day artefact retrieval is wired — at which point the author
//    of that change replaces this block with positive + cross-scope isolation
//    coverage over the artefact source path (scoped via artifacts.source_id).
// ══════════════════════════════════════════════════════════════════════════
describe('ARTEFACT retrieval-wiring TRIPWIRE — artefact chunks not yet surfaced by retrieval', () => {
  test('the artefact chunk IS fully FTS-indexed (so exclusion is the page-join, not a missing tsvector)', async () => {
    const [row] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks
        WHERE artifact_id IS NOT NULL
          AND search_vector @@ websearch_to_tsquery('english', $1)`,
      [A_ART],
    );
    expect(row!.n).toBeGreaterThan(0); // artefact chunk is retrievable-ready at the SQL layer
  });

  test('yet the OWNER\'s own search/query returns NOTHING for its artefact term (retrieval not wired)', async () => {
    // If EITHER of these starts returning results, artefact retrieval has landed:
    //   → convert this block into scoped-artefact isolation tests (see header FINDING).
    const ownerSearch = (await search.handler(scalar('scope-a'), { query: A_ART })) as any[];
    expect(ownerSearch.length).toBe(0);
    const ownerQuery = (await query.handler(scalar('scope-a'), { query: A_ART, expand: false })) as any[];
    expect(ownerQuery.length).toBe(0);
  });
});
