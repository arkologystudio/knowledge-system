/**
 * `ingestArtifact` — the deterministic bulk-ingestion keystone (Knowledge
 * System T2).
 *
 * Lands ONE raw document into the T1 artefact class with NO agent in the loop:
 *
 *   1. upsert an `artifacts` row (source_id-scoped, dedup on content_hash),
 *   2. chunk the extracted text with the SAME recursive chunker the page path
 *      uses (`chunkers/recursive.ts` — no new chunker invented),
 *   3. embed @1536 (fork F2) via the shared `embedBatch` (injectable for tests),
 *   4. write artefact-scoped `content_chunks` (`page_id = NULL`, `artifact_id`
 *      set) — the XOR shape T1's migration v123 enforces.
 *
 * It is the artefact analogue of `importFromContent`, but deliberately does NOT
 * create a page: raw artefacts are a separate content class that T1 decoupled
 * from `pages` precisely so corpus-scale documents can be embedded + stored
 * without an authored page per document.
 *
 * Engine-portable: goes through `engine.executeRaw` / `executeRawJsonb` (the
 * `$N::vector` + `$N::jsonb` bindings both PGLite and Postgres accept), so it
 * needs no per-engine method and adds no surface to the BrainEngine contract.
 *
 * Idempotent: re-ingesting the same (source_id, content_hash) reuses the
 * existing artefact row and replaces its chunks — the property the bulk source
 * relies on for safe replay (migration-mode sources own permanent idempotency).
 */

import type { BrainEngine } from '../engine.ts';
import { chunkText } from '../chunkers/recursive.ts';
import { computeContentHash } from '../ingestion/types.ts';
import { embedBatch, EMBEDDING_MODEL } from '../embedding.ts';
import { executeRawJsonb } from '../sql-query.ts';

/** One raw document to land as an artefact. */
export interface ArtifactInput {
  /** Extracted plain text to chunk + embed. Required, non-empty. */
  content: string;
  /** Artefact class discriminator (document, transcript, pdf, webpage, …). */
  kind?: string;
  /** Human title, if known. */
  title?: string | null;
  /** External location / source reference (file://…, https://…). */
  uri?: string | null;
  /** Revision key for the same uri (change detection). */
  revisionId?: string | null;
  /** Source scope. Defaults to 'default'. Isolates artefacts per source. */
  sourceId?: string;
  /** Where it came from + extractor metadata. Persisted to `provenance` JSONB. */
  provenance?: Record<string, unknown>;
  /** Remote-redaction marker. 'private' (default) or 'world'. */
  visibility?: 'private' | 'world';
  /** Pre-computed SHA-256 of `content` (skips recompute). */
  contentHash?: string;
}

export interface IngestArtifactResult {
  artifact_id: number;
  object_id: string;
  /** Number of chunks written. */
  chunks: number;
  /** Whether embeddings were computed + stored on the chunks. */
  embedded: boolean;
  /** True when an existing artefact with the same (source_id, content_hash)
   *  was reused (chunks replaced) rather than a fresh row inserted. */
  reused: boolean;
  status: 'ingested' | 'reused' | 'skipped';
}

export interface IngestArtifactOpts {
  /** Skip the embedding call; chunks land with NULL embedding for a later
   *  `embed --stale` pass. Mirrors importFromContent's noEmbed default posture. */
  noEmbed?: boolean;
  /** Test / alternative-provider seam. Defaults to the shared `embedBatch`
   *  (@1536, fork F2). */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  /** Embedding model name stamped on chunks. Defaults to the @1536 model. */
  model?: string;
}

interface ChunkRow {
  chunk_index: number;
  chunk_text: string;
  embedding?: Float32Array;
}

/**
 * Land one document as an artefact + artefact-scoped chunks. Deterministic;
 * no LLM call beyond the (deterministic-per-input) embedding.
 */
