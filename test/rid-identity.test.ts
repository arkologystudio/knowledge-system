/**
 * v128 — Reference Identifier persistence: migration shape, mint-once,
 * survival across rename / move / source reassignment, and resolution.
 *
 * These are the acceptance criteria that only a real schema can prove. The
 * pure-function side (grammar, RFC 8785, manifest, locators) lives in
 * `test/rid-grammar.test.ts`.
 *
 * PGLite here is Postgres in WASM, so a DDL shape that works here is portable;
 * the Postgres-only concerns (RLS, role grants) are covered by the bootstrap
 * E2E + engine-parity suites.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { tryParseRid, validateRid } from '../src/core/rid.ts';

// NOTE: no GBRAIN_PGLITE_SNAPSHOT opt-out here (isolation rule R1 forbids
// mutating process.env in a non-serial file). The assertions hold either way:
// a snapshot-loaded engine still carries the v128 column and index, and the
// backfill / re-run tests drive the migration SQL explicitly via runMigration
// rather than relying on the chain having replayed.

const PAGE = {
  type: 'note' as const,
  title: 'A note',
  compiled_truth: 'body',
  timeline: '',
};

describe('migration v128 — pages_reference_identifier', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('v128 is declared idempotent with a verify hook, per the migration contract', () => {
    const m = MIGRATIONS.find((x) => x.version === 128);
    expect(m).toBeDefined();
    expect(m!.name).toBe('pages_reference_identifier');
    // Forward-only codebase: `idempotent` must be declared EXPLICITLY so the
    // runner's verify-failure path knows it may safely re-run the DDL.
    expect(m!.idempotent).toBe(true);
    expect(typeof m!.verify).toBe('function');
  });

  test('rid column exists and is NOT NULL', async () => {
    const rows = await engine.executeRaw<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pages' AND column_name = 'rid'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
  });

  test('the unique index is GLOBAL, not scoped by source_id', async () => {
    // Identity does not carry a source — a page that moves between sources
    // keeps its RID — so scoping this index the way (source_id, slug) is scoped
    // would permit two pages to share one identifier.
    const rows = await engine.executeRaw<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'pages' AND indexname = 'idx_pages_rid'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(rows[0].indexdef).not.toMatch(/source_id/);
  });

  test("the migration's own verify hook passes against the migrated schema", async () => {
    const m = MIGRATIONS.find((x) => x.version === 128)!;
    expect(await m.verify!(engine as never)).toBe(true);
  });

  test('every page gets a well-formed identifier from the column default', async () => {
    const page = await engine.putPage('rid/minted', PAGE);
    expect(page.rid).toBeDefined();
    expect(validateRid(page.rid!)).toBe(page.rid!);
    const parsed = tryParseRid(page.rid);
    expect(parsed).not.toBeNull();
    expect(parsed!.namespace).toBe('habitat.page');
    expect(parsed!.reference.length).toBeGreaterThan(0);
  });

  test('identifiers are distinct per page — the default generates per row', async () => {
    // Concurrent ingest safety rests on this: the value is produced inside the
    // insert, so no application-level coordination is needed.
    const a = await engine.putPage('rid/distinct-a', PAGE);
    const b = await engine.putPage('rid/distinct-b', PAGE);
    expect(a.rid).not.toBe(b.rid);
  });

  test('a pre-existing corpus is backfilled, not left with NULL identity', async () => {
    // Simulate a pre-v128 row by stripping the column's contents behind the
    // NOT NULL, then re-running the migration's DDL as the upgrade path would.
    await engine.executeRaw(`ALTER TABLE pages ALTER COLUMN rid DROP NOT NULL`);
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, rid)
                             VALUES ('default', 'rid/legacy', 'note', 'Legacy', 'body', '', NULL)`);
    const m = MIGRATIONS.find((x) => x.version === 128)!;
    // runMigration, not executeRaw: the migration is multi-statement and
    // executeRaw goes through a prepared statement, which Postgres refuses.
    await engine.runMigration(128, m.sql as string);

    const rows = await engine.executeRaw<{ rid: string }>(
      `SELECT rid FROM pages WHERE slug = 'rid/legacy'`,
    );
    expect(rows[0].rid).toBeDefined();
    expect(tryParseRid(rows[0].rid)).not.toBeNull();

    const nulls = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE rid IS NULL`,
    );
    expect(nulls[0].n).toBe(0);
  });

  test('re-running the migration is a no-op that does not re-mint identifiers', async () => {
    // Idempotence here means more than "does not error": a second run must not
    // change any identifier, or "minted once and never reissued" is false.
    const before = await engine.executeRaw<{ slug: string; rid: string }>(
      `SELECT slug, rid FROM pages ORDER BY slug`,
    );
    const m = MIGRATIONS.find((x) => x.version === 128)!;
    await engine.runMigration(128, m.sql as string);
    const after = await engine.executeRaw<{ slug: string; rid: string }>(
      `SELECT slug, rid FROM pages ORDER BY slug`,
    );
    expect(after).toEqual(before);
  });
});

describe('mint-once — an identifier is never reissued or overwritten', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('re-importing the same page preserves its identifier', async () => {
    const first = await engine.putPage('rid/stable', PAGE);
    const second = await engine.putPage('rid/stable', { ...PAGE, compiled_truth: 'edited body' });
    expect(second.rid).toBe(first.rid);
  });

  test('a caller supplying a DIFFERENT rid cannot overwrite the stored one', async () => {
    // COALESCE(pages.rid, EXCLUDED.rid) — argument order is the INVERSE of the
    // provenance preserve-group. For provenance the stored value wins only when
    // the caller omits; for identity the stored value wins ALWAYS.
    const first = await engine.putPage('rid/no-overwrite', PAGE);
    const second = await engine.putPage('rid/no-overwrite', {
      ...PAGE,
      rid: 'orn:habitat.page:11111111-2222-3333-4444-555555555555',
    });
    expect(second.rid).toBe(first.rid);
  });

  test('a caller-supplied rid IS honoured on first insert (externally-keyed identity)', async () => {
    // This is what lets a mirrored page key on the upstream system's own id, so
    // a full re-ingest reproduces the identifier.
    const rid = 'orn:google_drive.file:1AbC_dEfGhIjKlMnOpQr';
    const page = await engine.putPage('rid/mirrored', { ...PAGE, rid });
    expect(page.rid).toBe(rid);
  });

  test('a full re-ingest from source reproduces identical identifiers', async () => {
    // ACCEPTANCE CRITERION: "wiping the index and re-ingesting from source
    // reproduces identical identifiers."
    const rid = 'orn:google_drive.file:reingest-fixture-id';
    const before = await engine.putPage('rid/reingest', { ...PAGE, rid });
    await engine.deletePage('rid/reingest');
    const after = await engine.putPage('rid/reingest', { ...PAGE, rid });
    expect(after.rid).toBe(before.rid);
  });

  test('two pages cannot share one identifier', async () => {
    const rid = 'orn:google_drive.file:collision-fixture';
    await engine.putPage('rid/collide-a', { ...PAGE, rid });
    await expect(engine.putPage('rid/collide-b', { ...PAGE, rid })).rejects.toThrow();
  });

  test('a malformed rid is rejected at the engine chokepoint', async () => {
    await expect(
      engine.putPage('rid/bad', { ...PAGE, rid: 'not a rid' }),
    ).rejects.toThrow(/Invalid rid/);
  });
});

describe('permanence — the identifier survives what breaks a slug', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('renaming a page leaves its identifier unchanged', async () => {
    // ACCEPTANCE CRITERION. This is the whole point: a rename used to read as a
    // delete plus a create, taking every inbound reference with it.
    const before = await engine.putPage('rid/original-name', PAGE);
    await engine.updateSlug('rid/original-name', 'rid/renamed', { sourceId: 'default' });
    const after = await engine.getPage('rid/renamed');
    expect(after).not.toBeNull();
    expect(after!.rid).toBe(before.rid);
  });

  test('moving a page between directories leaves its identifier unchanged', async () => {
    // ACCEPTANCE CRITERION. A "move" is a slug whose path prefix changed — the
    // same operation a rename is, which is exactly why path-derived identity
    // could never survive it.
    const before = await engine.putPage('notes/rid-moving', PAGE);
    await engine.updateSlug('notes/rid-moving', 'archive/2026/rid-moving', { sourceId: 'default' });
    const after = await engine.getPage('archive/2026/rid-moving');
    expect(after!.rid).toBe(before.rid);
  });

  test('reassigning a page to a different source leaves its identifier unchanged', async () => {
    // ACCEPTANCE CRITERION. source_id is mutable and routing-assigned, which is
    // precisely why it is NOT part of identity.
    const before = await engine.putPage('rid/respaced', PAGE);
    await engine.executeRaw(
      `UPDATE pages SET source_id = 'other' WHERE slug = 'rid/respaced' AND source_id = 'default'`,
    );
    const after = await engine.getPage('rid/respaced', { sourceId: 'other' });
    expect(after).not.toBeNull();
    expect(after!.source_id).toBe('other');
    expect(after!.rid).toBe(before.rid);
  });
});

describe('resolution — identifier to page, with source scope', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('an identifier resolves to its page', async () => {
    const page = await engine.putPage('rid/resolvable', PAGE);
    const found = await engine.getPageByRid(page.rid!);
    expect(found).not.toBeNull();
    expect(found!.slug).toBe('rid/resolvable');
  });

  test('resolution still works after the page is renamed', async () => {
    // The citation-survives-rename property, at the engine layer.
    const page = await engine.putPage('rid/cite-me', PAGE);
    await engine.updateSlug('rid/cite-me', 'rid/cite-me-renamed', { sourceId: 'default' });
    const found = await engine.getPageByRid(page.rid!);
    expect(found!.slug).toBe('rid/cite-me-renamed');
  });

  test('resolution is SOURCE-SCOPED — no cross-source read by identifier', async () => {
    // Identity is global, so an unscoped lookup would be a cross-source read of
    // any page by identifier. This is the isolation gap `resolve_slugs` still
    // has; `getPageByRid` must not repeat it.
    const page = await engine.putPage('rid/scoped', PAGE, { sourceId: 'src-b' });
    expect(await engine.getPageByRid(page.rid!, { sourceId: 'src-b' })).not.toBeNull();
    expect(await engine.getPageByRid(page.rid!, { sourceId: 'default' })).toBeNull();
  });

  test('a federated grant scopes resolution to the granted sources', async () => {
    const page = await engine.putPage('rid/federated', PAGE, { sourceId: 'src-b' });
    expect(await engine.getPageByRid(page.rid!, { sourceIds: ['src-b'] })).not.toBeNull();
    expect(await engine.getPageByRid(page.rid!, { sourceIds: ['default'] })).toBeNull();
  });

  test('a soft-deleted page is hidden by default but still HOLDS its identity', async () => {
    const page = await engine.putPage('rid/tombstoned', PAGE);
    await engine.softDeletePage('rid/tombstoned', { sourceId: 'default' });
    expect(await engine.getPageByRid(page.rid!)).toBeNull();
    const withDeleted = await engine.getPageByRid(page.rid!, { includeDeleted: true });
    expect(withDeleted).not.toBeNull();
    expect(withDeleted!.slug).toBe('rid/tombstoned');
  });

  test('an unknown identifier resolves to null, not an error', async () => {
    expect(await engine.getPageByRid('orn:habitat.page:00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  test('getRidsByPageIds batches the citation lookup', async () => {
    const a = await engine.putPage('rid/batch-a', PAGE);
    const b = await engine.putPage('rid/batch-b', PAGE);
    const map = await engine.getRidsByPageIds([a.id, b.id]);
    expect(map.get(a.id)).toBe(a.rid);
    expect(map.get(b.id)).toBe(b.rid);
  });

  test('getRidsByPageIds short-circuits on empty input (no query)', async () => {
    expect((await engine.getRidsByPageIds([])).size).toBe(0);
  });
});
