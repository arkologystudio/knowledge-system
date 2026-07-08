/**
 * ArtifactBulkSource — deterministic bulk-artefact importer (Knowledge System
 * T2).
 *
 * Walks a corpus directory, resolves a pluggable extractor per file, extracts
 * plain text, and emits one IngestionEvent per document tagged
 * `metadata.content_class = 'artifact'`. There is NO agent in the loop: each
 * document is extracted → (downstream) chunked → embedded → landed as a raw
 * artefact (T1 `artifacts` + artefact-scoped `content_chunks`).
 *
 * It implements the same `IngestionSource` contract as the daemon's built-in
 * sources (so it is daemon-registrable), and follows the established one-shot
 * migration-mode pattern from `markdown-greenfield.ts`:
 *
 *   - `mode: 'migration'` → the daemon bypasses the 24h trickle dedup window;
 *     permanent idempotency is owned downstream by `ingestArtifact` (dedup on
 *     source_id + content_hash).
 *   - The primary driver is NOT the long-lived daemon but the `submit_ingest`
 *     op → `ingest_bulk` Minion handler, which runs the source once with a
 *     dispatcher that calls `ingestArtifact` per emitted event.
 *
 * Per-file extraction failures are audited (JSONL) and skipped — one bad
 * document never fails the whole corpus.
 */