export async function ingestArtifact(
  engine: BrainEngine,
  input: ArtifactInput,
  opts: IngestArtifactOpts = {},
): Promise<IngestArtifactResult> {
  const content = input.content ?? '';
  const sourceId = input.sourceId ?? 'default';

  if (content.trim().length === 0) {
    return {
      artifact_id: 0,
      object_id: '',
      chunks: 0,
      embedded: false,
      reused: false,
      status: 'skipped',
    };
  }

  const hash = input.contentHash ?? computeContentHash(content);
  const kind = input.kind ?? 'document';
  const title = input.title ?? null;
  const uri = input.uri ?? null;
  const revisionId = input.revisionId ?? null;
  const visibility = input.visibility ?? 'private';
  const provenance = input.provenance ?? {};

  // 0. Ensure the scope exists — `artifacts.source_id` FKs `sources(id)` (T1
  //    migration v123). Bulk ingestion into a fresh scope provisions it here so
  //    the operator doesn't have to `sources add` first; idempotent + reversible
  //    (the scope can be removed later). ON CONFLICT keeps replays cheap.
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );

  // 1. Upsert the artefact row (dedup on source_id + content_hash).
  const existing = await engine.executeRaw<{ id: number; object_id: string }>(
    `SELECT id, object_id FROM artifacts
      WHERE source_id = $1 AND content_hash = $2
      ORDER BY id LIMIT 1`,
    [sourceId, hash],
  );

  let artifactId: number;
  let objectId: string;
  let reused: boolean;

  if (existing.length > 0) {
    artifactId = existing[0]!.id;
    objectId = existing[0]!.object_id;
    reused = true;
    // Refresh mutable fields (title/uri/revision/content/provenance) + updated_at.
    // provenance is the sole JSONB param → goes last so scalars stay $1..$N.
    await executeRawJsonb(
      engine,
      `UPDATE artifacts
          SET kind = $1, title = $2, uri = $3, revision_id = $4,
              content = $5, visibility = $6, updated_at = now(),
              provenance = $8::jsonb
        WHERE id = $7`,
      [kind, title, uri, revisionId, content, visibility, artifactId],
      [provenance],
    );
  } else {
    reused = false;
    // provenance is the sole JSONB param → placed last ($9::jsonb) so the
    // scalars occupy $1..$8 (executeRawJsonb appends jsonb params after
    // scalars). Never JSON.stringify into ::jsonb (CLAUDE.md invariant).
    const inserted = await executeRawJsonb<{ id: number; object_id: string }>(
      engine,
      `INSERT INTO artifacts
         (source_id, kind, title, uri, revision_id, content, content_hash, visibility, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id, object_id`,
      [sourceId, kind, title, uri, revisionId, content, hash, visibility],
      [provenance],
    );
    artifactId = inserted[0]!.id;
    objectId = inserted[0]!.object_id;
  }

  // 2. Chunk with the shared recursive chunker (same as the page path).
  const chunks: ChunkRow[] = chunkText(content).map((c, i) => ({
    chunk_index: i,
    chunk_text: c.text,
  }));

  // 3. Embed @1536 (fork F2), unless the caller defers embedding.
  const embedFn = opts.embed ?? embedBatch;
  let embedded = false;
  if (!opts.noEmbed && chunks.length > 0) {
    const vectors = await embedFn(chunks.map((c) => c.chunk_text));
    for (let i = 0; i < chunks.length; i++) chunks[i]!.embedding = vectors[i];
    embedded = vectors.length === chunks.length && vectors.every((v) => v != null);
  }

  // 4. Replace the artefact's chunk set (clean slate → plain INSERT, no
  //    ON CONFLICT dance against the partial unique index).
  await engine.executeRaw(`DELETE FROM content_chunks WHERE artifact_id = $1`, [artifactId]);

  if (chunks.length > 0) {
    await insertArtifactChunks(engine, artifactId, chunks, opts.model ?? EMBEDDING_MODEL);
  }

  return {
    artifact_id: artifactId,
    object_id: objectId,
    chunks: chunks.length,
    embedded,
    reused,
    status: reused ? 'reused' : 'ingested',
  };
}

/**
 * Build + run one multi-row INSERT of artefact-scoped chunks. `page_id` is
 * omitted (NULL) so the page-XOR-artefact CHECK is satisfied on the artefact
 * side. Embeddings bind as `$N::vector` — the exact spelling both engines
 * accept (mirrors `_upsertChunksOnce`); NULL embeddings inline a NULL literal.
 * `search_vector` is a generated column, so it is intentionally not written.
 */
async function insertArtifactChunks(
  engine: BrainEngine,
  artifactId: number,
  chunks: ChunkRow[],
  model: string,
): Promise<void> {
  const cols =
    '(artifact_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at, modality)';
  const rows: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  for (const chunk of chunks) {
    const embeddingStr = chunk.embedding
      ? '[' + Array.from(chunk.embedding).join(',') + ']'
      : null;
    const embeddingPh = embeddingStr ? `$${p++}::vector` : 'NULL';
    const embeddedAtPh = embeddingStr ? 'now()' : 'NULL';
    const tokenCount = Math.ceil(chunk.chunk_text.length / 4);

    // chunk_source 'compiled_truth' is the generic text bucket (same value the
    // page path uses for body prose). modality 'text' matches the column default.
    rows.push(
      `($${p++}, $${p++}, $${p++}, 'compiled_truth', ${embeddingPh}, $${p++}, $${p++}, ${embeddedAtPh}, 'text')`,
    );

    if (embeddingStr) params.push(embeddingStr);
    params.push(artifactId, chunk.chunk_index, chunk.chunk_text, model, tokenCount);
  }

  await engine.executeRaw(
    `INSERT INTO content_chunks ${cols} VALUES ${rows.join(', ')}`,
    params,
  );
}
