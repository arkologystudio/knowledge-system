/**
 * Path derivation + the load-bearing allowlist guard.
 *
 * THE invariant of the whole mirror: it writes ONLY under `sources/`. A mirror
 * defect can corrupt mirrored material — which is reproducible from upstream —
 * but must never reach authored thinking under `wiki/`. That guarantee lives in
 * CODE here, not in documentation (matching the shared-tooling safety pattern).
 */
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { MirrorSource, SourceObject } from './types';

/** The one directory the mirror is allowed to write beneath, repo-relative. */
export const SOURCES_ROOT = 'sources';

/**
 * Turn a title into a safe, readable path segment.
 *
 * Lowercases, then maps EVERY non-alphanumeric byte (including `/`, `.`, `\`,
 * control bytes, and bidi overrides) to a single dash — so nothing that could
 * escape or spoof a directory survives — then trims and caps the length.
 * Returns `untitled` for an empty result so a path is always derivable.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

/** First 8 hex chars of sha256(upstreamId) — a deterministic, collision-safe disambiguator. */
export function shortId(upstreamId: string): string {
  return createHash('sha256').update(upstreamId, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Deterministic repo-relative path for a mirrored object:
 *   sources/<leg>/<slug>-<shortid>.md
 *
 * Readable (slug), unique (shortid over the upstream id), and stable per object
 * except on rename — a rename changes the slug and the harness records that as a
 * MOVE keyed on the unchanged RID, so inbound references never break.
 */
export function objectToPath(leg: MirrorSource, obj: SourceObject): string {
  const name = `${slugify(obj.title)}-${shortId(obj.upstreamId)}.md`;
  return `${SOURCES_ROOT}/${leg.id}/${name}`;
}

/**
 * Assert that `repoRelativePath` resolves to a location strictly under
 * `<repoRoot>/sources/`. Throws otherwise. This is the enforcement point — every
 * write path passes through here before the harness touches the filesystem.
 *
 * Resolution is lexical against an absolute repo root (no filesystem access, so
 * it is safe to call before the file exists). A leading `/`, a `..` segment, or
 * any other trick that lands outside `sources/` is refused.
 */
export function assertUnderSources(repoRoot: string, repoRelativePath: string): string {
  const root = resolve(repoRoot);
  const sourcesRoot = resolve(root, SOURCES_ROOT);
  const target = resolve(root, repoRelativePath);
  const prefix = sourcesRoot + sep;
  if (target !== sourcesRoot && !target.startsWith(prefix)) {
    throw new Error(
      `Source Mirror allowlist violation: refusing to write "${repoRelativePath}" — ` +
        `resolves to "${target}", outside the permitted "${sourcesRoot}${sep}".`,
    );
  }
  return target;
}
