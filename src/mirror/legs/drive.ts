/**
 * Google Drive source leg.
 *
 * Google Docs export natively to markdown; born-digital binaries (PDF, DOCX, …)
 * are downloaded, text-extracted, and represented as a markdown stub carrying the
 * extracted text plus a link back to the retained Drive original — **the binary
 * itself is never committed**. Non-extractable media (images, video, unknown
 * types) get a reference stub only. Extraction reuses the engine's shipped
 * extractor registry (`resolveExtractor`), so PDF/DOCX handling rides the same
 * off-box service the artefact importer uses rather than a new dependency.
 *
 * The impure Drive access (rclone + credentials) sits behind `DriveBackend`, so
 * every classification/assembly path is unit-tested on fixtures; the real rclone
 * backend is exercised in CI / the human real-material run (credentials are a
 * human-provisioned step — never minted here).
 *
 * Design: source-mirror-pattern.md (Drive leg = rclone).
 */
import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import {
  ExtractorUnavailableError,
  resolveExtractor,
  type ArtifactExtractor,
} from '../../core/artifact/extractors';
import { sha256Hex } from '../hash';
import { registerLeg, type LegConfig } from '../registry';
import type { MirrorSource, SourceObject } from '../types';

/** One Drive object's metadata, as surfaced by `rclone lsjson` (files only). */
export interface DriveEntry {
  /** Stable Drive file id — identity (`orn:google_drive.file:<id>`). */
  id: string;
  /** rclone path within the remote, used for fetch operations. */
  path: string;
  /** Display name. */
  name: string;
  /** ISO-8601 last-modified time. */
  modTime: string;
  /** Drive MIME type. */
  mimeType: string;
}

/** The impure Drive surface. Real impl shells to rclone; tests supply a fake. */
export interface DriveBackend {
  /** Enumerate the curated subtree (recursive, files only). FULL set each call. */
  list(): Promise<DriveEntry[]>;
  /** Export a Google Doc to markdown. */
  exportMarkdown(entry: DriveEntry): Promise<string>;
  /** Download a binary file's raw bytes. */
  download(entry: DriveEntry): Promise<Uint8Array>;
}

/** Extractor selection seam (defaults to the engine registry). */
export type ExtractorResolver = (ext: string) => ArtifactExtractor;

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps';
/** Extensions the lean plaintext extractor may safely handle (everything else needs a real extractor). */
const TEXT_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.html', '.htm']);

function isMedia(mimeType: string): boolean {
  return /^(image|video|audio)\//.test(mimeType);
}

/** Pick an extractor for a binary, or null when none should run (media / unknown → reference stub). */
function pickExtractor(resolver: ExtractorResolver, ext: string): ArtifactExtractor | null {
  const chosen = resolver(ext);
  if (chosen.name !== 'plaintext') return chosen; // a real document extractor (pdf/docx/…)
  if (TEXT_EXTS.has(ext.toLowerCase())) return chosen; // genuinely textual
  return null; // plaintext on binary bytes = garbage; stub instead
}

/** A minimal markdown body for content that isn't extracted inline. */
function referenceStub(reason: string): string {
  return `> Binary source not extracted inline (${reason}). Open the original in Google Drive via the \`source_url\` in this file's frontmatter.\n`;
}

export interface DriveLegOptions {
  id?: string;
  backend: DriveBackend;
  resolveExtractor?: ExtractorResolver;
}

export class DriveLeg implements MirrorSource {
  readonly id: string;
  readonly namespace = 'google_drive.file' as const;
  private readonly backend: DriveBackend;
  private readonly resolver: ExtractorResolver;

  constructor(opts: DriveLegOptions) {
    this.id = opts.id ?? 'drive';
    this.backend = opts.backend;
    this.resolver = opts.resolveExtractor ?? ((ext: string) => resolveExtractor(ext));
  }

  async *list(): AsyncIterable<SourceObject> {
    const entries = await this.backend.list();
    for (const entry of entries) {
      yield await this.toObject(entry);
    }
  }

