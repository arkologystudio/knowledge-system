/**
 * KS-C — end-to-end RLS proof driven through the ACTUAL MCP dispatch path
 * (`dispatchToolCall`), not `withRlsScope` in isolation. This closes the gap
 * the security review flagged: the prior cross-space test only called the
 * helper directly with an explicit non-empty scope, so it could not have caught
 * the two CRITICAL wiring bugs (deferred-op deny, stdio deny-all) or the
 * fail-closed empty-scope case as they actually flow through the dispatcher.
 *
 * Runs against REAL Postgres only; SKIPS on PGLite-only runs. Provide a scratch
 * superuser/CREATEROLE Postgres (NEVER a shared brain) via GBRAIN_DATABASE_URL
 * or DATABASE_URL:
 *
 *   GBRAIN_DATABASE_URL=postgres://… bun test test/rls-dispatch-path.test.ts
 *
 * What it proves, per the review's required cases:
 *   (a) stdio-style ctx (remote:true, auth from buildStdioAuth('default')) →
 *       an allowlisted corpus read returns 'default' rows, NOT deny-all.
 *   (a′) scalar-only remote principal (NO auth.allowedSources, ctx.sourceId set)
 *       → still reads its source. This is the CRITICAL-1 regression: deriving
 *       the GUC from raw ctx.auth.allowedSources would yield [] → deny-all;
 *       routing through sourceScopeOpts yields [sourceId].
 *   (b) a federated principal scoped to space A → space-B rows denied, space-A
 *       rows returned (end-to-end through the dispatcher).
 *   (c) a remote DEFERRED read op (takes_list) → still returns rows, does NOT
 *       'permission denied' (CRITICAL-2: only the corpus allowlist is wrapped).
 *       code_def is checked too as a second deferred op.
 *   (d) zero/empty resolved scope → 0 rows, never the scalar 'default' —
 *       asserted through an allowlisted op where the APP filter is wide-open
 *       ({}), so only the DB RLS layer can be doing the denying.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { dispatchToolCall, buildStdioAuth } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const describeRls = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping KS-C RLS dispatch-path tests (DATABASE_URL not set)');
}

const SRC_A = 'ks-disp-src-a';
const SRC_B = 'ks-disp-src-b';
const CHUNK_DEFAULT = 'default chunk ks-disp-fixture';
const CHUNK_A = 'alpha chunk ks-disp-fixture';
const CHUNK_B = 'bravo chunk ks-disp-fixture';

// A quiet logger so best-effort warnings (e.g. the fire-and-forget
// last_retrieved_at write-back failing under the read-only role) don't spam
// the test output. Behavior under test is unaffected.
const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Parse the JSON body a ToolResult always carries in content[0].text. */
function body(result: { content: { text: string }[]; isError?: boolean }): any {
  return JSON.parse(result.content[0].text);
}

/** A federated principal scoped to exactly `sources` (array-wins-over-scalar). */
function federatedAuth(sources: string[]): AuthInfo {
  return {
    token: '',
    clientId: 'ks-disp-test',
    clientName: 'ks-disp-test',
    scopes: ['read'],
    sourceId: sources[0],
    allowedSources: sources,
  };
}

