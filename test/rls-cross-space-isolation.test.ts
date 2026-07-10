/**
 * KS-C — in-DB row-level-security cross-space isolation proof (the security
 * crux of the task). Runs against REAL Postgres only; SKIPS on PGLite-only runs
 * (PGLite has no roles/policies/SET LOCAL). Set GBRAIN_DATABASE_URL or
 * DATABASE_URL to a scratch Postgres (superuser / CREATEROLE) to exercise it:
 *
 *   GBRAIN_DATABASE_URL=postgres://… bun test test/rls-cross-space-isolation.test.ts
 *
 * What it proves (acceptance criteria 1-3 + the GUC-leak edge case):
 *   1. DB-level isolation (app-independent): under the NOBYPASSRLS
 *      `gbrain_request` role with `app.allowed_sources = {A}`, RAW selects — the
 *      app-layer source filter deliberately bypassed — return space-A rows and
 *      ZERO space-B rows on the covered tables (pages, content_chunks).
 *   2. Fail-closed: zero-grant (GUC `{}`) → 0 rows; unset GUC → 0 rows. Never the
 *      scalar `default`.
 *   3. Bypass sanity: the SAME selects as the plain app (BYPASSRLS) role — no
 *      role-drop — DO return space-B rows, proving the role-drop is the only
 *      thing gating access.
 *   +  GUC does not leak across a reused pooled backend (SET LOCAL is
 *      transaction-scoped), and the production `engine.withRlsScope` helper
 *      enforces the same isolation end-to-end.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const describeRls = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping KS-C RLS cross-space isolation tests (DATABASE_URL not set)');
}

const SRC_A = 'ks-rls-src-a';
const SRC_B = 'ks-rls-src-b';
const CHUNK_A = 'alpha chunk ks-rls-fixture';
const CHUNK_B = 'bravo chunk ks-rls-fixture';

describeRls('KS-C in-DB RLS cross-space isolation (real Postgres)', () => {
  let engine: PostgresEngine;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema(); // runs migrations incl. v125 → provisions role + policies

    sql = postgres(DATABASE_URL!, { prepare: false });

    // Clean slate for our two fixture sources (cascades pages/chunks), then seed.
    await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`;
    await sql`INSERT INTO sources (id, name) VALUES (${SRC_A}, 'KS-RLS A'), (${SRC_B}, 'KS-RLS B') ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO pages (source_id, slug, type, title) VALUES
        (${SRC_A}, 'ks-rls-a-page', 'note', 'A'),
        (${SRC_B}, 'ks-rls-b-page', 'note', 'B')
      ON CONFLICT (source_id, slug) DO NOTHING`;
    const pageRows = await sql<{ id: number; source_id: string }[]>`
      SELECT id, source_id FROM pages
       WHERE source_id = ANY(${[SRC_A, SRC_B]}) AND slug = ANY(${['ks-rls-a-page', 'ks-rls-b-page']})`;
    const idA = pageRows.find((r) => r.source_id === SRC_A)!.id;
    const idB = pageRows.find((r) => r.source_id === SRC_B)!.id;
    await sql`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES
        (${idA}, 0, ${CHUNK_A}),
        (${idB}, 0, ${CHUNK_B})`;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`; // cascades pages + chunks
      await sql.end();
    }
    if (engine) await engine.disconnect();
  });

  // Run `fn` on a raw connection dropped to gbrain_request with the given GUC.
  // `allowed = undefined` leaves the GUC unset (the fail-closed unset case).
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

  test('provisioning succeeded: role gbrain_request exists', async () => {
    // If this fails, the DATABASE_URL role lacks CREATEROLE — run the documented
    // one-time bootstrap SQL as a superuser (KS-C decision E). RLS is not "on"
    // until this passes.
    const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_request'`;
    expect(rows.length).toBe(1);
  });

  test('all 11 covered-table policies are present', async () => {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'ks_source_isolation'
         AND tablename = ANY(${[
           'pages', 'content_chunks', 'artifacts', 'links', 'timeline_entries',
           'tags', 'raw_data', 'page_versions', 'facts', 'files', 'ingest_log',
         ]})`;
    expect(rows[0].n).toBe(11);
  });

  test('scoped to A: pages — asking for B returns 0 rows, A returns the row', async () => {
    await underRole(`{${SRC_A}}`, async (tx) => {
      const b = await tx`SELECT source_id FROM pages WHERE source_id = ${SRC_B}`;
      expect(b.length).toBe(0); // DB backstop denies B even though we asked for it
      const a = await tx`SELECT source_id FROM pages WHERE source_id = ${SRC_A}`;
      expect(a.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('scoped to A: content_chunks — only the A chunk is visible (parent-page policy)', async () => {
    await underRole(`{${SRC_A}}`, async (tx) => {
      const rows = await tx<{ chunk_text: string }[]>`
        SELECT chunk_text FROM content_chunks WHERE chunk_text = ANY(${[CHUNK_A, CHUNK_B]})`;
      const texts = rows.map((r) => r.chunk_text);
      expect(texts).toContain(CHUNK_A);
      expect(texts).not.toContain(CHUNK_B);
    });
  });

  test('fail-closed: zero-grant GUC {} → 0 rows on both covered tables', async () => {
    await underRole('{}', async (tx) => {
      const pages = await tx`SELECT 1 FROM pages WHERE source_id = ANY(${[SRC_A, SRC_B]})`;
      expect(pages.length).toBe(0);
      const chunks = await tx`SELECT 1 FROM content_chunks WHERE chunk_text = ANY(${[CHUNK_A, CHUNK_B]})`;
      expect(chunks.length).toBe(0);
    });
  });

  test('fail-closed: unset GUC → 0 rows (never falls through to default)', async () => {
    await underRole(undefined, async (tx) => {
      const pages = await tx`SELECT 1 FROM pages WHERE source_id = ANY(${[SRC_A, SRC_B]})`;
      expect(pages.length).toBe(0);
    });
  });

  test('bypass sanity: the plain app (BYPASSRLS) role DOES see B — the role-drop is the only gate', async () => {
    const b = await sql`SELECT source_id FROM pages WHERE source_id = ${SRC_B}`;
    expect(b.length).toBeGreaterThanOrEqual(1);
  });

  test('GUC does not leak across a reused pooled backend (SET LOCAL is txn-scoped)', async () => {
    await underRole(`{${SRC_A}}`, async (tx) => {
      await tx`SELECT 1 FROM pages`; // exercise the scope
    });
    // Same pool, outside any transaction: no residual role, and the GUC does
    // NOT carry the prior request's scope. (Postgres reverts a once-SET custom
    // GUC to '' rather than fully unsetting it; '' is fail-closed via the
    // policy's NULLIF(...,'') — the point is it is empty, not `{A}`.)
    const rows = await sql<{ v: string | null; who: string }[]>`
      SELECT current_setting('app.allowed_sources', true) AS v, current_user AS who`;
    expect(rows[0].v ?? '').toBe(''); // null or '' — never the leaked {A}
    expect(rows[0].v ?? '').not.toContain(SRC_A);
    expect(rows[0].who).not.toBe('gbrain_request');
  });

  test('engine.withRlsScope enforces the same isolation end-to-end', async () => {
    // The exact helper the MCP dispatcher wraps remote reads in.
    const denied = await engine.withRlsScope([SRC_A], (e) =>
      e.executeRaw<{ source_id: string }>(`SELECT source_id FROM pages WHERE source_id = $1`, [SRC_B]),
    );
    expect(denied.length).toBe(0);

    const allowed = await engine.withRlsScope([SRC_A], (e) =>
      e.executeRaw<{ source_id: string }>(`SELECT source_id FROM pages WHERE source_id = $1`, [SRC_A]),
    );
    expect(allowed.length).toBeGreaterThanOrEqual(1);

    // Zero-grant via the helper → 0 rows (fail-closed), never default.
    const zero = await engine.withRlsScope([], (e) =>
      e.executeRaw(`SELECT 1 FROM pages WHERE source_id = ANY($1::text[])`, [[SRC_A, SRC_B]]),
    );
    expect(zero.length).toBe(0);

    // No residual scope on the pool after the helper returns (empty, not {A}).
    const resid = await engine.executeRaw<{ v: string | null }>(
      `SELECT current_setting('app.allowed_sources', true) AS v`,
    );
    expect(resid[0].v ?? '').toBe('');
    expect(resid[0].v ?? '').not.toContain(SRC_A);
  });
});
