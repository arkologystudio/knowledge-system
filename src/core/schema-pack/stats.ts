// v0.40.6.0 Schema Cathedral v3 — schema_stats pure core function.
//
// Reports per-type page counts, untyped-coverage percentage, and
// dead-prefix detection (declared prefix with zero matching pages —
// a "this type has no content" signal that helps agents spot
// mis-declared paths).
//
// Undeclared-type detection is the MIRROR IMAGE of dead prefixes, and
// the reason it lives here rather than behind its own verb. Dead
// prefixes answer "what does the pack declare that the corpus doesn't
// use?"; `undeclared_types` answers "what does the corpus use that the
// pack doesn't declare?". Both are pack-vs-corpus divergence; reporting
// them from one call means an agent can't read half the picture and
// conclude the schema is clean.
//
// Note the asymmetry with `schema_review_orphans`, which is NOT the same
// question: orphans are pages with NO type at all (`type IS NULL OR
// type = ''`). An undeclared type is a page that is confidently typed
// with a name the active pack never declared. Those pages store, chunk,
// embed and retrieve normally — nothing is broken — so this is reported
// as drift, never as an error.
//
// Multi-source aware: accepts `sourceIds` (federated read) OR
// `sourceId` (single) OR nothing (aggregate across all sources). Uses
// the same WHERE shape as the rest of the read-path codebase.
//
// PGLite + Postgres parity via `executeRaw`. Soft-deletes filtered.
//
// Pure core: returns structured data; CLI handler in Phase 4 wraps
// for human + JSON output, MCP handler in Phase 7 wires it through
// the operation envelope.

import type { BrainEngine } from '../engine.ts';
import { loadActivePackBestEffort } from './best-effort.ts';
import { PACK_PRIMITIVES } from './manifest-v1.ts';
import type { OperationContext } from '../operations.ts';

export interface StatsOpts {
  /** Single source scope. Omit + omit sourceIds for whole-brain aggregate. */
  sourceId?: string;
  /** Federated read scope (overrides sourceId when set). */
  sourceIds?: string[];
}

export interface TypeStats {
  /** Type name as it appears in the DB `pages.type` column. */
  type: string;
  /** Page count for this type within the scope. */
  count: number;
}

export interface PerSourceStats {
  source_id: string;
  total_pages: number;
  typed_pages: number;
  untyped_pages: number;
  coverage: number;
  by_type: TypeStats[];
}

export interface DeadPrefixHint {
  /** Type name declared in the pack. */
  type: string;
  /** Prefix declared in the pack with zero matching DB pages. */
  prefix: string;
}

/**
 * How an undeclared type relates to the active pack. Classification (not
 * a bare flag) is deliberate: undeclared types are legal and work fine at
 * runtime, so a check that only flags them produces permanent noise on any
 * brain that uses them on purpose. The class tells the operator WHICH kind
 * of divergence they're looking at, and therefore whether to act.
 *
 *   - `primitive_name` — the type name is one of the five pack primitives
 *     (`entity`, `media`, `temporal`, `annotation`, `concept`) but is not
 *     declared as a page_type. Almost always a filing mistake: the page was
 *     typed with the primitive instead of a type that extends it. Highest
 *     signal of the three.
 *   - `aliased` — not declared as a page_type, but some declared type lists
 *     it in `aliases[]`, so query expansion already reaches it. Low urgency;
 *     `schema_lint` flags the dangling alias separately.
 *   - `undeclared` — in use, unknown to the pack in every respect. The
 *     ordinary case: either an intentional local type the pack should
 *     declare, or a typo.
 */
export type UndeclaredTypeClass = 'primitive_name' | 'aliased' | 'undeclared';

export interface UndeclaredTypeHint {
  /** Type name as it appears in the DB `pages.type` column. */
  type: string;
  /** Live page count for this type within the scope (soft-deletes excluded). */
  page_count: number;
  /** Up to 3 slugs, lexically first, so an operator can go look at one. */
  example_slugs: string[];
  /** Which kind of divergence this is — see UndeclaredTypeClass. */
  classification: UndeclaredTypeClass;
}

export interface StatsResult {
  schema_version: 1;
  /** Pack identity at stats time (null when no pack loaded). */
  pack_identity: string | null;
  /** Aggregate across all scoped sources. */
  aggregate: PerSourceStats;
  /** Per-source breakdown when multiple sources are in scope. */
  per_source: PerSourceStats[];
  /** Pack-declared prefixes that match zero pages — likely mis-declared. */
  dead_prefixes: DeadPrefixHint[];
  /**
   * Types in use in the corpus that the active pack does not declare — the
   * inverse of `dead_prefixes`. Sorted by page_count desc, ties by name asc
   * (same ordering rule as `by_type`).
   *
   * Empty when no pack loads: without a declared set there is nothing to be
   * undeclared AGAINST, and reporting every type in the corpus as undeclared
   * would be actively misleading. Same fail-quiet contract as `dead_prefixes`.
   */
  undeclared_types: UndeclaredTypeHint[];
}

