/**
 * Deterministic provenance frontmatter for mirrored files.
 *
 * Two hard requirements meet here:
 *  - **Provenance** (requirements 11/12): every mirrored file records where it
 *    came from, links back to the original, and — when derived from a binary —
 *    carries the original blob's hash plus the extractor's identity+version, so a
 *    better extractor later can change the derived text while the source's
 *    recorded identity holds steady.
 *  - **Idempotency** (requirement 8): running twice with no upstream change must
 *    produce a byte-identical file and therefore no commit. So the emitter is
 *    fully deterministic (fixed key order, every value JSON-quoted), and
 *    `mirrored_at` — the one wall-clock field — is EXCLUDED from the
 *    change-detection hash: it is refreshed only when other content changes, so
 *    an unchanged run leaves the existing file (and its `mirrored_at`) untouched.
 *
 * Identity + link-back reuse the shipped RID layer (`ridForExternal`,
 * `resolveLocators`) rather than re-deriving them — a second identity for the
 * same object is exactly the drift RIDs exist to prevent.
 */
import { ridForExternal, resolveLocators } from '../core/rid';
import { sha256Hex } from './hash';
import type { MirrorSource, SourceObject } from './types';

/** The RID for an object, minted from the leg's namespace + the upstream's stable id. */
export function ridFor(leg: MirrorSource, obj: SourceObject): string {
  return ridForExternal(leg.namespace, obj.upstreamId);
}

/** The system name for the `source` field, derived from the namespace (`google_drive.file` → `google_drive`). */
function systemName(namespace: string): string {
  const dot = namespace.indexOf('.');
  return dot === -1 ? namespace : namespace.slice(0, dot);
}

/** The external link-back URL for an object, via the shipped locator resolvers. */
function sourceUrl(rid: string, obj: SourceObject): string {
  const external = resolveLocators(rid).find(l => l.kind === 'external');
  if (external) return external.uri;
  return obj.extra?.source_url ?? '';
}

/**
 * The ordered provenance key/value pairs EXCLUDING `mirrored_at`. This ordered
 * list is what both the rendered frontmatter and the change-detection hash are
 * built from, so the two never drift.
 */
export function provenanceFields(leg: MirrorSource, obj: SourceObject): Array<[string, string]> {
  const rid = ridFor(leg, obj);
  const fields: Array<[string, string]> = [
    ['ref_id', rid],
    ['source', systemName(leg.namespace)],
    ['source_id', obj.upstreamId],
    ['source_url', sourceUrl(rid, obj)],
    ['upstream_mtime', obj.upstreamMtime],
  ];
  if (obj.originalSha256) fields.push(['original_sha256', obj.originalSha256]);
  if (obj.extractor) fields.push(['extractor', obj.extractor]);
  fields.push(['title', obj.title]);
  // Extra provenance is emitted last, sorted, namespaced so a leg can't shadow a
  // core key.
  if (obj.extra) {
    for (const k of Object.keys(obj.extra).sort()) {
      fields.push([`x_${k}`, obj.extra[k]]);
    }
  }
  return fields;
}

/** Emit one `key: "json-quoted-value"` line. JSON-quoting is valid YAML double-quote and injection-safe. */
function line(key: string, value: string): string {
  return `${key}: ${JSON.stringify(value)}`;
}

/** Normalise a body to a single trailing newline so idempotency doesn't hinge on upstream whitespace. */
function normaliseBody(body: string): string {
  return body.replace(/\s+$/, '') + '\n';
}

/**
 * The full file contents for a mirrored object, including `mirrored_at`.
 * `mirroredAt` is an ISO-8601 string set only when the harness decides to write.
 */
export function renderFile(leg: MirrorSource, obj: SourceObject, mirroredAt: string): string {
  const fields = provenanceFields(leg, obj);
  const lines = fields.map(([k, v]) => line(k, v));
  // Insert mirrored_at just before `title` for readability; it is cosmetic to the hash.
  const titleIdx = lines.findIndex(l => l.startsWith('title:'));
  const withStamp = [
    ...lines.slice(0, titleIdx),
    line('mirrored_at', mirroredAt),
    ...lines.slice(titleIdx),
  ];
  return `---\n${withStamp.join('\n')}\n---\n\n${normaliseBody(obj.body)}`;
}

/**
 * The change-detection hash: covers the significant provenance fields (NOT
 * `mirrored_at`) and the normalised body. Two runs over unchanged upstream
 * content produce the same hash → no rewrite → no commit.
 */
export function contentHash(leg: MirrorSource, obj: SourceObject): string {
  const fields = provenanceFields(leg, obj);
  const canonical = fields.map(([k, v]) => `${k}=${v}`).join('\n') + '\n\n' + normaliseBody(obj.body);
  return sha256Hex(canonical);
}
