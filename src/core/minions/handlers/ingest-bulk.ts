/**
 * `ingest_bulk` Minion job handler (Knowledge System T2).
 *
 * The deterministic bulk-artefact pipeline, driven end-to-end by one job. The
 * `submit_ingest` op enqueues this handler with a corpus descriptor; here we:
 *
 *   1. build an `ArtifactBulkSource` from the job payload,
 *   2. run it ONCE with a recording context (the established one-shot
 *      migration-source driver — the daemon supervises trickle sources, a job
 *      drives bulk ones), collecting one IngestionEvent per document,
 *   3. land each event as a raw artefact via `ingestArtifact`
 *      (extract → chunk → embed @1536 → artefact-scoped chunks), with NO agent
 *      in the loop.
 *
 * Idempotent + resumable-safe: `ingestArtifact` dedups on
 * (source_id, content_hash), so re-running the job over the same corpus reuses
 * artefacts and replaces their chunks rather than duplicating.
 */

import type { MinionJobContext } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { Logger } from '../../operations.ts';
import type { IngestionEvent, IngestionSourceContext } from '../../ingestion/types.ts';
import { ArtifactBulkSource } from '../../ingestion/sources/artifact-bulk.ts';
import { ingestArtifact } from '../../artifact/ingest-artifact.ts';

export interface IngestBulkResult {
  scope: string;
  dir: string;
  walked: number;
  emitted: number;
  extraction_failed: number;
  ingested: number;
  reused: number;
  chunks: number;
  embedded: boolean;
  dry_run: boolean;
}

/** Minimal stderr logger for the source's IngestionSourceContext. */
function stderrLogger(prefix: string): Logger {
  return {
    info: (m: string) => process.stderr.write(`[${prefix}] ${m}\n`),
    warn: (m: string) => process.stderr.write(`[${prefix}] WARN ${m}\n`),
    error: (m: string) => process.stderr.write(`[${prefix}] ERROR ${m}\n`),
  };
}

export function makeIngestBulkHandler(engine: BrainEngine) {
  return async function ingestBulkHandler(job: MinionJobContext): Promise<IngestBulkResult> {
    const data = job.data as {
      dir?: unknown;
      source?: unknown; // alias for scope/source_id
      scope?: unknown;
      source_id?: unknown;
      extractor?: unknown;
      kind?: unknown;
      extensions?: unknown;
      limit?: unknown;
      dry_run?: unknown;
      no_embed?: unknown;
    };

    const dir = typeof data.dir === 'string' ? data.dir : '';
    if (!dir) throw new Error('ingest_bulk: job.data.dir (corpus directory) is required');

    // Scope resolution: explicit source_id > scope > source > 'default'.
    const scope =
      (typeof data.source_id === 'string' && data.source_id) ||
      (typeof data.scope === 'string' && data.scope) ||
      (typeof data.source === 'string' && data.source) ||
      'default';

    const dryRun = data.dry_run === true;
    const noEmbed = data.no_embed === true;

    const source = new ArtifactBulkSource({
      dir,
      sourceId: scope,
      extractor: typeof data.extractor === 'string' ? data.extractor : undefined,
      kind: typeof data.kind === 'string' ? data.kind : undefined,
      extensions: Array.isArray(data.extensions)
        ? (data.extensions as unknown[]).filter((e): e is string => typeof e === 'string')
        : undefined,
      limit: typeof data.limit === 'number' ? data.limit : undefined,
      dryRun,
    });

    // Run the source ONCE with a recording context. emit() is synchronous here
    // (we own the context), so every event is captured by the time start()
    // resolves — no microtask race like the production daemon's fire-and-forget.
    const events: IngestionEvent[] = [];
    const ctx: IngestionSourceContext = {
      emit: (event: IngestionEvent) => {
        events.push(event);
      },
      engine,
      logger: stderrLogger('ingest_bulk'),
      abortSignal: job.signal,
      config: {},
    };

    await source.start(ctx);
    const stats = source.stats;

    let ingested = 0;
    let reused = 0;
    let chunks = 0;
    let embeddedAny = false;

    if (!dryRun) {
      for (let i = 0; i < events.length; i++) {
        if (job.signal.aborted) break;
        const event = events[i]!;
        const meta = (event.metadata ?? {}) as Record<string, unknown>;
        const res = await ingestArtifact(
          engine,
          {
            content: event.content,
            contentHash: event.content_hash,
            kind: typeof meta.artifact_kind === 'string' ? meta.artifact_kind : 'document',
            title: typeof meta.title === 'string' ? meta.title : null,
            uri: typeof meta.uri === 'string' ? meta.uri : event.source_uri,
            sourceId: typeof meta.source_id === 'string' ? meta.source_id : scope,
            provenance: {
              source_kind: event.source_kind,
              source_uri: event.source_uri,
              content_type: event.content_type,
              extractor: meta.extractor ?? null,
              original_path: meta.original_path ?? null,
              ingested_via: 'ingest_bulk',
            },
          },
          { noEmbed },
        );
        if (res.status === 'reused') reused++;
        else if (res.status === 'ingested') ingested++;
        chunks += res.chunks;
        embeddedAny = embeddedAny || res.embedded;

        await job.updateProgress({ phase: 'ingest_bulk.artifacts', done: i + 1, total: events.length });
      }
    }

    return {
      scope,
      dir,
      walked: stats.total_walked,
      emitted: stats.emitted,
      extraction_failed: stats.skipped_failed,
      ingested,
      reused,
      chunks,
      embedded: embeddedAny,
      dry_run: dryRun,
    };
  };
}
