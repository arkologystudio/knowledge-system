/**
 * Migration v123 — raw-artefact class + chunk/page decoupling (F6, Knowledge
 * System T1).
 *
 * Validates that the `artifacts` table, the relaxed `content_chunks.page_id`,
 * the new `artifact_id` FK, and the page-XOR-artefact CHECK all land on PGLite
 * (Postgres 17.5 in WASM, so this also confirms the DDL is portable), that the
 * migration is idempotent, and — the N2 guard — that the autopilot 72h
 * soft-delete purge removes soft-deleted pages + their chunks but can never
 * reach artefacts or artefact-scoped chunks.
 *
 * Postgres-only concerns (RLS enablement under BYPASSRLS) live in the Postgres
 * bootstrap E2E / engine-parity suite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

describe('migration v123 — raw-artefact class + chunk/page decoupling', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema(); // applies all migrations through LATEST_VERSION (incl. v123)
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('artifacts table exists with T9 + facts-mirror columns', async () => {
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'artifacts'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const c of [
      'id', 'object_id', 'source_id', 'kind', 'title', 'uri', 'revision_id',
      'content', 'content_hash', 'provenance', 'visibility', 'valid_from',
      'valid_until', 'created_at', 'updated_at',
    ]) {
      expect(names).toContain(c);
    }
  });

  test('content_chunks.page_id is nullable and artifact_id column exists', async () => {
    const rows = await engine.executeRaw<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'content_chunks'
          AND column_name IN ('page_id', 'artifact_id')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(byName['page_id']).toBe('YES');
    expect(byName['artifact_id']).toBe('YES');
  });

  test('object_id defaults to a generated UUID', async () => {
    const [a] = await engine.executeRaw<{ object_id: string }>(
      `INSERT INTO artifacts (source_id, kind, title)
         VALUES ('default', 'document', 'uuid probe') RETURNING object_id`,
    );
    expect(a.object_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('an artefact-scoped chunk (page_id NULL) is accepted', async () => {
    const [a] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO artifacts (kind) VALUES ('document') RETURNING id`,
    );
    const [c] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO content_chunks (artifact_id, chunk_index, chunk_text)
         VALUES (${a.id}, 0, 'artefact chunk') RETURNING id`,
    );
    expect(c.id).toBeGreaterThan(0);
  });

  test('XOR: a chunk referencing BOTH a page and an artefact is rejected', async () => {
    const [p] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, type, title) VALUES ('xor-both', 'note', 'XOR both') RETURNING id`,
    );
    const [a] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO artifacts (kind) VALUES ('document') RETURNING id`,
    );
    await expect(
      engine.executeRaw(
        `INSERT INTO content_chunks (page_id, artifact_id, chunk_index, chunk_text)
           VALUES (${p.id}, ${a.id}, 0, 'both')`,
      ),
    ).rejects.toThrow();
  });

  test('XOR: a chunk referencing NEITHER a page nor an artefact is rejected', async () => {
    await expect(
      engine.executeRaw(
        `INSERT INTO content_chunks (chunk_index, chunk_text) VALUES (0, 'neither')`,
      ),
    ).rejects.toThrow();
  });

  test('deleting an artefact cascades to its chunks', async () => {
    const [a] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO artifacts (kind) VALUES ('document') RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (artifact_id, chunk_index, chunk_text) VALUES (${a.id}, 0, 'c')`,
    );
    await engine.executeRaw(`DELETE FROM artifacts WHERE id = ${a.id}`);
    const rem = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE artifact_id = ${a.id}`,
    );
    expect(rem[0]!.n).toBe(0);
  });

  test('N2 guard: purgeDeletedPages removes soft-deleted pages + their chunks but never artefacts', async () => {
    // A soft-deleted page (100h > the 72h TTL) with a chunk.
    const [p] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, type, title, deleted_at)
         VALUES ('n2-purge', 'note', 'N2', now() - interval '100 hours') RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES (${p.id}, 0, 'doomed')`,
    );
    // An artefact with a chunk — must survive the page purge untouched.
    const [a] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO artifacts (kind, title) VALUES ('document', 'survivor') RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (artifact_id, chunk_index, chunk_text) VALUES (${a.id}, 0, 'survivor chunk')`,
    );

    const res = await engine.purgeDeletedPages(72);
    expect(res.slugs).toContain('n2-purge');

    const pageGone = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE id = ${p.id}`,
    );
    expect(pageGone[0]!.n).toBe(0);
    const pageChunkGone = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE page_id = ${p.id}`,
    );
    expect(pageChunkGone[0]!.n).toBe(0);

    const artefactAlive = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifacts WHERE id = ${a.id}`,
    );
    expect(artefactAlive[0]!.n).toBe(1);
    const artefactChunkAlive = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE artifact_id = ${a.id}`,
    );
    expect(artefactChunkAlive[0]!.n).toBe(1);
  });

  test('re-running migrations after initSchema is idempotent (0 applied)', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
  }, 30000);
});
