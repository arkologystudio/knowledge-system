/**
 * GOV-2 e2e — governance-minted token cross-scope isolation + revocation.
 *
 * Proves the FULL seam end-to-end: a governance-minted opaque token is verified
 * by introspection (RFC 7662, HTTP mocked), the resulting AuthInfo's
 * `allowedSources` comes from the introspection response (NOT a local DB row),
 * and a principal granted space A CANNOT reach space B — at BOTH enforcement
 * layers:
 *   - the app ladder (`sourceScopeOpts` → engine filter), driven through the
 *     real `dispatchToolCall` path; and
 *   - KS-C in-DB RLS (the `gbrain_request` NOBYPASSRLS role + `app.allowed_sources`
 *     GUC derived from the same AuthInfo), asserted with the app filter
 *     deliberately bypassed so only the DB layer can be denying.
 * Then revocation: once governance flips the token to `active:false`, the very
 * next `verifyAccessToken` DENIES (default cache TTL=0 → instant revocation).
 *
 * Runs against REAL Postgres only; SKIPS on PGLite-only runs (RLS needs
 * roles/policies/SET LOCAL). Provide a scratch superuser/CREATEROLE Postgres
 * (NEVER a shared/live brain) via GBRAIN_DATABASE_URL or DATABASE_URL:
 *
 *   GBRAIN_DATABASE_URL=postgres://…/scratch bun test test/e2e/governance-cross-scope-isolation.test.ts
 *
 * Stubs globalThis.fetch (the introspection transport). Bun runs each e2e file
 * in its own process, so the global stub is contained.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/operations.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const describeGov = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping GOV-2 cross-scope isolation e2e (DATABASE_URL not set)');
}

const SRC_A = 'gov2-src-a';
const SRC_B = 'gov2-src-b';
const CHUNK_A = 'alpha chunk gov2-fixture';
const CHUNK_B = 'bravo chunk gov2-fixture';
const GOV_TOKEN = 'hab_at_' + 'a'.repeat(64);
const INTROSPECT_URL = 'https://governance.internal/v1/introspect';

// Byte-identical shared contract fixture (same file the unit suite pins).
const contract = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'governance-introspection.contract.json')).toString('utf8'),
);

const realFetch = globalThis.fetch;
const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

function body(result: { content: { text: string }[]; isError?: boolean }): any {
  return JSON.parse(result.content[0].text);
}

describeGov('GOV-2 governance token cross-scope isolation + revocation (real Postgres)', () => {
  let engine: PostgresEngine;
  let sql: ReturnType<typeof postgres>;
  let provider: GBrainOAuthProvider;

  // Governance-side token state the mocked /introspect reflects. Flipping
  // `active` to false models a revocation at the authority.
  let govActive = true;

  function installIntrospectStub() {
    globalThis.fetch = (async () => {
      if (!govActive) {
        return { ok: true, status: 200, json: async () => ({ active: false }) } as any;
      }
      // Active: allowed_sources scoped to space A ONLY. Live expiry (the
      // fixture's literal epoch is an example value, per its $comment).
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...contract.response_active,
          allowed_sources: [SRC_A],
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as any;
    }) as unknown as typeof globalThis.fetch;
  }

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema(); // migrations incl. v125 → gbrain_request role + policies

    sql = postgres(DATABASE_URL!, { prepare: false });

    await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`; // cascades pages/chunks
    await sql`INSERT INTO sources (id, name) VALUES (${SRC_A}, 'GOV2 A'), (${SRC_B}, 'GOV2 B') ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO pages (source_id, slug, type, title) VALUES
        (${SRC_A}, 'gov2-a-page', 'note', 'A'),
        (${SRC_B}, 'gov2-b-page', 'note', 'B')
      ON CONFLICT (source_id, slug) DO NOTHING`;
    const rows = await sql<{ id: number; source_id: string }[]>`
      SELECT id, source_id FROM pages WHERE slug = ANY(${['gov2-a-page', 'gov2-b-page']})`;
    const idA = rows.find((r) => r.source_id === SRC_A)!.id;
    const idB = rows.find((r) => r.source_id === SRC_B)!.id;
    await sql`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES
        (${idA}, 0, ${CHUNK_A}),
        (${idB}, 0, ${CHUNK_B})`;

    provider = new GBrainOAuthProvider({
      sql: sqlQueryForEngine(engine),
      governanceIntrospectUrl: INTROSPECT_URL,
      governanceClientId: 'knowledge-system',
      governanceClientSecret: 'test-secret',
      // default cache TTL = 0 → instant revocation
    });

    govActive = true;
    installIntrospectStub();
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (sql) {
      await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`;
      await sql.end();
    }
    if (engine) await engine.disconnect();
  });

  test('provisioning succeeded: gbrain_request role exists (else DB URL lacks CREATEROLE)', async () => {
    const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_request'`;
    expect(rows.length).toBe(1);
  });

  test('governance token → verifyAccessToken introspects → allowedSources=[A]', async () => {
    govActive = true;
    const auth = (await provider.verifyAccessToken(GOV_TOKEN)) as unknown as AuthInfo;
    expect(auth.allowedSources).toEqual([SRC_A]);
    // The scope came from introspection, not a DB row — sourceId stays unset so
    // sourceScopeOpts prefers the federated array.
    expect(auth.sourceId).toBeUndefined();
    expect(auth.clientId).toBe(contract.response_active.token_id);
  });

  test('app ladder: introspected A-token reads A, is DENIED on B (through dispatch)', async () => {
    govActive = true;
    const auth = (await provider.verifyAccessToken(GOV_TOKEN)) as unknown as AuthInfo;

    const a = await dispatchToolCall(engine, 'get_page', { slug: 'gov2-a-page' }, {
      remote: true, sourceId: undefined, auth, logger: quietLogger,
    });
    expect(a.isError).toBeFalsy();
    expect(body(a).slug).toBe('gov2-a-page');

    const aChunks = await dispatchToolCall(engine, 'get_chunks', { slug: 'gov2-a-page' }, {
      remote: true, sourceId: undefined, auth, logger: quietLogger,
    });
    expect(aChunks.isError).toBeFalsy();
    expect(JSON.stringify(body(aChunks))).toContain(CHUNK_A);

    // Space B under an A-only introspected grant → denied (no row leaks).
    const b = await dispatchToolCall(engine, 'get_page', { slug: 'gov2-b-page' }, {
      remote: true, sourceId: undefined, auth, logger: quietLogger,
    });
    expect(b.isError).toBe(true);
    expect(body(b).error).toBe('page_not_found');

    const bChunks = await dispatchToolCall(engine, 'get_chunks', { slug: 'gov2-b-page' }, {
      remote: true, sourceId: undefined, auth, logger: quietLogger,
    });
    // No B chunk ever surfaces under the A grant.
    expect(JSON.stringify(body(bChunks))).not.toContain(CHUNK_B);
  });

  test('KS-C RLS: GUC from the introspected grant denies B even with the app filter bypassed', async () => {
    govActive = true;
    const auth = (await provider.verifyAccessToken(GOV_TOKEN)) as unknown as AuthInfo;
    const guc = `{${(auth.allowedSources ?? []).join(',')}}`; // Postgres array literal

    // Drop to the NOBYPASSRLS role, set the GUC from the introspected grant,
    // and run RAW selects (app-layer source filter deliberately absent). Only
    // the DB RLS policy can be gating here.
    const { aRows, bRows } = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE gbrain_request`;
      await tx`SELECT set_config('app.allowed_sources', ${guc}, true)`;
      const aRows = await tx`SELECT id FROM pages WHERE source_id = ${SRC_A}`;
      const bRows = await tx`SELECT id FROM pages WHERE source_id = ${SRC_B}`;
      return { aRows, bRows };
    });
    expect(aRows.length).toBeGreaterThan(0); // A visible
    expect(bRows.length).toBe(0);            // B invisible at the DB layer
  });

  test('revocation: once governance returns active:false, the next verify DENIES (TTL=0, instant)', async () => {
    govActive = true;
    // Sanity: live token verifies.
    const live = (await provider.verifyAccessToken(GOV_TOKEN)) as unknown as AuthInfo;
    expect(live.allowedSources).toEqual([SRC_A]);

    // Revoke at the authority.
    govActive = false;
    await expect(provider.verifyAccessToken(GOV_TOKEN)).rejects.toThrow();
  });
});
