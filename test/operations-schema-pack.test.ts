// v0.40.6.0 — MCP op contract tests for the 9 new schema-pack operations.
//
// Verifies: scope declarations, ctx routing, source-scoping, atomic
// batched mutations via schema_apply_mutations (D10 + codex F2), and
// the audit-log actor capture for MCP clients (D2 + D20).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmpDir: string;
let auditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-ops-schema-test-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-ops-schema-audit-'));
});

afterEach(() => {
  for (const d of [tmpDir, auditDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

function ctxOf(opts: { remote?: boolean; clientId?: string; sourceId?: string } = {}): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: opts.remote ?? true,
    sourceId: opts.sourceId,
    auth: opts.clientId ? { clientId: opts.clientId, scopes: ['admin'] } : undefined,
  } as unknown as OperationContext;
}

function seedPack(packName: string): string {
  const dir = join(tmpDir, '.gbrain', 'schema-packs', packName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, `api_version: gbrain-schema-pack-v1
name: ${packName}
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases: []
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`, 'utf-8');
  return path;
}

// ── Scope + localOnly declarations ──────────────────────────────────────

describe('operation declarations', () => {
  it('get_active_schema_pack is read scope, NOT localOnly', () => {
    const op = operationsByName.get_active_schema_pack!;
    expect(op.scope).toBe('read');
    expect(op.localOnly).toBeUndefined();
  });

  it('list_schema_packs is read scope, NOT localOnly', () => {
    expect(operationsByName.list_schema_packs!.scope).toBe('read');
    expect(operationsByName.list_schema_packs!.localOnly).toBeUndefined();
  });

  it('schema_stats / schema_lint / schema_graph / schema_explain_type / schema_review_orphans are all read scope', () => {
    for (const name of ['schema_stats', 'schema_lint', 'schema_graph', 'schema_explain_type', 'schema_review_orphans']) {
      expect(operationsByName[name]!.scope).toBe('read');
      expect(operationsByName[name]!.localOnly).toBeUndefined();
    }
  });

  it('schema_apply_mutations is admin scope, NOT localOnly (D2)', () => {
    const op = operationsByName.schema_apply_mutations!;
    expect(op.scope).toBe('admin');
    expect(op.localOnly).toBeUndefined();
    expect(op.mutating).toBe(true);
  });

  it('reload_schema_pack is admin scope, NOT localOnly (D2)', () => {
    const op = operationsByName.reload_schema_pack!;
    expect(op.scope).toBe('admin');
    expect(op.localOnly).toBeUndefined();
  });
});

// ── get_active_schema_pack ──────────────────────────────────────────────

describe('get_active_schema_pack', () => {
  it('returns identity packet for the bundled gbrain-base pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await operationsByName.get_active_schema_pack!.handler(ctxOf(), {}) as Record<string, unknown>;
      expect(result.pack_name).toBe('gbrain-base');
      expect(result.page_types_count).toBeGreaterThan(0);
      expect(typeof result.sha8).toBe('string');
      expect(typeof result.source_tier).toBe('string');
      expect(typeof result.primitive_summary).toBe('object');
    });
  });
});

// ── list_schema_packs ──────────────────────────────────────────────────

describe('list_schema_packs', () => {
  it('returns bundled + installed', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      seedPack('mine');
      const result = await operationsByName.list_schema_packs!.handler(ctxOf(), {}) as { bundled: string[]; installed: string[] };
      expect(result.bundled).toContain('gbrain-base');
      expect(result.installed).toContain('mine');
    });
  });
});

// ── schema_stats ───────────────────────────────────────────────────────

