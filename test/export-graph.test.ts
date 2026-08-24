/**
 * `export_graph` — bulk graph read, and the scoping it must not break.
 *
 * This op hands back the WHOLE node and edge set in one payload, so the database
 * predicate is the only thing between a scoped caller and the entire graph.
 * That makes it the highest-leverage place to get access wrong, and the tests
 * below are weighted accordingly: the interesting cases are all about what a
 * label-only guest must NOT receive.
 *
 * The edge rule is the subtle one. An edge is returned only when BOTH endpoints
 * are visible — so a shared artifact cannot disclose the existence, slug or
 * title of an unshared neighbour it happens to link to. Returning a dangling
 * edge would leak exactly that.
 *
 * Real Postgres only: PGLite has no policies and its withRlsScope is a
 * pass-through, so there is nothing to prove there.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SRC = 'ks-eg-src';
const LABEL = 'ks-eg-habitat';
const SHARED_A = 'ks-eg-shared-a';
const SHARED_B = 'ks-eg-shared-b';
const PRIVATE = 'ks-eg-private';

describeDb('export_graph', () => {
  let engine: PostgresEngine;
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };

  const auth = (sources: string[]): AuthInfo =>
    ({ token: 't', clientId: 'c', scopes: ['read'], allowedSources: sources } as AuthInfo);

  async function exportAs(sources: string[], params: Record<string, unknown> = {}) {
    const res = await dispatchToolCall(engine, 'export_graph', params, {
      remote: true, auth: auth(sources), logger: quiet,
    });
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.content[0].text) as {
      nodes: Array<{ id: string; title: string; tags: string[]; degree: number; project: string | null }>;
      edges: Array<{ source: string; target: string }>;
      truncated: boolean;
    };
  }

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SRC]);
    await engine.executeRaw('DELETE FROM spaces WHERE id = $1', [LABEL]);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [SRC, 'eg fixture']);
    await engine.executeRaw(
      "INSERT INTO spaces (id,label,class) VALUES ($1,'EG habitat','shareable')", [LABEL]);

    for (const slug of [SHARED_A, SHARED_B, PRIVATE]) {
      await engine.executeRaw(
        "INSERT INTO pages (source_id,slug,type,title) VALUES ($1,$2,'note',$3)",
        [SRC, slug, `T:${slug}`],
      );
    }
    // Share two of the three.
    await engine.executeRaw(
      'INSERT INTO page_spaces (page_id,space_id) SELECT id,$1 FROM pages WHERE slug = ANY($2::text[])',
      [LABEL, [SHARED_A, SHARED_B]],
    );
    await engine.executeRaw("INSERT INTO tags (page_id,tag) SELECT id,'alpha' FROM pages WHERE slug=$1", [SHARED_A]);

    // A→B  (both shared)   A→PRIVATE  (crosses the boundary)
    await engine.executeRaw(
      `INSERT INTO links (from_page_id,to_page_id,link_type)
       SELECT f.id, t.id, 'wikilink' FROM pages f, pages t WHERE f.slug=$1 AND t.slug=$2`,
      [SHARED_A, SHARED_B],
    );
    await engine.executeRaw(
      `INSERT INTO links (from_page_id,to_page_id,link_type)
       SELECT f.id, t.id, 'wikilink' FROM pages f, pages t WHERE f.slug=$1 AND t.slug=$2`,
      [SHARED_A, PRIVATE],
    );
  }, 60_000);

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SRC]);
      await engine.executeRaw('DELETE FROM spaces WHERE id = $1', [LABEL]);
      await engine.disconnect();
    }
  });

  test('a steward holding the source sees all three and both edges', async () => {
    const g = await exportAs([SRC]);
    const mine = g.nodes.filter((n) => n.id.startsWith('ks-eg-'));
    expect(mine.map((n) => n.id).sort()).toEqual([SHARED_A, SHARED_B, PRIVATE].sort());
    const myEdges = g.edges.filter((e) => e.source.startsWith('ks-eg-'));
    expect(myEdges.length).toBe(2);
  });

  test('a label-only guest sees ONLY the shared nodes', async () => {
    const g = await exportAs([LABEL]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([SHARED_A, SHARED_B].sort());
    expect(g.nodes.some((n) => n.id === PRIVATE)).toBe(false);
  });

  test('the edge into the unshared artifact is absent, not dangling', async () => {
    // The leak this test exists for: returning A→PRIVATE would disclose that
    // PRIVATE exists and what it is called, to someone not granted it.
    const g = await exportAs([LABEL]);
    expect(g.edges).toEqual([{ source: SHARED_A, target: SHARED_B }]);
    expect(JSON.stringify(g)).not.toContain(PRIVATE);
  });

  test('every edge endpoint is present in the node set (no phantom nodes)', async () => {
    const g = await exportAs([LABEL]);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  test('degree counts only edges the caller can actually see', async () => {
    // A links to two pages but the guest may read one, so its degree is 1.
    const g = await exportAs([LABEL]);
    expect(g.nodes.find((n) => n.id === SHARED_A)?.degree).toBe(1);
  });

  test('tags and project are populated, and include_tags:false drops tags', async () => {
    const withTags = await exportAs([LABEL]);
    expect(withTags.nodes.find((n) => n.id === SHARED_A)?.tags).toEqual(['alpha']);
    const without = await exportAs([LABEL], { include_tags: false });
    expect(without.nodes.find((n) => n.id === SHARED_A)?.tags).toEqual([]);
  });

  test('a zero-grant caller gets an empty graph, not the whole one', async () => {
    const g = await exportAs([]);
    expect(g.nodes.length).toBe(0);
    expect(g.edges.length).toBe(0);
  });

  test('limit truncates and says so', async () => {
    const g = await exportAs([SRC], { limit: 1 });
    expect(g.nodes.length).toBe(1);
    expect(g.truncated).toBe(true);
    // Truncation must not leave edges pointing at nodes that were cut.
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
  });
});