  /** Map one Drive entry to a normalised SourceObject, handling the three content tiers. */
  private async toObject(entry: DriveEntry): Promise<SourceObject> {
    const base = { upstreamId: entry.id, title: entry.name, upstreamMtime: entry.modTime };

    // Tier 1: Google Docs export natively to markdown.
    if (entry.mimeType === GOOGLE_DOC) {
      return { ...base, body: await this.backend.exportMarkdown(entry) };
    }
    // Other Google-native types (Sheets/Slides/…) — reference stub in v1.
    if (entry.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
      return { ...base, body: referenceStub('Google-native, non-document') };
    }
    // Media — reference stub, no download.
    if (isMedia(entry.mimeType)) {
      return { ...base, body: referenceStub(entry.mimeType) };
    }

    // Tier 2: born-digital binary — download, extract, stub-with-text + provenance.
    const ext = extname(entry.name).toLowerCase();
    const extractor = pickExtractor(this.resolver, ext);
    if (!extractor) {
      return { ...base, body: referenceStub(`no extractor for ${ext || 'unknown type'}`) };
    }
    try {
      const bytes = await this.backend.download(entry);
      const extracted = await extractor.extract({ bytes, ext, uri: entry.path });
      const version = typeof extracted.meta?.version === 'string' ? `@${extracted.meta.version}` : '';
      return {
        ...base,
        body: extracted.text,
        originalSha256: sha256Hex(bytes),
        extractor: `${extractor.name}${version}`,
      };
    } catch (err) {
      // Tier 3: extraction unavailable or failed for THIS file — reference stub,
      // never fail the whole leg (matches the artefact importer's per-file skip).
      const reason =
        err instanceof ExtractorUnavailableError ? 'extractor unavailable' : 'extraction failed';
      return { ...base, body: referenceStub(reason) };
    }
  }
}

/**
 * Production Drive backend: shells to `rclone`. Requires an rclone remote whose
 * OAuth refresh token was provisioned by a human (`rclone config`) — never here.
 * Not unit-tested (no credentials in CI); exercised by the runner + the human
 * real-material run.
 */
export class RcloneBackend implements DriveBackend {
  constructor(
    private readonly remote: string,
    private readonly folder: string,
  ) {}

  private target(sub = ''): string {
    const base = `${this.remote}:${this.folder}`;
    return sub ? `${base}/${sub}` : base;
  }

  async list(): Promise<DriveEntry[]> {
    const out = execFileSync('rclone', ['lsjson', this.target(), '--recursive', '--files-only'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows = JSON.parse(out) as Array<{
      ID?: string;
      Path: string;
      Name: string;
      ModTime: string;
      MimeType: string;
    }>;
    return rows
      .filter(r => r.ID)
      .map(r => ({
        id: r.ID as string,
        path: r.Path,
        name: r.Name,
        modTime: r.ModTime,
        mimeType: r.MimeType,
      }));
  }

  async exportMarkdown(entry: DriveEntry): Promise<string> {
    return execFileSync('rclone', ['cat', this.target(entry.path), '--drive-export-formats', 'md'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  async download(entry: DriveEntry): Promise<Uint8Array> {
    return new Uint8Array(
      execFileSync('rclone', ['cat', this.target(entry.path)], { maxBuffer: 256 * 1024 * 1024 }),
    );
  }
}

/** Build a DriveLeg from config. `remote` + `folder` name the rclone target. */
export function buildDriveLeg(config: LegConfig): MirrorSource {
  const remote = String(config.remote ?? '');
  const folder = String(config.folder ?? '');
  if (!remote) throw new Error('google_drive leg: config.remote is required (the rclone remote name).');
  return new DriveLeg({
    id: typeof config.id === 'string' ? config.id : undefined,
    backend: new RcloneBackend(remote, folder),
  });
}

registerLeg('google_drive', buildDriveLeg);
