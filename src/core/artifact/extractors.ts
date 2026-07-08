/**
 * Pluggable artefact extractors (Knowledge System T2).
 *
 * An extractor turns a raw document (a file on disk, or in-memory bytes) into
 * plain text + light metadata that the deterministic bulk-ingestion pipeline
 * (`ingestArtifact`) chunks and embeds. The registry is deliberately small and
 * lazy so the LEAN baseline stays lean:
 *
 *   - `PlainTextExtractor` (default) handles the text formats a bun/TS process
 *     can read with ZERO extra dependencies — markdown, plain text, html, json.
 *     This is the fork's F5 "lean baseline": no `unstructured`, no native libs.
 *
 *   - `UnstructuredExtractor` is the OPT-IN heavy path for PDFs / office docs /
 *     scans. Per fork decision F5 the `unstructured` toolchain runs OFF-BOX
 *     (a sidecar HTTP service), never bundled into this process. When it's
 *     selected but not configured, `extract` throws a paste-ready error telling
 *     the operator how to point at the off-box service — it never silently
 *     degrades or pulls a giant dependency into the baseline install.
 *
 * Third parties add formats by implementing `ArtifactExtractor` and registering
 * it via `registerExtractor` (e.g. from a skillpack). The bulk source resolves
 * an extractor per file through `resolveExtractor`.
 */

import { extname } from 'node:path';

/** What an extractor produces from one raw document. */
export interface ExtractedArtifact {
  /** Plain-text body to chunk + embed. Never empty on success. */
  text: string;
  /** Human title, if the extractor could derive one (else null). */
  title: string | null;
  /** Canonical content type the extractor recognised the input as. */
  contentType: string;
  /** Free-form extractor telemetry, folded into the artefact's provenance. */
  meta?: Record<string, unknown>;
}

/** Raw input handed to an extractor. Exactly one of `path` / `bytes` is set. */
export interface ExtractorInput {
  /** Absolute path to the source document (file-backed sources). */
  path?: string;
  /** In-memory bytes (network / stream sources). */
  bytes?: Uint8Array;
  /** Original file extension incl. dot (e.g. `.pdf`), lower-cased. Derived
   *  from `path` when omitted. */
  ext?: string;
  /** Provenance URI carried onto the artefact (file://…, https://…). */
  uri?: string;
}

/**
 * Pluggable extractor contract. Built-in and skillpack extractors implement
 * the same shape — there are no special code paths for built-ins.
 */
export interface ArtifactExtractor {
  /** Stable extractor id (also the value operators pass as `extractor`). */
  readonly name: string;
  /** File extensions (incl. dot, lower-case) this extractor claims by default. */
  readonly extensions: readonly string[];
  /** Whether this extractor can handle the given extension. */
  supports(ext: string): boolean;
  /** Extract text. MUST throw on unrecoverable failure (caller audits + skips). */
  extract(input: ExtractorInput): Promise<ExtractedArtifact>;
}

/** Thrown when a selected extractor cannot run (missing off-box service, etc.). */
export class ExtractorUnavailableError extends Error {
  constructor(
    public readonly extractor: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractorUnavailableError';
  }
}

const TEXT_EXT_TO_TYPE: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
};

/**
 * Zero-dependency default. Reads the document as UTF-8 text. Handles the
 * formats a plain bun/TS process can decode without native libraries. This is
 * the lean baseline the fork ships by default (F5).
 */
export class PlainTextExtractor implements ArtifactExtractor {
  readonly name = 'plaintext';
  readonly extensions = Object.keys(TEXT_EXT_TO_TYPE);

  /** Test seam: alternative file reader. */
  constructor(private readonly _readFile?: (path: string) => string) {}

  supports(ext: string): boolean {
    return this.extensions.includes(ext.toLowerCase());
  }

  async extract(input: ExtractorInput): Promise<ExtractedArtifact> {
    const ext = (input.ext ?? (input.path ? extname(input.path) : '')).toLowerCase();
    const contentType = TEXT_EXT_TO_TYPE[ext] ?? 'text/plain';

    let text: string;
    if (input.bytes) {
      text = new TextDecoder('utf-8').decode(input.bytes);
    } else if (input.path) {
      text = this._readFile
        ? this._readFile(input.path)
        : await Bun.file(input.path).text();
    } else {
      throw new Error('PlainTextExtractor: input has neither `path` nor `bytes`');
    }

    if (text.trim().length === 0) {
      throw new Error(
        `PlainTextExtractor: extracted empty text from ${input.path ?? input.uri ?? '<bytes>'}`,
      );
    }

    return {
      text,
      title: deriveTitle(text, input.path),
      contentType,
      meta: { extractor: 'plaintext', bytes: text.length },
    };
  }
}

/**
 * Opt-in heavy extractor for PDFs / office docs / scans. Runs the `unstructured`
 * toolchain OFF-BOX (fork F5) — this process only speaks HTTP to a sidecar. It
 * is NOT wired to a bundled binary on purpose: the baseline install stays lean.
 *
 * Selection is explicit (`extractor: 'unstructured'` or a claimed extension via
 * an operator override). When the sidecar URL is not configured, `extract`
 * throws `ExtractorUnavailableError` with the exact env var to set — never a
 * silent fallback that would land empty/garbage artefacts.
 */
