/**
 * Migration v130 + doctor: the request role's grants on `takes` and the
 * page-generation clock sequence.
 *
 * Remote query paths run as `gbrain_request`. v125–v127 never granted `takes`
 * (and v35's auto-RLS left it policy-less), and v126 granted the clock
 * sequence SELECT but not USAGE — so takes_* tools and anything calling
 * currval/nextval failed with "permission denied" for every scoped caller.
 *
 * Real-Postgres only (roles/policies). Set GBRAIN_DATABASE_URL or DATABASE_URL
 * to a scratch superuser Postgres with pgvector:
 *   DATABASE_URL=postgres://… bun test test/rls-takes-clock-grants.test.ts
 * The PGLite no-op contract is covered at the bottom and always runs.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { checkRlsEnforcement, missingRequestRoleGrants } from '../src/commands/doctor.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const describePg = DATABASE_URL ? describe : describe.skip;

const SRC_A = 'ks-takes-src-a';
const SRC_B = 'ks-takes-src-b';
const v130 = MIGRATIONS.find((m) => m.version === 130)!;

describePg('v130: gbrain_request grants on takes + clock sequence (real Postgres)', () => {
  let engine: PostgresEngine;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    sql = postgres(DATABASE_URL!, { prepare: false });

    await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`;
    await sql`INSERT INTO sources (id, name) VALUES (${SRC_A}, 'A'), (${SRC_B}, 'B')`;
    await sql`INSERT INTO pages (source_id, slug, type, title) VALUES
                (${SRC_A}, 'takes-a', 'note', 'A'), (${SRC_B}, 'takes-b', 'note', 'B')`;
    const rows = await sql<{ id: number; source_id: string }[]>`
      SELECT id, source_id FROM pages WHERE source_id = ANY(${[SRC_A, SRC_B]})`;
    for (const r of rows) {
      await sql`INSERT INTO takes (page_id, row_num, claim, kind, holder)
                VALUES (${r.id}, 1, ${`claim from ${r.source_id}`}, 'take', 'tester')`;
    }
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM sources WHERE id = ANY(${[SRC_A, SRC_B]})`;
      await sql.end();
    }
    if (engine) await engine.disconnect();
  });

  async function underRole<T>(allowed: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE gbrain_request`;
      await tx`SELECT set_config('app.allowed_sources', ${allowed}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  test('request role reads only the takes of pages it can see', async () => {
    const claims = await underRole(`{${SRC_A}}`, (tx) =>
      tx<{ claim: string }[]>`SELECT claim FROM takes WHERE claim LIKE 'claim from ks-takes-%'`);
    expect(claims.map((c) => c.claim)).toEqual([`claim from ${SRC_A}`]);
  });

  test('request role can use the generation clock sequence', async () => {
    const out = await underRole(`{${SRC_A}}`, async (tx) => {
      const [n] = await tx<{ v: string }[]>`SELECT nextval('page_generation_clock_seq')::text AS v`;
      const [c] = await tx<{ v: string }[]>`SELECT currval('page_generation_clock_seq')::text AS v`;
      return { n: n.v, c: c.v };
    });
    expect(out.c).toBe(out.n);
  });

  test('doctor reports a revoked grant, and re-running v130 heals it', async () => {
    expect(await missingRequestRoleGrants(engine)).toEqual([]);
    expect((await checkRlsEnforcement(engine)).status).toBe('ok');

    await sql`REVOKE SELECT ON takes FROM gbrain_request`;
    await sql`REVOKE USAGE ON SEQUENCE page_generation_clock_seq FROM gbrain_request`;
    expect(await v130.verify!(engine as any)).toBe(false);
    const gaps = await missingRequestRoleGrants(engine);
    expect(gaps).toContain('SELECT on takes');
    expect(gaps).toContain('USAGE on page_generation_clock_seq');
    const check = await checkRlsEnforcement(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/SELECT on takes/);

    await v130.handler!(engine as any);
    expect(await v130.verify!(engine as any)).toBe(true);
    expect(await missingRequestRoleGrants(engine)).toEqual([]);
  });
});

describe('v130 on PGLite is a no-op that verifies', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 30_000);
  afterAll(async () => { await engine.disconnect(); });

  test('verify passes and doctor stays ok', async () => {
    expect(await v130.verify!(engine as any)).toBe(true);
    expect((await checkRlsEnforcement(engine)).status).toBe('ok');
  });
});
