/**
 * Migrations v125-v126 — source RLS policies, request role, and search support
 * (Knowledge System KS-C, in-DB row-level security).
 *
 * This suite runs on PGLite (Postgres 17.5 in WASM), where the whole v125
 * handler is a documented NO-OP: PGLite has no roles / RLS policies / SET LOCAL,
 * so those deployments keep app-layer source isolation exclusively. It asserts
 * the no-op contract (no role, no policy created), that the migration still
 * completes + bumps to LATEST_VERSION, and that a second run is idempotent.
 *
 * The real Postgres behaviour — role provisioning, per-space policies, and the
 * cross-space DENIAL proof — lives in test/rls-cross-space-isolation.test.ts,
 * which is DATABASE_URL-gated and SKIPS on PGLite-only runs.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations, LATEST_VERSION } from '../src/core/migrate.ts';

describe('migrations v125-v126 — source RLS policies (PGLite no-op contract)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema(); // applies all migrations through LATEST_VERSION (incl. v125)
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('v126 is the latest migration version', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(126);
  });

  test('schema version reached >= 126 after initSchema', async () => {
    const v = await engine.getConfig('version');
    expect(parseInt(v || '0', 10)).toBeGreaterThanOrEqual(126);
  });

  test('PGLite no-op: no gbrain_request role is created', async () => {
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'gbrain_request'`,
    );
    expect(rows[0]?.n ?? 0).toBe(0);
  });

  test('PGLite no-op: no ks_source_isolation policy is created', async () => {
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'ks_source_isolation'`,
    );
    expect(rows[0]?.n ?? 0).toBe(0);
  });

  test('migration is idempotent — a second run applies nothing', async () => {
    const result = await runMigrations(engine);
    expect(result.applied).toBe(0);
  });

  test('withRlsScope on PGLite is a pass-through (runs fn on the same engine)', async () => {
    // The GUC set inside a Postgres scope is meaningless on PGLite; the helper
    // must simply run fn against the working engine so reads still function.
    const out = await engine.withRlsScope(['whatever'], async (e) => {
      const rows = await e.executeRaw<{ ok: number }>(`SELECT 1 AS ok`);
      return rows[0]?.ok;
    });
    expect(out).toBe(1);
  });
});
