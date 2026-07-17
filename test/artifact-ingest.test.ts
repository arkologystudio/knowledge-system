/**
 * Knowledge System T2 — deterministic bulk-artefact ingestion.
 *
 * Exercises the whole pipeline against a small fixture corpus (NOT ZOA):
 *   - pluggable extractors (plaintext lean baseline + unstructured off-box gate)
 *   - `ingestArtifact` persistence (artefact + artefact-scoped chunks, page_id
 *     NULL, XOR-satisfied, embedded @1536 via an injected embedder)
 *   - idempotency (dedup on source_id + content_hash → reuse + chunk replace)
 *   - `ArtifactBulkSource` corpus walk + extraction
 *   - the `ingest_bulk` Minion handler end-to-end
 *   - the `submit_ingest` op enqueuing a job on the Minion queue
 *
 * Runs entirely on PGLite (Postgres 17.5 in WASM) — no gateway, no network:
 * embeddings are injected; the embed-deferring path is also covered.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ingestArtifact } from '../src/core/artifact/ingest-artifact.ts';
import {
  PlainTextExtractor,
  UnstructuredExtractor,
  ExtractorUnavailableError,
  resolveExtractor,
  listExtractors,
} from '../src/core/artifact/extractors.ts';
import { ArtifactBulkSource } from '../src/core/ingestion/sources/artifact-bulk.ts';
import type { IngestionEvent, IngestionSourceContext } from '../src/core/ingestion/types.ts';
import { makeIngestBulkHandler } from '../src/core/minions/handlers/ingest-bulk.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const CORPUS = join(import.meta.dir, 'fixtures', 'artifact-corpus');

function recorderCtx(engine: PGLiteEngine, events: IngestionEvent[]): IngestionSourceContext {
  return {
    emit: (e) => events.push(e),
    engine: engine as unknown as IngestionSourceContext['engine'],
    logger: { info() {}, warn() {}, error() {} },
    abortSignal: new AbortController().signal,
    config: {},
  };
}

describe('T2 — extractors', () => {
  test('PlainTextExtractor reads markdown and derives the heading title', async () => {
    const ex = new PlainTextExtractor();
    const out = await ex.extract({ path: join(CORPUS, 'alpha-report.md') });
    expect(out.contentType).toBe('text/markdown');
    expect(out.title).toBe('Alpha Report');
    expect(out.text).toContain('deterministic bulk-artefact');
  });

  test('PlainTextExtractor falls back to first line for plain text', async () => {
    const ex = new PlainTextExtractor();
    const out = await ex.extract({ path: join(CORPUS, 'beta-notes.txt') });
    expect(out.contentType).toBe('text/plain');
    expect(out.title).toBe('Beta Notes');
  });

  test('empty text throws (so the caller audits + skips)', async () => {
    const ex = new PlainTextExtractor(() => '   \n  ');
    await expect(ex.extract({ path: '/whatever.md' })).rejects.toThrow(/empty text/);
  });

  test('unstructured is registered but inert without an off-box URL', async () => {
    expect(listExtractors()).toContain('unstructured');
    await withEnv({ GBRAIN_UNSTRUCTURED_URL: undefined }, async () => {
      const ex = new UnstructuredExtractor();
      await expect(ex.extract({ bytes: new Uint8Array([1, 2, 3]) })).rejects.toBeInstanceOf(
        ExtractorUnavailableError,
      );
    });
  });

  test('resolveExtractor: preferred wins, else per-extension, else plaintext', () => {
    // .pdf is claimed by the unstructured extractor → per-extension match (it
    // then fails loud unless GBRAIN_UNSTRUCTURED_URL is set — better than
    // reading a PDF as garbage text).
    expect(resolveExtractor('.pdf').name).toBe('unstructured');
    expect(resolveExtractor('.pdf', 'unstructured').name).toBe('unstructured');
    // Unknown extension → lean plaintext fallback.
    expect(resolveExtractor('.xyz').name).toBe('plaintext');
    expect(resolveExtractor('.md').name).toBe('plaintext');
    expect(() => resolveExtractor('.md', 'nope')).toThrow(/Unknown extractor/);
  });
});

describe('T2 — ingestArtifact persistence', () => {
  let engine: PGLiteEngine;
  let fakeEmbed: (texts: string[]) => Promise<Float32Array[]>;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const dimensions = Number(await engine.getConfig('embedding_dimensions'));
    fakeEmbed = async (texts: string[]): Promise<Float32Array[]> =>
      texts.map((t, i) => {
        const v = new Float32Array(dimensions);
        v.fill((i + 1) * 0.001 + (t.length % 7) * 0.0001);
        return v;
      });
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('lands an artefact + artefact-scoped embedded chunks (page_id NULL)', async () => {
    const content = '# Doc\n\n' + 'The retrieval substrate indexes raw artefacts. '.repeat(20);
    const res = await ingestArtifact(
      engine,
      { content, title: 'Doc', uri: 'file:///doc.md', sourceId: 'corpus-a', provenance: { extractor: 'plaintext' } },
      { embed: fakeEmbed },
    );

    expect(res.status).toBe('ingested');
    expect(res.reused).toBe(false);
    expect(res.artifact_id).toBeGreaterThan(0);
    expect(res.object_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.chunks).toBeGreaterThan(0);
    expect(res.embedded).toBe(true);

    // Chunks are artefact-scoped: artifact_id set, page_id NULL, embedded.
    const chunks = await engine.executeRaw<{ n: number; nulls: number; embedded: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE page_id IS NULL)::int AS nulls,
              count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
         FROM content_chunks WHERE artifact_id = $1`,
      [res.artifact_id],
    );
    expect(chunks[0]!.n).toBe(res.chunks);
    expect(chunks[0]!.nulls).toBe(res.chunks);
    expect(chunks[0]!.embedded).toBe(res.chunks);

    // The artefact row carries provenance JSONB (written JSONB-safely).
    const art = await engine.executeRaw<{ source_id: string; extractor: string }>(
      `SELECT source_id, provenance->>'extractor' AS extractor FROM artifacts WHERE id = $1`,
      [res.artifact_id],
    );
    expect(art[0]!.source_id).toBe('corpus-a');
    expect(art[0]!.extractor).toBe('plaintext');
  });

  test('idempotent: same (source_id, content_hash) reuses the row + replaces chunks', async () => {
    const content = 'stable artefact body that hashes identically on both runs';
    const first = await ingestArtifact(engine, { content, sourceId: 'corpus-idem' }, { embed: fakeEmbed });
    const second = await ingestArtifact(engine, { content, sourceId: 'corpus-idem' }, { embed: fakeEmbed });

    expect(second.reused).toBe(true);
    expect(second.artifact_id).toBe(first.artifact_id);
    expect(second.object_id).toBe(first.object_id);

    const count = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifacts WHERE source_id = 'corpus-idem'`,
    );
    expect(count[0]!.n).toBe(1); // no duplicate artefact
  });

  test('different sources with identical content are isolated (separate artefacts)', async () => {
    const content = 'cross-source isolation body';
    const a = await ingestArtifact(engine, { content, sourceId: 'src-x' }, { embed: fakeEmbed });
    const b = await ingestArtifact(engine, { content, sourceId: 'src-y' }, { embed: fakeEmbed });
    expect(a.artifact_id).not.toBe(b.artifact_id);
  });

  test('noEmbed lands chunks with NULL embedding for a later embed --stale pass', async () => {
    const res = await ingestArtifact(
      engine,
      { content: 'deferred embedding body '.repeat(10), sourceId: 'corpus-defer' },
      { noEmbed: true },
    );
    expect(res.embedded).toBe(false);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE artifact_id = $1 AND embedding IS NULL`,
      [res.artifact_id],
    );
    expect(rows[0]!.n).toBe(res.chunks);
  });

  test('empty content is skipped (no artefact, no chunks)', async () => {
    const res = await ingestArtifact(engine, { content: '   ', sourceId: 'corpus-empty' }, { embed: fakeEmbed });
    expect(res.status).toBe('skipped');
    expect(res.artifact_id).toBe(0);
  });
});

describe('T2 — ArtifactBulkSource corpus walk', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('walks the fixture corpus recursively, extracts, tags content_class=artifact', async () => {
    const events: IngestionEvent[] = [];
    const source = new ArtifactBulkSource({ dir: CORPUS, sourceId: 'walk-test' });
    await source.start(recorderCtx(engine, events));

    // 3 text docs (alpha.md, beta.txt, nested/gamma.md); skip-me.png filtered out.
    expect(events.length).toBe(3);
    expect(source.stats.emitted).toBe(3);
    for (const e of events) {
      expect(e.source_kind).toBe('artifact-bulk');
      expect((e.metadata as Record<string, unknown>).content_class).toBe('artifact');
      expect(e.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const paths = events.map((e) => (e.metadata as Record<string, unknown>).original_path).sort();
    expect(paths).toEqual(['alpha-report.md', 'beta-notes.txt', 'nested/gamma-memo.md']);
  });

  test('limit caps the number of documents processed', async () => {
    const events: IngestionEvent[] = [];
    const source = new ArtifactBulkSource({ dir: CORPUS, limit: 1 });
    await source.start(recorderCtx(engine, events));
    expect(events.length).toBe(1);
  });
});

describe('T2 — ingest_bulk handler + submit_ingest op', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('ingest_bulk lands every corpus document as a retrievable artefact', async () => {
    const handler = makeIngestBulkHandler(engine as unknown as Parameters<typeof makeIngestBulkHandler>[0]);
    const job = {
      id: 1,
      name: 'ingest_bulk',
      data: { dir: CORPUS, scope: 'bulk-run', no_embed: true },
      signal: new AbortController().signal,
      updateProgress: async () => {},
    } as unknown as MinionJobContext;

    const res = (await handler(job)) as {
      walked: number;
      emitted: number;
      ingested: number;
      chunks: number;
      scope: string;
    };

    expect(res.scope).toBe('bulk-run');
    expect(res.emitted).toBe(3);
    expect(res.ingested).toBe(3);
    expect(res.chunks).toBeGreaterThanOrEqual(3);

    // Artefacts are materialised + retrievable by scope on job completion.
    const arts = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifacts WHERE source_id = 'bulk-run'`,
    );
    expect(arts[0]!.n).toBe(3);
    const chunkCount = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks cc
         JOIN artifacts a ON a.id = cc.artifact_id
        WHERE a.source_id = 'bulk-run' AND cc.page_id IS NULL`,
    );
    expect(chunkCount[0]!.n).toBe(res.chunks);
  });

  test('re-running ingest_bulk is idempotent (reuses artefacts, no duplication)', async () => {
    const handler = makeIngestBulkHandler(engine as unknown as Parameters<typeof makeIngestBulkHandler>[0]);
    const job = {
      id: 2,
      name: 'ingest_bulk',
      data: { dir: CORPUS, scope: 'bulk-run', no_embed: true },
      signal: new AbortController().signal,
      updateProgress: async () => {},
    } as unknown as MinionJobContext;

    const res = (await handler(job)) as { reused: number; ingested: number };
    expect(res.reused).toBe(3);
    expect(res.ingested).toBe(0);

    const arts = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifacts WHERE source_id = 'bulk-run'`,
    );
    expect(arts[0]!.n).toBe(3); // still 3 — no duplicates
  });

  test('submit_ingest op enqueues an ingest_bulk job and returns its id', async () => {
    const op = operationsByName['submit_ingest'];
    expect(op).toBeDefined();
    const ctx = { engine, remote: false, dryRun: false } as unknown as Parameters<typeof op.handler>[0];
    const job = (await op.handler(ctx, { dir: CORPUS, scope: 'op-run' })) as { id: number; name: string; data: Record<string, unknown> };
    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe('ingest_bulk');
    expect(job.data.dir).toBe(CORPUS);
    expect(job.data.source_id).toBe('op-run');
  });

  test('submit_ingest requires a dir', async () => {
    const op = operationsByName['submit_ingest'];
    const ctx = { engine, remote: false, dryRun: false } as unknown as Parameters<typeof op.handler>[0];
    await expect(op.handler(ctx, {})).rejects.toThrow(/dir/);
  });
});
