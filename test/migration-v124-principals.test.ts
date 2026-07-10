/**
 * Migration v124 — principals + per-source grants + access_tokens principal
 * columns (Knowledge System KS-A).
 *
 * Validates the two new identity tables, the three additive access_tokens
 * columns, the kind/role CHECK constraints, the UNIQUE keys, and the FK
 * cascades all land on PGLite (Postgres 17.5 in WASM, so this also confirms the
 * DDL is portable), and that the migration is idempotent.
 *
 * Postgres-only concerns (RLS enablement under BYPASSRLS) live in the Postgres
 * bootstrap E2E / engine-parity suite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

describe('migration v124 — principals + source grants', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema(); // applies all migrations through LATEST_VERSION (incl. v124)
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('principals table exists with the expected columns', async () => {
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'principals'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const c of ['id', 'kind', 'subject', 'display_name', 'created_at']) {
      expect(names).toContain(c);
    }
  });

  test('principal_source_grants exists with the reserved visibility_ceiling slot', async () => {
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'principal_source_grants'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const c of ['id', 'principal_id', 'source_id', 'role', 'visibility_ceiling', 'created_at']) {
      expect(names).toContain(c);
    }
  });

  test('access_tokens gains principal_id, allowed_sources, expires_at', async () => {
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'access_tokens'
          AND column_name IN ('principal_id','allowed_sources','expires_at')`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(['allowed_sources', 'expires_at', 'principal_id']);
  });

  test('kind CHECK rejects an invalid principal kind', async () => {
    await expect(
      engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('robot', 'x@y.z')`),
    ).rejects.toThrow();
  });

  test('role CHECK rejects an invalid grant role', async () => {
    await engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('human', 'role-check@y.z')`);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('rc-src', 'Role Check Source') ON CONFLICT DO NOTHING`);
    const [p] = await engine.executeRaw<{ id: number }>(`SELECT id FROM principals WHERE subject = 'role-check@y.z'`);
    await expect(
      engine.executeRaw(
        `INSERT INTO principal_source_grants (principal_id, source_id, role) VALUES ($1, 'rc-src', 'superuser')`,
        [Number(p.id)],
      ),
    ).rejects.toThrow();
  });

  test('UNIQUE(kind, subject) is enforced', async () => {
    await engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('agent', 'dup@y.z')`);
    await expect(
      engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('agent', 'dup@y.z')`),
    ).rejects.toThrow();
    // Same subject, different kind is allowed.
    await expect(
      engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('service', 'dup@y.z')`),
    ).resolves.toBeDefined();
  });

  test('FK cascade: deleting a principal drops its grants', async () => {
    await engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('human', 'cascade@y.z')`);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('cascade-src', 'Cascade Source') ON CONFLICT DO NOTHING`);
    const [p] = await engine.executeRaw<{ id: number }>(`SELECT id FROM principals WHERE subject = 'cascade@y.z'`);
    await engine.executeRaw(
      `INSERT INTO principal_source_grants (principal_id, source_id, role) VALUES ($1, 'cascade-src', 'read')`,
      [Number(p.id)],
    );
    await engine.executeRaw(`DELETE FROM principals WHERE id = $1`, [Number(p.id)]);
    const grants = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM principal_source_grants WHERE principal_id = $1`,
      [Number(p.id)],
    );
    expect(grants[0].n).toBe(0);
  });

  test('FK cascade: deleting a source drops grants that referenced it', async () => {
    await engine.executeRaw(`INSERT INTO principals (kind, subject) VALUES ('human', 'srcdrop@y.z')`);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('drop-src', 'Drop Source') ON CONFLICT DO NOTHING`);
    const [p] = await engine.executeRaw<{ id: number }>(`SELECT id FROM principals WHERE subject = 'srcdrop@y.z'`);
    await engine.executeRaw(
      `INSERT INTO principal_source_grants (principal_id, source_id, role) VALUES ($1, 'drop-src', 'write')`,
      [Number(p.id)],
    );
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'drop-src'`);
    const grants = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM principal_source_grants WHERE source_id = 'drop-src'`,
    );
    expect(grants[0].n).toBe(0);
  });

  test('migration is idempotent — a second run applies nothing', async () => {
    const result = await runMigrations(engine);
    expect(result.applied).toBe(0);
  });
});
