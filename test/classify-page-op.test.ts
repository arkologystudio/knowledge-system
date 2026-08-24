/**
 * v129 — classify_page / get_page_spaces.
 *
 * `page_spaces` is an artifact's access control list, so these ops are the
 * security surface of the label model. Two layers here:
 *
 *  1. Authority + validation, against a stub engine. Every branch of the rule
 *     ("you cannot share what you cannot see", "you cannot file into an
 *     audience you are not in", "you cannot strip an artifact bare") is a
 *     deny path, and deny paths are the ones that rot silently — a bug here
 *     fails OPEN, and nothing else in the request would look wrong.
 *  2. A real round-trip against Postgres when GBRAIN_DATABASE_URL is set, so
 *     the SQL is exercised rather than only the branching above it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const classify_page = operations.find((o) => o.name === 'classify_page') as Operation;
const get_page_spaces = operations.find((o) => o.name === 'get_page_spaces') as Operation;
if (!classify_page) throw new Error('classify_page op missing');
if (!get_page_spaces) throw new Error('get_page_spaces op missing');

/* ------------------------------------------------------------------ *
 * Layer 1 — authority + validation, stub engine
 * ------------------------------------------------------------------ */

interface StubOpts {
  /** Rows the page lookup returns. Empty = not visible to this caller. */
  page?: { id: number }[];
  /** Space ids that exist in the `spaces` table. */
  knownSpaces?: string[];
  /** Labels the page currently carries. */
  currentSpaces?: string[];
}