import { readFileSync, readdirSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { computeContentHash } from '../types.ts';
import type {
  IngestionSource,
  IngestionSourceContext,
  IngestionEvent,
  IngestionContentType,
  IngestionSourceMode,
  IngestionSourceHealth,
} from '../types.ts';
import { INGESTION_CONTENT_TYPES } from '../types.ts';
import { resolveExtractor, PlainTextExtractor } from '../../artifact/extractors.ts';

export interface ArtifactBulkOpts {
  /** Corpus root directory to walk. Required. */
  dir: string;
  /** Source scope for the landed artefacts. Defaults to 'default'. */
  sourceId?: string;
  /** Preferred extractor name (e.g. 'unstructured'). Omit → per-extension
   *  resolution with the lean `plaintext` fallback. */
  extractor?: string;
  /** Artefact `kind` discriminator stamped on every document. Default 'document'. */
  kind?: string;
  /** File extensions (incl. dot) to include. Defaults to the text formats the
   *  lean baseline can read without off-box tooling. */
  extensions?: string[];
  /** Cap total documents processed (staged testing). */
  limit?: number;
  /** Walk + extract but don't emit (dry-run count). */
  dryRun?: boolean;
  /** Audit JSONL output dir. Default ~/.gbrain/audit. */
  auditDir?: string;
  // ── test seams ──
  _readdirSync?: (path: string) => string[];
  _statSync?: (path: string) => { isDirectory(): boolean; isFile(): boolean };
  _readFile?: (path: string) => string;
  _appendFileSync?: (path: string, content: string) => void;
}

export interface ArtifactBulkStats {
  emitted: number;
  skipped_failed: number;
  total_walked: number;
}

const DEFAULT_TEXT_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.text', '.html', '.htm', '.json'];

export class ArtifactBulkSource implements IngestionSource {
  readonly id: string;
  readonly kind = 'artifact-bulk';
  readonly mode: IngestionSourceMode = 'migration';

  private readonly dir: string;
  private readonly sourceId: string;
  private readonly extractorName?: string;
  private readonly artifactKind: string;
  private readonly extensions: string[];
  private readonly limit?: number;
  private readonly dryRun: boolean;
  private readonly auditDir: string;
  private readonly _readdirSync: (path: string) => string[];
  private readonly _statSync: (path: string) => { isDirectory(): boolean; isFile(): boolean };
  private readonly _readFile?: (path: string) => string;
  private readonly _appendFileSync: (path: string, content: string) => void;

  private ctx: IngestionSourceContext | null = null;
  private _stats: ArtifactBulkStats = { emitted: 0, skipped_failed: 0, total_walked: 0 };

  constructor(opts: ArtifactBulkOpts) {
    this.id = `artifact-bulk:${opts.sourceId ?? 'default'}:${opts.dir}`;
    this.dir = opts.dir;
    this.sourceId = opts.sourceId ?? 'default';
    this.extractorName = opts.extractor;
    this.artifactKind = opts.kind ?? 'document';
    this.extensions = (opts.extensions ?? DEFAULT_TEXT_EXTENSIONS).map((e) => e.toLowerCase());
    this.limit = opts.limit;
    this.dryRun = opts.dryRun ?? false;
    this.auditDir = opts.auditDir ?? join(homedir(), '.gbrain', 'audit');
    this._readdirSync = opts._readdirSync ?? ((p) => readdirSync(p));
    this._statSync = opts._statSync ?? ((p) => statSync(p));
    this._readFile = opts._readFile;
    this._appendFileSync =
      opts._appendFileSync ??
      ((p, c) => {
        try {
          mkdirSync(dirname(p), { recursive: true });
        } catch {
          /* dir likely exists */
        }
        appendFileSync(p, c);
      });
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    this.ctx = ctx;
    if (!existsSync(this.dir)) {
      throw new Error(`ArtifactBulkSource: corpus dir does not exist: ${this.dir}`);
    }

    const files = this.walkFiles();
    ctx.logger.info(`[artifact-bulk] discovered ${files.length} file(s) under ${this.dir}`);

    let processed = 0;
    for (const path of files) {
      if (this.limit !== undefined && processed >= this.limit) break;
      this._stats.total_walked++;
      processed++;
      try {
        const event = await this.processFile(path);
        if (!this.dryRun) ctx.emit(event);
        this._stats.emitted++;
      } catch (err) {
        this._stats.skipped_failed++;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`[artifact-bulk] skipped ${path}: ${msg}`);
        this.appendFailureAudit(path, msg);
      }
    }

    ctx.logger.info(
      `[artifact-bulk] done: ${this._stats.emitted} emitted, ` +
        `${this._stats.skipped_failed} failed, ${this._stats.total_walked} walked`,
    );
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async healthCheck(): Promise<IngestionSourceHealth> {
    const total = this._stats.emitted + this._stats.skipped_failed;
    if (this._stats.skipped_failed > 0) {
      return {
        status: 'warn',
        message: `${this._stats.skipped_failed}/${total} document(s) failed extraction; check audit log`,
      };
    }
    if (total === 0 && !this.ctx) return { status: 'warn', message: 'not yet started' };
    return { status: 'ok', message: `${this._stats.emitted}/${total} emitted cleanly` };
  }

  get stats(): ArtifactBulkStats {
    return { ...this._stats };
  }

  /** Deterministic recursive walk, filtered by the include-extension set. */
  private walkFiles(): string[] {
    const out: string[] = [];
    this.walkRecursive(this.dir, out);
    out.sort();
    return out;
  }

  private walkRecursive(dir: string, out: string[]): void {
    let entries: string[];
    try {
      entries = this._readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: { isDirectory(): boolean; isFile(): boolean };
      try {
        stat = this._statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        this.walkRecursive(full, out);
      } else if (stat.isFile() && this.extensions.includes(extname(entry).toLowerCase())) {
        out.push(full);
      }
    }
  }

  /** Extract one file into an artefact-tagged IngestionEvent. */
  private async processFile(path: string): Promise<IngestionEvent> {
    const ext = extname(path).toLowerCase();
    const extractor = resolveExtractor(ext, this.extractorName);
    // Honour the test-seam file reader for the default text extractor so unit
    // tests can drive extraction without touching disk.
    const effective =
      this._readFile && extractor.name === 'plaintext'
        ? new PlainTextExtractor(this._readFile)
        : extractor;

    const extracted = await effective.extract({ path, ext, uri: `file://${path}` });
    const contentType = normaliseContentType(extracted.contentType);

    return {
      source_id: this.id,
      source_kind: this.kind,
      source_uri: `file://${path}`,
      received_at: new Date().toISOString(),
      content_type: contentType,
      content: extracted.text,
      content_hash: computeContentHash(extracted.text),
      // local corpus, operator-initiated bulk import → trusted payload
      untrusted_payload: false,
      metadata: {
        // The discriminator the bulk driver keys on to land an ARTEFACT
        // (not a page). A future daemon-side dispatch branch reads the same key.
        content_class: 'artifact',
        artifact_kind: this.artifactKind,
        source_id: this.sourceId,
        title: extracted.title,
        uri: `file://${path}`,
        original_path: relative(this.dir, path),
        extractor: effective.name,
        ...(extracted.meta ? { extractor_meta: extracted.meta } : {}),
      },
    };
  }

  private appendFailureAudit(path: string, errMsg: string): void {
    const week = isoWeekString(new Date());
    const auditPath = join(this.auditDir, `artifact-bulk-failures-${week}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      path,
      error: errMsg,
      importer: 'artifact-bulk',
    });
    try {
      this._appendFileSync(auditPath, line + '\n');
    } catch (err) {
      if (this.ctx) {
        this.ctx.logger.warn(
          `[artifact-bulk] audit write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/** Coerce an extractor content-type to the closed ingestion taxonomy. */
function normaliseContentType(ct: string): IngestionContentType {
  if ((INGESTION_CONTENT_TYPES as readonly string[]).includes(ct)) {
    return ct as IngestionContentType;
  }
  return 'text/plain';
}

function isoWeekString(d: Date): string {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((+target - +yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