describeRls('KS-C RLS through dispatchToolCall (real Postgres)', () => {
  let engine: PostgresEngine;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema(); // runs migrations incl. v125 → provisions role + policies

    sql = postgres(DATABASE_URL!, { prepare: false });

    // Ensure the 'default' source exists (fresh scratch DBs may not have it).
    await sql`INSERT INTO sources (id, name) VALUES ('default', 'Default') ON CONFLICT (id) DO NOTHING`;
    await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`; // cascades pages/chunks/takes
    await sql`INSERT INTO sources (id, name) VALUES (${SRC_A}, 'KS-Disp A'), (${SRC_B}, 'KS-Disp B') ON CONFLICT (id) DO NOTHING`;

    await sql`
      INSERT INTO pages (source_id, slug, type, title) VALUES
        ('default', 'ks-disp-default-page', 'note', 'D'),
        (${SRC_A}, 'ks-disp-a-page', 'note', 'A'),
        (${SRC_B}, 'ks-disp-b-page', 'note', 'B')
      ON CONFLICT (source_id, slug) DO NOTHING`;

    const rows = await sql<{ id: number; source_id: string }[]>`
      SELECT id, source_id FROM pages
       WHERE slug = ANY(${['ks-disp-default-page', 'ks-disp-a-page', 'ks-disp-b-page']})`;
    const idD = rows.find((r) => r.source_id === 'default')!.id;
    const idA = rows.find((r) => r.source_id === SRC_A)!.id;
    const idB = rows.find((r) => r.source_id === SRC_B)!.id;

    await sql`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES
        (${idD}, 0, ${CHUNK_DEFAULT}),
        (${idA}, 0, ${CHUNK_A}),
        (${idB}, 0, ${CHUNK_B})`;

    // A take on the A page — the deferred-op fixture (takes is NOT granted to
    // gbrain_request and has RLS-on/no-policy, so a wrongly-wrapped takes_list
    // would `permission denied` / return 0 rows).
    await sql`
      INSERT INTO takes (page_id, row_num, claim, kind, holder, weight)
      VALUES (${idA}, 0, 'ks-disp take fixture', 'take', 'world', 0.5)
      ON CONFLICT (page_id, row_num) DO NOTHING`;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM pages WHERE slug = 'ks-disp-default-page'`; // cascades its chunk
      await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`; // cascades A/B pages+chunks+takes
      await sql.end();
    }
    if (engine) await engine.disconnect();
  });

  test('provisioning succeeded: role gbrain_request exists (else the DB URL lacks CREATEROLE)', async () => {
    const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_request'`;
    expect(rows.length).toBe(1);
  });

  // (a) stdio ctx must NOT deny-all — the corpus read returns its 'default' row.
  test('(a) stdio principal (buildStdioAuth default) reads default corpus — not deny-all', async () => {
    const res = await dispatchToolCall(engine, 'get_page', { slug: 'ks-disp-default-page' }, {
      remote: true,
      sourceId: 'default',
      auth: buildStdioAuth('default'),
      logger: quietLogger,
    });
    expect(res.isError).toBeFalsy();
    expect(body(res).slug).toBe('ks-disp-default-page');

    // And the content_chunks-reading allowlisted op works under the role too.
    const chunks = await dispatchToolCall(engine, 'get_chunks', { slug: 'ks-disp-default-page' }, {
      remote: true, sourceId: 'default', auth: buildStdioAuth('default'), logger: quietLogger,
    });
    expect(chunks.isError).toBeFalsy();
    expect(JSON.stringify(body(chunks))).toContain(CHUNK_DEFAULT);
  });

  // (a′) CRITICAL-1 regression: a scalar-only remote principal (no
  // auth.allowedSources) must still read its source. Raw ctx.auth.allowedSources
  // would be [] → deny-all; sourceScopeOpts derives [ctx.sourceId].
  test('(a′) scalar-only remote principal (no allowedSources) still reads its source', async () => {
    const res = await dispatchToolCall(engine, 'get_page', { slug: 'ks-disp-default-page' }, {
      remote: true,
      sourceId: 'default', // ctx.sourceId set, ctx.auth undefined
      logger: quietLogger,
    });
    expect(res.isError).toBeFalsy();
    expect(body(res).slug).toBe('ks-disp-default-page');
  });

  // (b) Federated A-scope: A returned, B denied — end-to-end through dispatch.
  test('(b) federated principal scoped to A: A returned, B denied', async () => {
    const authA = federatedAuth([SRC_A]);

    const a = await dispatchToolCall(engine, 'get_page', { slug: 'ks-disp-a-page' }, {
      remote: true, sourceId: SRC_A, auth: authA, logger: quietLogger,
    });
    expect(a.isError).toBeFalsy();
    expect(body(a).slug).toBe('ks-disp-a-page');

    const aChunks = await dispatchToolCall(engine, 'get_chunks', { slug: 'ks-disp-a-page' }, {
      remote: true, sourceId: SRC_A, auth: authA, logger: quietLogger,
    });
    expect(aChunks.isError).toBeFalsy();
    expect(JSON.stringify(body(aChunks))).toContain(CHUNK_A);

    // Asking for a space-B page under an A-only grant → denied (no row).
    const b = await dispatchToolCall(engine, 'get_page', { slug: 'ks-disp-b-page' }, {
      remote: true, sourceId: SRC_A, auth: authA, logger: quietLogger,
    });
    expect(b.isError).toBe(true);
    expect(body(b).error).toBe('page_not_found');
  });

  // (c) CRITICAL-2: a remote DEFERRED read op still works (runs unwrapped on the
  // normal BYPASSRLS path; takes is not granted to gbrain_request).
  test('(c) remote deferred op takes_list returns rows — NOT permission denied', async () => {
    const authA = federatedAuth([SRC_A]);
    const res = await dispatchToolCall(engine, 'takes_list', {}, {
      remote: true, sourceId: SRC_A, auth: authA, logger: quietLogger,
    });
    expect(res.isError).toBeFalsy();
    const rows = body(res);
    expect(Array.isArray(rows)).toBe(true);
    expect(JSON.stringify(rows)).toContain('ks-disp take fixture');
    // Explicitly assert we did NOT hit the role's deny.
    expect(JSON.stringify(rows).toLowerCase()).not.toContain('permission denied');
  });

  test('(c′) remote deferred op code_def does not permission-deny under the role', async () => {
    const res = await dispatchToolCall(engine, 'code_def', { symbol: 'ks_disp_nonexistent_symbol' }, {
      remote: true, sourceId: SRC_A, auth: federatedAuth([SRC_A]), logger: quietLogger,
    });
    // No code data seeded → an empty/ready-status result, but crucially NOT a
    // permission_denied error (which is what a wrongly-wrapped code op throws).
    const text = JSON.stringify(body(res)).toLowerCase();
    expect(text).not.toContain('permission denied');
  });

  // (d) Fail-closed: an empty resolved scope → 0 rows, never 'default'. The APP
  // filter here is {} (wide open — would return every source), so only the DB
  // RLS layer (GUC '{}') can be doing the denying.
  test('(d) empty resolved scope → 0 rows, never falls through to default', async () => {
    const emptyAuth: AuthInfo = {
      token: '', clientId: 'ks-disp-empty', scopes: ['read'], allowedSources: [],
    };
    const res = await dispatchToolCall(engine, 'get_page', { slug: 'ks-disp-default-page' }, {
      remote: true,
      sourceId: '', // empty scalar + empty allowedSources → sourceScopeOpts {} → []
      auth: emptyAuth,
      logger: quietLogger,
    });
    expect(res.isError).toBe(true);
    expect(body(res).error).toBe('page_not_found');

    // get_chunks under the same empty scope must also see nothing.
    const chunks = await dispatchToolCall(engine, 'get_chunks', { slug: 'ks-disp-default-page' }, {
      remote: true, sourceId: '', auth: emptyAuth, logger: quietLogger,
    });
    expect(chunks.isError).toBeFalsy(); // returns an (empty) list, not an error
    expect(JSON.stringify(body(chunks))).not.toContain(CHUNK_DEFAULT);
  });
});