function stubEngine(opts: StubOpts = {}): { engine: BrainEngine; writes: string[] } {
  const writes: string[] = [];
  const engine = {
    async executeRaw(query: string, params?: unknown[]): Promise<unknown[]> {
      if (/FROM pages p/.test(query)) return opts.page ?? [{ id: 7 }];
      if (/FROM spaces WHERE id/.test(query)) {
        const asked = (params?.[0] as string[]) ?? [];
        const known = new Set(opts.knownSpaces ?? asked); // default: everything exists
        return asked.filter((s) => known.has(s)).map((id) => ({ id }));
      }
      if (/FROM page_spaces WHERE page_id/.test(query)) {
        return (opts.currentSpaces ?? ['default']).map((space_id) => ({ space_id, granted_at: 'ts' }));
      }
      if (/^\s*(DELETE|INSERT)/i.test(query)) {
        writes.push(query.trim().split(/\s+/)[0].toUpperCase());
        return [];
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, writes };
}

function makeCtx(engine: BrainEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'postgres' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: { token: 't', clientId: 'c', scopes: ['users_admin'], allowedSources: ['default'] },
    ...overrides,
  } as OperationContext;
}

async function expectFailure(fn: () => Promise<unknown>, code: string, match: RegExp) {
  try {
    await fn();
    throw new Error(`expected ${code}, but the call succeeded`);
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe(code);
    expect((e as Error).message).toMatch(match);
  }
}

describe('classify_page — validation', () => {
  test('refuses a no-op call', async () => {
    const { engine } = stubEngine();
    await expectFailure(
      () => classify_page.handler(makeCtx(engine), { slug: 'a/b' }),
      'invalid_params',
      /at least one of add|remove/i,
    );
  });

  test('refuses a space in both add and remove', async () => {
    const { engine } = stubEngine();
    await expectFailure(
      () => classify_page.handler(makeCtx(engine), { slug: 'a/b', add: ['habitat'], remove: ['habitat'] }),
      'invalid_params',
      /both add and remove/,
    );
  });

  test('rejects a malformed space id rather than creating a private audience of one', async () => {
    const { engine } = stubEngine();
    await expectFailure(
      () => classify_page.handler(makeCtx(engine), { slug: 'a/b', add: ['Habitat Public'] }),
      'invalid_params',
      /not a valid space id/,
    );
  });

  test('rejects an unknown space — classifying never mints one as a side effect', async () => {
    const { engine } = stubEngine({ knownSpaces: ['default'] });
    await expectFailure(
      () => classify_page.handler(makeCtx(engine, {
        auth: { token: 't', clientId: 'c', scopes: ['users_admin'], allowedSources: ['default', 'habitatt'] },
      }), { slug: 'a/b', add: ['habitatt'] }),
      'invalid_params',
      /unknown space\(s\): habitatt/,
    );
  });
});

describe('classify_page — authority', () => {
  test('an artifact the caller cannot read reports not_found, never permission_denied', async () => {
    // Leaking "it exists but you may not touch it" would defeat the silent-drop
    // rule the v129 links policy enforces one layer down.
    const { engine } = stubEngine({ page: [] });
    await expectFailure(
      () => classify_page.handler(makeCtx(engine), { slug: 'secret/page', add: ['default'] }),
      'not_found',
      /not found/,
    );
  });

  test('cannot file an artifact into a space the caller does not hold', async () => {
    const { engine } = stubEngine({ knownSpaces: ['default', 'zoa'] });
    await expectFailure(
      () => classify_page.handler(makeCtx(engine), { slug: 'a/b', add: ['zoa'] }),
      'permission_denied',
      /outside your grant: zoa/,
    );
  });

  test('a zero-grant caller can classify nothing', async () => {
    const { engine } = stubEngine();
    const ctx = makeCtx(engine, {
      sourceId: undefined,
      auth: { token: 't', clientId: 'c', scopes: ['users_admin'], allowedSources: [] },
    });
    await expectFailure(
      () => classify_page.handler(ctx, { slug: 'a/b', add: ['default'] }),
      'permission_denied',
      /holds no spaces/,
    );
  });

  test('trusted local CLI is not bound by the grant check', async () => {
    const { engine } = stubEngine({ knownSpaces: ['default', 'zoa'], currentSpaces: ['default'] });
    const ctx = makeCtx(engine, { remote: false, auth: undefined, dryRun: true });
    const out = await classify_page.handler(ctx, { slug: 'a/b', add: ['zoa'] }) as Record<string, unknown>;
    expect(out.after).toEqual(['default', 'zoa']);
  });

  test('withdrawing from a space is not gated by holding it', async () => {
    // Only `add` is grant-checked: blocking removal would strand an artifact in
    // an audience nobody present can clear it from.
    const { engine } = stubEngine({ knownSpaces: ['default', 'zoa'], currentSpaces: ['default', 'zoa'] });
    const ctx = makeCtx(engine, { dryRun: true });
    const out = await classify_page.handler(ctx, { slug: 'a/b', remove: ['zoa'] }) as Record<string, unknown>;
    expect(out.after).toEqual(['default']);
  });
});

describe('classify_page — the last-label guard', () => {
  test('refuses to strip an artifact bare', async () => {
    const { engine, writes } = stubEngine({ knownSpaces: ['default'], currentSpaces: ['default'] });
    await expectFailure(
      () => classify_page.handler(makeCtx(engine), { slug: 'a/b', remove: ['default'] }),
      'invalid_params',
      /no access labels/,
    );
    // And it must refuse BEFORE writing — a partially-applied strip would
    // orphan the artifact just as thoroughly as a completed one.
    expect(writes).toEqual([]);
  });

  test('swapping the last label in one call is allowed', async () => {
    const { engine } = stubEngine({
      knownSpaces: ['default', 'habitat'],
      currentSpaces: ['default'],
    });
    const ctx = makeCtx(engine, {
      dryRun: true,
      auth: { token: 't', clientId: 'c', scopes: ['users_admin'], allowedSources: ['default', 'habitat'] },
    });
    const out = await classify_page.handler(ctx, {
      slug: 'a/b', add: ['habitat'], remove: ['default'],
    }) as Record<string, unknown>;
    expect(out.after).toEqual(['habitat']);
  });
});

describe('classify_page — dry run', () => {
  test('projects the result without writing', async () => {
    const { engine, writes } = stubEngine({
      knownSpaces: ['default', 'habitat'],
      currentSpaces: ['default'],
    });
    const ctx = makeCtx(engine, {
      dryRun: true,
      auth: { token: 't', clientId: 'c', scopes: ['users_admin'], allowedSources: ['default', 'habitat'] },
    });
    const out = await classify_page.handler(ctx, { slug: 'a/b', add: ['habitat'] }) as Record<string, unknown>;
    expect(out).toMatchObject({ dry_run: true, before: ['default'], after: ['default', 'habitat'] });
    expect(writes).toEqual([]);
  });
});

describe('op surface', () => {
  test('both ops are users_admin-scoped, and classify_page is mutating', () => {
    // If either drops to `write`, every write-scoped agent can reclassify the
    // corpus — the exact separation the label model exists to create.
    expect(classify_page.scope).toBe('users_admin');
    expect(get_page_spaces.scope).toBe('users_admin');
    expect(classify_page.mutating).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Layer 2 — real round-trip
 * ------------------------------------------------------------------ */

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('classify_page — round-trip against Postgres', () => {
  const SRC = 'ks-classify-src';
  const SPACE = 'ks-classify-habitat';
  const SLUG = 'ks-classify-page';
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SRC]);
    await engine.executeRaw('DELETE FROM spaces WHERE id = $1', [SPACE]);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [SRC, 'classify fixture']);
    await engine.executeRaw(
      "INSERT INTO spaces (id, label, class) VALUES ($1, $2, 'shareable')", [SPACE, 'Habitat fixture'],
    );
    await engine.executeRaw(
      "INSERT INTO pages (source_id, slug, type, title) VALUES ($1, $2, 'note', 'Classify me')", [SRC, SLUG],
    );
  }, 60_000);

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SRC]);
      await engine.executeRaw('DELETE FROM spaces WHERE id = $1', [SPACE]);
      await engine.disconnect();
    }
  });

  function ctx(): OperationContext {
    return makeCtx(engine as unknown as BrainEngine, {
      sourceId: SRC,
      auth: { token: 't', clientId: 'c', scopes: ['users_admin'], allowedSources: [SRC, SPACE] },
    });
  }

  test('the page starts with only its source label (v129 trigger)', async () => {
    const out = await get_page_spaces.handler(ctx(), { slug: SLUG }) as { spaces: string[] };
    expect(out.spaces).toEqual([SRC]);
  });

  test('adding a label persists and is idempotent', async () => {
    const first = await classify_page.handler(ctx(), { slug: SLUG, add: [SPACE] }) as Record<string, unknown>;
    expect(first.spaces).toEqual([SPACE, SRC].sort());
    expect(first.added).toEqual([SPACE]);

    const again = await classify_page.handler(ctx(), { slug: SLUG, add: [SPACE] }) as Record<string, unknown>;
    expect(again.spaces).toEqual([SPACE, SRC].sort());
    expect(again.added).toEqual([]); // already held — no spurious second grant
  });

  test('removing a label persists', async () => {
    const out = await classify_page.handler(ctx(), { slug: SLUG, remove: [SPACE] }) as Record<string, unknown>;
    expect(out.spaces).toEqual([SRC]);
    expect(out.removed).toEqual([SPACE]);
  });

  test('the last-label guard holds against the real table', async () => {
    await expectFailure(
      () => classify_page.handler(ctx(), { slug: SLUG, remove: [SRC] }),
      'invalid_params',
      /no access labels/,
    );
    const after = await get_page_spaces.handler(ctx(), { slug: SLUG }) as { spaces: string[] };
    expect(after.spaces).toEqual([SRC]); // unchanged
  });
});