describe('schema_stats', () => {
  it('returns coverage + per-source breakdown', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
         VALUES ('a', 'default', 'people/alice.md', 'person', 'a', '', '', '')`,
      );
      const result = await operationsByName.schema_stats!.handler(ctxOf(), {}) as Record<string, unknown>;
      expect((result.aggregate as { total_pages: number }).total_pages).toBe(1);
      expect(result.schema_version).toBe(1);
    });
  });
});

// ── schema_lint ─────────────────────────────────────────────────────────

describe('schema_lint', () => {
  it('lints the active pack and returns ok=true for clean pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await operationsByName.schema_lint!.handler(ctxOf(), {}) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });
  });

  it('returns pack_not_found for unknown pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const result = await operationsByName.schema_lint!.handler(ctxOf(), { pack: 'nonexistent' }) as Record<string, unknown>;
      expect(result.error).toBe('pack_not_found');
    });
  });
});

// ── schema_graph ──────────────────────────────────────────────────────

describe('schema_graph', () => {
  it('returns nodes + edges from link_types', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await operationsByName.schema_graph!.handler(ctxOf(), {}) as Record<string, unknown>;
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
    });
  });
});

// ── schema_explain_type ────────────────────────────────────────────────

describe('schema_explain_type', () => {
  it('returns settings for a known type', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await operationsByName.schema_explain_type!.handler(ctxOf(), { type: 'person' }) as Record<string, unknown>;
      expect((result.type as { name?: string }).name).toBe('person');
    });
  });

  it('returns type_not_found for unknown type', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await operationsByName.schema_explain_type!.handler(ctxOf(), { type: 'ghost' }) as Record<string, unknown>;
      expect(result.error).toBe('type_not_found');
    });
  });
});

// ── schema_review_orphans ──────────────────────────────────────────────

describe('schema_review_orphans', () => {
  it('returns untyped pages from the DB', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
       VALUES ('orphan-1', 'default', 'unknown/page.md', '', 'o', '', '', '')`,
    );
    const result = await operationsByName.schema_review_orphans!.handler(ctxOf(), {}) as Record<string, unknown>;
    expect(result.orphan_count).toBeGreaterThanOrEqual(1);
  });

  it('respects limit param', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
         VALUES ($1, 'default', $2, '', $1, '', '', '')`,
        [`o${i}`, `unknown/o${i}.md`],
      );
    }
    const result = await operationsByName.schema_review_orphans!.handler(ctxOf(), { limit: 2 }) as Record<string, unknown>;
    expect(result.orphan_count).toBe(2);
  });
});

// ── schema_apply_mutations — batched + atomic ──────────────────────────

describe('schema_apply_mutations', () => {
  it('applies a single add_type mutation', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine');
      const result = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'mine',
        mutations: [
          { op: 'add_type', name: 'researcher', primitive: 'entity', prefix: 'people/researchers/', extractable: true },
        ],
      }) as Record<string, unknown>;
      expect(result.mutations_applied).toBe(1);
      expect(result.batch_id).toBeDefined();
    });
  });

  it('applies multiple mutations atomically (one batch_id across all)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine');
      const result = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'mine',
        mutations: [
          { op: 'add_type', name: 'researcher', primitive: 'entity', prefix: 'people/researchers/' },
          { op: 'add_type', name: 'company', primitive: 'entity', prefix: 'companies/' },
          { op: 'add_link_type', name: 'works_at', inference: { page_type: 'researcher', target_type: 'company' } },
        ],
      }) as Record<string, unknown>;
      expect(result.mutations_applied).toBe(3);
      const results = result.results as Array<{ index: number }>;
      expect(results.length).toBe(3);
      expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    });
  });

  it('returns partial_results on mid-batch failure with a single batch_id', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine');
      const result = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'mine',
        mutations: [
          { op: 'add_type', name: 'company', primitive: 'entity', prefix: 'companies/' },
          { op: 'add_type', name: 'person', primitive: 'entity', prefix: 'people/' }, // collides with seed
        ],
      }) as Record<string, unknown>;
      expect(result.error).toBe('mutation_failed');
      const partial = result.partial_results as Array<unknown>;
      expect(partial.length).toBe(1);  // first mutation succeeded
    });
  });

  it('rejects unknown op with INVALID_RESULT', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine');
      const result = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'mine',
        mutations: [{ op: 'nonexistent_op', name: 'x' }],
      }) as Record<string, unknown>;
      expect(result.error).toBe('mutation_failed');
    });
  });

  it('rejects empty mutations array', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine');
      const result = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'mine',
        mutations: [],
      }) as Record<string, unknown>;
      expect(result.error).toBe('invalid_request');
    });
  });

  it('captures MCP client_id in audit log actor field (D2 + D20)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine');
      await operationsByName.schema_apply_mutations!.handler(
        ctxOf({ clientId: 'remoteAgentClient12345678' }),
        {
          pack: 'mine',
          mutations: [{ op: 'add_type', name: 'researcher', primitive: 'entity', prefix: 'r/' }],
        },
      );
      // Audit log filename pattern: schema-mutations-YYYY-Www.jsonl.
      const { readdirSync } = await import('node:fs');
      const auditFiles = readdirSync(auditDir).filter((f) => f.startsWith('schema-mutations-'));
      expect(auditFiles.length).toBeGreaterThan(0);
      const auditPath = join(auditDir, auditFiles[0]!);
      const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
      const records = lines.map((l) => JSON.parse(l));
      // Actor is mcp:<first 8 chars of clientId> = mcp:remoteAg (8 chars).
      expect(records.some((r) => r.actor === 'mcp:remoteAg')).toBe(true);
    });
  });
});

// ── reload_schema_pack ────────────────────────────────────────────────

describe('reload_schema_pack', () => {
  it('returns invalidated list', async () => {
    const result = await operationsByName.reload_schema_pack!.handler(ctxOf(), {}) as { invalidated: string[] };
    expect(Array.isArray(result.invalidated)).toBe(true);
  });

  it('invalidates a specific pack by name', async () => {
    const result = await operationsByName.reload_schema_pack!.handler(ctxOf(), { pack: 'foo' }) as { invalidated: string[] };
    expect(result.invalidated).toContain('foo');
  });
});

// ── Pack lifecycle over MCP (read trio + fork) ────────────────────────
//
// The point of `schema_fork_pack` is that `schema_apply_mutations` requires
// a NON-BUNDLED pack, and a default install (bundled pack, no user packs)
// has no MCP path to obtain one — so the exposed write tool could never
// succeed. These tests pin that the fork→mutate loop actually closes, and
// that fork is a COPY (init-style empty packs would blank type resolution
// on activation, since `extends` doesn't merge parent types — TODOS T20).

describe('schema lifecycle op declarations', () => {
  it('the read trio is read scope, NOT localOnly', () => {
    for (const name of ['schema_validate_pack', 'schema_show_pack', 'schema_diff_packs']) {
      expect(operationsByName[name]!.scope).toBe('read');
      expect(operationsByName[name]!.localOnly).toBeUndefined();
    }
  });

  it('schema_fork_pack is admin + mutating, NOT localOnly (agents must reach it)', () => {
    const op = operationsByName.schema_fork_pack!;
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);
    expect(op.localOnly).toBeUndefined();
  });

  it('no schema_use_pack op exists — activation stays local-only', () => {
    expect(operationsByName.schema_use_pack).toBeUndefined();
  });
});

describe('schema_validate_pack', () => {
  it('reports ok with counts for a valid pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      seedPack('mine');
      const r = await operationsByName.schema_validate_pack!.handler(ctxOf(), { pack: 'mine' }) as
        { ok: boolean; pack: string; page_types: number };
      expect(r.ok).toBe(true);
      expect(r.pack).toBe('mine');
      expect(r.page_types).toBe(1);
    });
  });

  it('returns ok:false DATA (not a throw) for an invalid manifest', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const dir = join(tmpDir, '.gbrain', 'schema-packs', 'broken');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'pack.yaml'), 'api_version: gbrain-schema-pack-v1\nname: broken\n', 'utf-8');
      const r = await operationsByName.schema_validate_pack!.handler(ctxOf(), { pack: 'broken' }) as
        { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid_manifest');
    });
  });

  it('resolves bundled packs, not just user-installed ones', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const r = await operationsByName.schema_validate_pack!.handler(ctxOf(), { pack: 'gbrain-base' }) as
        { ok: boolean; page_types: number };
      expect(r.ok).toBe(true);
      expect(r.page_types).toBeGreaterThan(0);
    });
  });

  it('reports pack_not_found for an unknown pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const r = await operationsByName.schema_validate_pack!.handler(ctxOf(), { pack: 'nope' }) as
        { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(r.error).toBe('pack_not_found');
    });
  });
});

describe('schema_show_pack', () => {
  it('returns the full manifest', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      seedPack('mine');
      const r = await operationsByName.schema_show_pack!.handler(ctxOf(), { pack: 'mine' }) as
        { pack: string; manifest: { page_types: Array<{ name: string }> } };
      expect(r.pack).toBe('mine');
      expect(r.manifest.page_types.map((t) => t.name)).toEqual(['person']);
    });
  });
});

describe('schema_diff_packs', () => {
  it('partitions declared types into only_in_a / only_in_b / common', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      seedPack('mine');
      const r = await operationsByName.schema_diff_packs!.handler(ctxOf(), { a: 'gbrain-base', b: 'mine' }) as
        { only_in_a: string[]; only_in_b: string[]; common: string[] };
      // gbrain-base declares `person`; the seeded pack declares only that.
      expect(r.common).toEqual(['person']);
      expect(r.only_in_b).toEqual([]);
      expect(r.only_in_a.length).toBeGreaterThan(0);
    });
  });

  it('reports pack_not_found naming the missing side', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const r = await operationsByName.schema_diff_packs!.handler(ctxOf(), { a: 'gbrain-base', b: 'nope' }) as
        { error: string; pack: string };
      expect(r.error).toBe('pack_not_found');
      expect(r.pack).toBe('nope');
    });
  });
});

describe('schema_fork_pack', () => {
  it('copies every declared type from the source pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const base = await operationsByName.schema_validate_pack!.handler(ctxOf(), { pack: 'gbrain-base' }) as
        { page_types: number };
      const r = await operationsByName.schema_fork_pack!.handler(ctxOf(), { from: 'gbrain-base', to: 'my-fork' }) as
        { to: string; page_types: number; activated: boolean; path: string };
      expect(r.to).toBe('my-fork');
      // The load-bearing assertion: a fork starts equivalent to its source.
      // An init-style empty pack would report 0 here and blank type
      // resolution for the whole corpus on activation (TODOS T20).
      expect(r.page_types).toBe(base.page_types);
      expect(r.activated).toBe(false);
    });
  });

  it('makes schema_apply_mutations reachable — the whole point', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Before: the only pack is bundled, and mutating it is refused.
      const refused = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'gbrain-base',
        mutations: [{ op: 'add_type', name: 'strategy', primitive: 'concept', prefix: 'wiki/strategy/' }],
      }) as { error?: string; code?: string };
      expect(refused.error ?? refused.code).toBeDefined();

      // Fork over MCP, then the same mutation succeeds.
      await operationsByName.schema_fork_pack!.handler(ctxOf(), { from: 'gbrain-base', to: 'my-fork' });
      const applied = await operationsByName.schema_apply_mutations!.handler(ctxOf(), {
        pack: 'my-fork',
        mutations: [{ op: 'add_type', name: 'strategy', primitive: 'concept', prefix: 'wiki/strategy/' }],
      }) as { error?: string };
      expect(applied.error).toBeUndefined();

      const shown = await operationsByName.schema_show_pack!.handler(ctxOf(), { pack: 'my-fork' }) as
        { manifest: { page_types: Array<{ name: string }> } };
      expect(shown.manifest.page_types.map((t) => t.name)).toContain('strategy');
    });
  });

  it('refuses to overwrite an existing pack', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      seedPack('mine');
      const r = await operationsByName.schema_fork_pack!.handler(ctxOf(), { from: 'gbrain-base', to: 'mine' }) as
        { error: string };
      expect(r.error).toBe('pack_exists');
    });
  });

  it('refuses a bundled pack name as the fork target', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const r = await operationsByName.schema_fork_pack!.handler(ctxOf(), { from: 'gbrain-base', to: 'gbrain-base' }) as
        { error: string };
      expect(r.error).toBe('name_reserved');
    });
  });

  it('rejects path-traversal and other non-slug names', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      for (const to of ['../escape', '/abs', 'Has Spaces', '..', 'UPPER']) {
        const r = await operationsByName.schema_fork_pack!.handler(ctxOf(), { from: 'gbrain-base', to }) as
          { error: string };
        expect(r.error).toBe('invalid_pack_name');
      }
    });
  });

  it('reports pack_not_found for an unknown source', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      const r = await operationsByName.schema_fork_pack!.handler(ctxOf(), { from: 'nope', to: 'my-fork' }) as
        { error: string };
      expect(r.error).toBe('pack_not_found');
    });
  });
});