interface RawCountRow {
  source_id: string | null;
  type: string | null;
  cnt: string;
}

function computeCoverage(typed: number, total: number): number {
  if (total === 0) return 1.0;  // vacuous truth — matches getBrainScore pattern
  return Math.round((typed / total) * 10000) / 10000;
}

function aggregateRows(rows: RawCountRow[]): PerSourceStats[] {
  const bySource = new Map<string, { typed: number; untyped: number; total: number; byType: Map<string, number> }>();
  for (const r of rows) {
    const sid = r.source_id ?? 'default';
    const cnt = parseInt(r.cnt, 10) || 0;
    if (!bySource.has(sid)) {
      bySource.set(sid, { typed: 0, untyped: 0, total: 0, byType: new Map() });
    }
    const bucket = bySource.get(sid)!;
    if (r.type === null || r.type === '') {
      bucket.untyped += cnt;
    } else {
      bucket.typed += cnt;
      bucket.byType.set(r.type, (bucket.byType.get(r.type) ?? 0) + cnt);
    }
    bucket.total += cnt;
  }
  const out: PerSourceStats[] = [];
  for (const [sid, b] of bySource) {
    out.push({
      source_id: sid,
      total_pages: b.total,
      typed_pages: b.typed,
      untyped_pages: b.untyped,
      coverage: computeCoverage(b.typed, b.total),
      by_type: [...b.byType.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    });
  }
  // Sort sources alphabetically for stable output.
  out.sort((a, b) => a.source_id.localeCompare(b.source_id));
  return out;
}

function mergeAggregate(per: PerSourceStats[]): PerSourceStats {
  let typed = 0, untyped = 0, total = 0;
  const byType = new Map<string, number>();
  for (const s of per) {
    typed += s.typed_pages;
    untyped += s.untyped_pages;
    total += s.total_pages;
    for (const t of s.by_type) byType.set(t.type, (byType.get(t.type) ?? 0) + t.count);
  }
  return {
    source_id: '*',
    total_pages: total,
    typed_pages: typed,
    untyped_pages: untyped,
    coverage: computeCoverage(typed, total),
    by_type: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

/**
 * Query the DB for stats. Multi-source aware:
 *   - sourceIds[] → WHERE source_id = ANY($1::text[])
 *   - sourceId    → WHERE source_id = $1
 *   - neither     → no source filter (whole brain)
 *
 * Always: `WHERE deleted_at IS NULL`.
 *
 * Returns rows grouped by (source_id, type) so we can compute per-source
 * + aggregate in one read.
 */
async function fetchCountRows(engine: BrainEngine, opts: StatsOpts): Promise<RawCountRow[]> {
  let where = 'WHERE deleted_at IS NULL';
  const params: unknown[] = [];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    where += ` AND source_id = ANY($1::text[])`;
    params.push(opts.sourceIds);
  } else if (opts.sourceId) {
    where += ` AND source_id = $1`;
    params.push(opts.sourceId);
  }
  // pages.type is NOT NULL in the schema — empty string represents
  // "untyped" (legacy + put_page fallback per D12). Normalize both
  // empty-string and NULL to the same bucket via NULLIF.
  const sql = `
    SELECT
      COALESCE(source_id, 'default') AS source_id,
      NULLIF(type, '') AS type,
      COUNT(*)::text AS cnt
    FROM pages
    ${where}
    GROUP BY source_id, NULLIF(type, '')
    ORDER BY source_id, NULLIF(type, '') NULLS LAST
  `;
  try {
    return await engine.executeRaw<RawCountRow>(sql, params);
  } catch {
    // Empty / pre-init brain: pages table may not exist yet.
    return [];
  }
}

/**
 * Per-prefix existence check for dead-prefix detection. One COUNT(*)
 * per declared prefix in the active pack. Cheap on small brains;
 * Phase 4 CLI offers a `--no-dead-prefix-scan` flag to opt out on
 * brains where this matters.
 */
async function detectDeadPrefixes(
  engine: BrainEngine,
  pack: { manifest: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } },
  opts: StatsOpts,
): Promise<DeadPrefixHint[]> {
  const hints: DeadPrefixHint[] = [];
  let sourceWhere = '';
  const sourceParam: unknown[] = [];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    sourceWhere = ` AND source_id = ANY($2::text[])`;
    sourceParam.push(opts.sourceIds);
  } else if (opts.sourceId) {
    sourceWhere = ` AND source_id = $2`;
    sourceParam.push(opts.sourceId);
  }
  for (const t of pack.manifest.page_types) {
    for (const prefix of t.path_prefixes) {
      try {
        const rows = await engine.executeRaw<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM pages
           WHERE deleted_at IS NULL
             AND source_path LIKE $1${sourceWhere}`,
          [`${prefix}%`, ...sourceParam],
        );
        const cnt = parseInt(rows[0]?.cnt ?? '0', 10) || 0;
        if (cnt === 0) {
          hints.push({ type: t.name, prefix });
        }
      } catch {
        // Skip on engine error (no pages table yet, etc.).
        continue;
      }
    }
  }
  return hints;
}

/**
 * Undeclared-type detection — the inverse of dead-prefix detection.
 *
 * Counts come from `aggregate.by_type`, which the caller already computed
 * from the single GROUP BY read, so this adds NO per-type count query. The
 * only extra read is one bounded example-slug lookup, and only when at
 * least one undeclared type exists — a pack-clean brain pays nothing.
 *
 * Example slugs use ROW_NUMBER() rather than a query-per-type so a corpus
 * with many undeclared types stays one round trip. Both engines are real
 * Postgres, so the window function is parity-safe.
 */
async function detectUndeclaredTypes(
  engine: BrainEngine,
  pack: { manifest: { page_types: ReadonlyArray<{ name: string; aliases?: ReadonlyArray<string> }> } },
  byType: TypeStats[],
  opts: StatsOpts,
): Promise<UndeclaredTypeHint[]> {
  const declared = new Set(pack.manifest.page_types.map((t) => t.name));
  const missing = byType.filter((t) => !declared.has(t.type));
  if (missing.length === 0) return [];

  // Alias targets across every declared type — a type reachable through the
  // closure graph is a materially weaker finding than one nothing knows about.
  const aliased = new Set<string>();
  for (const t of pack.manifest.page_types) {
    for (const a of t.aliases ?? []) aliased.add(a);
  }
  const primitives = new Set<string>(PACK_PRIMITIVES);

  // One bounded read for example slugs across every undeclared type.
  const names = missing.map((t) => t.type);
  let where = `WHERE deleted_at IS NULL AND type = ANY($1::text[])`;
  const params: unknown[] = [names];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    where += ` AND source_id = ANY($2::text[])`;
    params.push(opts.sourceIds);
  } else if (opts.sourceId) {
    where += ` AND source_id = $2`;
    params.push(opts.sourceId);
  }
  const examples = new Map<string, string[]>();
  try {
    const rows = await engine.executeRaw<{ type: string; slug: string }>(
      `SELECT type, slug FROM (
         SELECT type, slug, ROW_NUMBER() OVER (PARTITION BY type ORDER BY slug) AS rn
         FROM pages ${where}
       ) ranked
       WHERE rn <= 3
       ORDER BY type, slug`,
      params,
    );
    for (const r of rows) {
      const list = examples.get(r.type) ?? [];
      list.push(r.slug);
      examples.set(r.type, list);
    }
  } catch {
    // Example slugs are a convenience, not the finding. A failed lookup
    // must not suppress the drift report itself.
  }

  return missing
    .map((t) => ({
      type: t.type,
      page_count: t.count,
      example_slugs: examples.get(t.type) ?? [],
      classification: primitives.has(t.type)
        ? ('primitive_name' as const)
        : aliased.has(t.type)
          ? ('aliased' as const)
          : ('undeclared' as const),
    }))
    .sort((a, b) => b.page_count - a.page_count || a.type.localeCompare(b.type));
}

/**
 * Pure core for `gbrain schema stats` (CLI) AND `schema_stats` MCP op.
 * Returns the StatsResult ready for human-formatter, JSON output, or
 * operation envelope wrapping.
 */
export async function runStatsCore(
  ctx: OperationContext,
  opts: StatsOpts = {},
): Promise<StatsResult> {
  const rows = await fetchCountRows(ctx.engine, opts);
  const per_source = aggregateRows(rows);
  const aggregate = mergeAggregate(per_source);

  // Pack identity + both divergence scans — best-effort.
  let pack_identity: string | null = null;
  let dead_prefixes: DeadPrefixHint[] = [];
  let undeclared_types: UndeclaredTypeHint[] = [];
  const pack = await loadActivePackBestEffort(ctx);
  if (pack) {
    pack_identity = pack.identity;
    dead_prefixes = await detectDeadPrefixes(ctx.engine, pack, opts);
    undeclared_types = await detectUndeclaredTypes(ctx.engine, pack, aggregate.by_type, opts);
  }

  return {
    schema_version: 1,
    pack_identity,
    aggregate,
    per_source,
    dead_prefixes,
    undeclared_types,
  };
}