export class UnstructuredExtractor implements ArtifactExtractor {
  readonly name = 'unstructured';
  readonly extensions = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.epub'] as const;

  constructor(
    private readonly opts: {
      /** Off-box service URL. Defaults to `GBRAIN_UNSTRUCTURED_URL` env. */
      serviceUrl?: string;
      /** Test seam: alternative fetch. */
      _fetch?: typeof fetch;
    } = {},
  ) {}

  supports(ext: string): boolean {
    return (this.extensions as readonly string[]).includes(ext.toLowerCase());
  }

  private resolveUrl(): string {
    const url = this.opts.serviceUrl ?? process.env.GBRAIN_UNSTRUCTURED_URL;
    if (!url || url.trim().length === 0) {
      throw new ExtractorUnavailableError(
        this.name,
        'unstructured extractor is off-box (fork F5) and not configured. Set ' +
          'GBRAIN_UNSTRUCTURED_URL to your unstructured-api sidecar (e.g. ' +
          'http://127.0.0.1:8000/general/v0/general), or pre-extract the document ' +
          'to text/markdown and ingest it with the default `plaintext` extractor.',
      );
    }
    return url.replace(/\/$/, '');
  }

  async extract(input: ExtractorInput): Promise<ExtractedArtifact> {
    const url = this.resolveUrl();
    const doFetch = this.opts._fetch ?? fetch;

    const bytes = input.bytes
      ? input.bytes
      : input.path
        ? new Uint8Array(await Bun.file(input.path).arrayBuffer())
        : null;
    if (!bytes) {
      throw new Error('UnstructuredExtractor: input has neither `path` nor `bytes`');
    }

    const form = new FormData();
    form.append('files', new Blob([bytes as BlobPart]), input.path?.split('/').pop() ?? 'document');

    const res = await doFetch(url, { method: 'POST', body: form });
    if (!res.ok) {
      throw new ExtractorUnavailableError(
        this.name,
        `unstructured sidecar returned ${res.status} ${res.statusText} from ${url}`,
      );
    }
    // unstructured returns an array of elements; concat their text.
    const elements = (await res.json()) as Array<{ text?: string }>;
    const text = elements
      .map((e) => (typeof e.text === 'string' ? e.text : ''))
      .filter((t) => t.length > 0)
      .join('\n\n');

    if (text.trim().length === 0) {
      throw new Error(
        `UnstructuredExtractor: sidecar produced no text for ${input.path ?? input.uri ?? '<bytes>'}`,
      );
    }

    const ext = (input.ext ?? (input.path ? extname(input.path) : '')).toLowerCase();
    return {
      text,
      title: deriveTitle(text, input.path),
      contentType: ext === '.pdf' ? 'application/pdf' : 'text/plain',
      meta: { extractor: 'unstructured', elements: elements.length },
    };
  }
}

/** First markdown heading, else first non-empty line, else the file basename. */
function deriveTitle(text: string, path?: string): string | null {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) return heading[1]!.trim().slice(0, 200);
    return line.slice(0, 200);
  }
  if (path) return path.split('/').pop() ?? null;
  return null;
}

// ── registry ──────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, ArtifactExtractor>();

/** Register (or replace) an extractor by name. Idempotent per name. */
export function registerExtractor(extractor: ArtifactExtractor): void {
  REGISTRY.set(extractor.name, extractor);
}

/** Look an extractor up by name. */
export function getExtractor(name: string): ArtifactExtractor | undefined {
  return REGISTRY.get(name);
}

/** All registered extractor names (for diagnostics / CLI help). */
export function listExtractors(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * Resolve the extractor to use for a file.
 *
 *   - explicit `preferred` name wins when registered;
 *   - otherwise the first registered extractor that `supports(ext)`;
 *   - otherwise the default `plaintext` extractor (the lean baseline).
 *
 * The lean-baseline fallback means an unknown extension is attempted as text
 * rather than skipped — cheap, and the text extractor throws on binary garbage
 * so the caller still audits + skips genuinely-unreadable files.
 */
export function resolveExtractor(ext: string, preferred?: string): ArtifactExtractor {
  if (preferred) {
    const chosen = REGISTRY.get(preferred);
    if (!chosen) {
      throw new Error(
        `Unknown extractor '${preferred}'. Registered: ${listExtractors().join(', ') || '(none)'}.`,
      );
    }
    return chosen;
  }
  const lower = ext.toLowerCase();
  for (const extractor of REGISTRY.values()) {
    if (extractor.name !== 'plaintext' && extractor.supports(lower)) return extractor;
  }
  return REGISTRY.get('plaintext') ?? new PlainTextExtractor();
}

// Register the built-ins at module load. `plaintext` is the lean default;
// `unstructured` is registered (so operators can select it) but stays inert
// until GBRAIN_UNSTRUCTURED_URL is set.
registerExtractor(new PlainTextExtractor());
registerExtractor(new UnstructuredExtractor());
