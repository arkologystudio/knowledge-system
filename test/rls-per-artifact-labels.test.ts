/**
 * v129 — per-artifact access labels.
 *
 * The KS-C proof (test/rls-cross-space-isolation.test.ts) shows two SOURCES
 * cannot see each other. That is a coarser claim than the one v129 makes, and
 * it would still pass if labels did nothing: with one label per source, "scoped
 * to source A" and "scoped to label A" are the same query.
 *
 * What this file pins is the claim v125 could not express — TWO ARTIFACTS IN
 * THE SAME SOURCE, adjacent on disk and linked to each other, resolve
 * differently for the same caller because they carry different labels.
 *
 * Fixture (all three pages live in ONE source):
 *
 *   shared-page   labels {src, habitat}   a funder may read it
 *   private-page  labels {src}            a funder may not
 *   shared-page ──link──> private-page    the edge must vanish for the funder
 *
 * Runs against REAL Postgres only; PGLite has no roles/policies/SET LOCAL and
 * its withRlsScope is a pass-through no-op, so there is nothing to prove there:
 *
 *   GBRAIN_DATABASE_URL=postgres://… bun test test/rls-per-artifact-labels.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const describeLabels = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping v129 per-artifact label tests (DATABASE_URL not set)');
}

const SRC = 'ks-lbl-src';
const SPACE_SHARED = 'ks-lbl-habitat';
const SHARED_SLUG = 'ks-lbl-shared-page';
const PRIVATE_SLUG = 'ks-lbl-private-page';
const CHUNK_SHARED = 'shared chunk ks-lbl-fixture';
const CHUNK_PRIVATE = 'private chunk ks-lbl-fixture';

describeLabels('v129 per-artifact labels (real Postgres)', () => {
  let engine: PostgresEngine;
  let sql: ReturnType<typeof postgres>;
  let sharedId: number;
  let privateId: number;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema(); // runs migrations incl. v129

    sql = postgres(DATABASE_URL!, { prepare: false });

    await sql`DELETE FROM sources WHERE id = ${SRC}`; // cascades pages/chunks/links/page_spaces
    await sql`DELETE FROM spaces WHERE id = ${SPACE_SHARED}`;

    await sql`INSERT INTO sources (id, name) VALUES (${SRC}, 'KS labels') ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO spaces (id, label, class)
      VALUES (${SPACE_SHARED}, 'Habitat (fixture)', 'shareable')
      ON CONFLICT (id) DO NOTHING`;

    await sql`
      INSERT INTO pages (source_id, slug, type, title) VALUES
        (${SRC}, ${SHARED_SLUG},  'note', 'Shared'),
        (${SRC}, ${PRIVATE_SLUG}, 'note', 'Private')
      ON CONFLICT (source_id, slug) DO NOTHING`;

    const rows = await sql<{ id: number; slug: string }[]>`
      SELECT id, slug FROM pages WHERE source_id = ${SRC}`;
    sharedId = rows.find((r) => r.slug === SHARED_SLUG)!.id;
    privateId = rows.find((r) => r.slug === PRIVATE_SLUG)!.id;

    // Exactly the act a steward performs: add ONE label to ONE artifact.
    // Neither page moves; both keep the source label the v129 trigger gave them.
    await sql`
      INSERT INTO page_spaces (page_id, space_id) VALUES (${sharedId}, ${SPACE_SHARED})
      ON CONFLICT DO NOTHING`;

    await sql`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES
        (${sharedId},  0, ${CHUNK_SHARED}),
        (${privateId}, 0, ${CHUNK_PRIVATE})`;

    await sql`
      INSERT INTO links (from_page_id, to_page_id, link_type)
      VALUES (${sharedId}, ${privateId}, 'wikilink')`;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM sources WHERE id = ${SRC}`;
      await sql`DELETE FROM spaces WHERE id = ${SPACE_SHARED}`;
      await sql.end();
    }
    if (engine) await engine.disconnect();
  });

  /** Run `fn` under the NOBYPASSRLS role with `allowed` as the clearance set. */
  async function underRole<T>(
    allowed: string | undefined,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE gbrain_request`;
      if (allowed !== undefined) {
        await tx`SELECT set_config('app.allowed_sources', ${allowed}, true)`;
      }
      return fn(tx);
    }) as Promise<T>;
  }

  test('the v129 trigger labels every new page with its source', async () => {
    const rows = await sql<{ space_id: string }[]>`
      SELECT space_id FROM page_spaces WHERE page_id = ${privateId} ORDER BY space_id`;
    // The private page was never classified by hand — the trigger is the only
    // thing that could have labelled it. Without this, a synced page would be
    // invisible to everyone and the corpus would silently empty out.
    expect(rows.map((r) => r.space_id)).toEqual([SRC]);
  });

  test('same source, different labels: the funder sees one page, not the other', async () => {
    const rows = await underRole(`{${SPACE_SHARED}}`, (tx) =>
      tx<{ slug: string }[]>`SELECT slug FROM pages WHERE source_id = ${SRC}`);
    // The claim v125 could not make: both rows share a source_id, so any
    // source-level predicate returns both or neither.
    expect(rows.map((r) => r.slug)).toEqual([SHARED_SLUG]);
  });

  test('the steward, holding the source label, still sees both', async () => {
    const rows = await underRole(`{${SRC}}`, (tx) =>
      tx<{ slug: string }[]>`SELECT slug FROM pages WHERE source_id = ${SRC} ORDER BY slug`);
    expect(rows.map((r) => r.slug).sort()).toEqual([PRIVATE_SLUG, SHARED_SLUG].sort());
  });

  test('chunks inherit the label: no passage leaks from the unlabelled page', async () => {
    const rows = await underRole(`{${SPACE_SHARED}}`, (tx) =>
      tx<{ chunk_text: string }[]>`
        SELECT chunk_text FROM content_chunks WHERE page_id = ANY(${[sharedId, privateId]})`);
    // Semantic search runs over these rows, so a miss here leaks prose, not
    // just a title.
    expect(rows.map((r) => r.chunk_text)).toEqual([CHUNK_SHARED]);
  });

  test('the edge into an unreadable artifact is dropped silently', async () => {
    const rows = await underRole(`{${SPACE_SHARED}}`, (tx) =>
      tx<{ from_page_id: number }[]>`
        SELECT from_page_id FROM links WHERE from_page_id = ${sharedId}`);
    // The near endpoint IS visible to this caller. v125's policy scoped only
    // that end, so the row — and with it the far page's identity — would have
    // survived. Requiring BOTH ends is what makes the drop silent.
    expect(rows.length).toBe(0);
  });

  test('label metadata is itself scoped: no enumerating the other audiences', async () => {
    const rows = await underRole(`{${SPACE_SHARED}}`, (tx) =>
      tx<{ space_id: string }[]>`SELECT space_id FROM page_spaces WHERE page_id = ${sharedId}`);
    // The shared page carries {src, habitat}. A funder holding only habitat
    // must not learn the source label exists, or the org's audience list leaks
    // through the join table.
    expect(rows.map((r) => r.space_id)).toEqual([SPACE_SHARED]);
  });

  test('fail-closed: a zero-grant clearance returns nothing', async () => {
    const empty = await underRole('{}', (tx) =>
      tx<{ slug: string }[]>`SELECT slug FROM pages WHERE source_id = ${SRC}`);
    expect(empty.length).toBe(0);

    const unset = await underRole(undefined, (tx) =>
      tx<{ slug: string }[]>`SELECT slug FROM pages WHERE source_id = ${SRC}`);
    expect(unset.length).toBe(0);
  });

  test('engine.withRlsScope enforces labels end-to-end', async () => {
    const denied = await engine.withRlsScope([SPACE_SHARED], (e) =>
      e.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE slug = $1`, [PRIVATE_SLUG]),
    );
    expect(denied.length).toBe(0);

    const allowed = await engine.withRlsScope([SPACE_SHARED], (e) =>
      e.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE slug = $1`, [SHARED_SLUG]),
    );
    expect(allowed.length).toBe(1);
  });
});
