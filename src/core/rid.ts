/**
 * Reference Identifiers (RIDs) — KOI-compatible stable page identity.
 *
 * A RID is a permanent name for a content object. It is minted once and never
 * reissued. Renaming, moving, or re-assigning a page to a different source
 * leaves the RID untouched, so an inbound reference stays valid for the life of
 * the object rather than the life of its path.
 *
 * Syntax follows the KOI Object Reference Name grammar:
 *
 *     orn:<namespace>:<reference>
 *
 * The namespace names the ORIGINATING SYSTEM plus the KIND of thing. Both are
 * immutable properties of the object, which is why the namespace can live
 * inside identity. `source_id` — which is mutable and routing-assigned — never
 * appears in a RID; a page reassigned to a different source keeps its RID.
 *
 * Attribution: the Reference Identifier syntax and the manifest descriptor come
 * from the KOI-net protocol (Dynamical Systems Group; originally BlockScience
 * with Metagov), MIT-licensed. This is a clean-room implementation of the
 * syntax and the descriptor shape — no code is taken from the KOI libraries,
 * which are beta, Python, and have broken their API across major versions.
 * The canonicalisation below is written directly against RFC 8785 rather than
 * ported from any existing implementation, so no notice obligations attach.
 *
 * What this module deliberately does NOT adopt from KOI: their change-detection
 * model, which resolves conflicts by wall-clock last-writer-wins and drops
 * equal-or-older timestamps at debug level. Our corpus is git-backed, where
 * history is authoritative and ordering is a commit graph.
 *
 * SECURITY POSTURE: a RID is behaviour-inert. Nothing in grants, RLS, or
 * retrieval scoping reads it, so it can neither widen nor narrow any scope.
 * Identity and access are orthogonal axes and must stay that way.
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Namespace registry
// ---------------------------------------------------------------------------

/**
 * Namespaces this build knows how to mint and resolve.
 *
 * - `habitat.page`     — a page authored inside this system. Reference is a
 *                        freshly-minted UUID (the DB default; see migration
 *                        v128). Nothing about it is derived from the slug —
 *                        deriving from the path is exactly the defect RIDs fix.
 * - `habitat.artifact` — a raw artefact. Reference is `artifacts.object_id`,
 *                        which already exists (migration v123) and is already
 *                        stable. We derive rather than mint a second identity.
 * - `google_drive.file`— mirrored from Drive. Reuses KOI's published namespace
 *                        rather than inventing a parallel one; reference is the
 *                        Drive file id, so a full re-ingest reproduces it.
 * - `notion.page`      — mirrored from Notion. No KOI type exists for this, so
 *                        the namespace is ours to define; reference is the
 *                        Notion page id.
 */
export const RID_NAMESPACES = [
  'habitat.page',
  'habitat.artifact',
  'google_drive.file',
  'notion.page',
] as const;

export type RidNamespace = typeof RID_NAMESPACES[number];

export function isRidNamespace(value: unknown): value is RidNamespace {
  return typeof value === 'string' && (RID_NAMESPACES as readonly string[]).includes(value);
}

/** The namespace minted for pages authored inside this system. */
export const AUTHORED_PAGE_NAMESPACE: RidNamespace = 'habitat.page';
/** The namespace derived for raw artefacts. */
export const ARTIFACT_NAMESPACE: RidNamespace = 'habitat.artifact';

/**
 * Frontmatter key carrying a page's RID on disk.
 *
 * Deliberately NOT `id`: that key is already taken for FOREIGN identifiers and
 * drives `findDuplicatePage`'s `sameExternalId` skip branch. Reusing it would
 * corrupt dedup. `ref_id` also reads as a reference rather than a primary key,
 * which is what a RID is.
 */
export const RID_FRONTMATTER_KEY = 'ref_id';

// ---------------------------------------------------------------------------
// Grammar: parse / format / validate
// ---------------------------------------------------------------------------

export interface ParsedRid {
  namespace: string;
  reference: string;
}

/** `orn:` scheme prefix, per the KOI Object Reference Name grammar. */
const RID_SCHEME = 'orn';

/**
 * A namespace is dot-separated lowercase segments: `google_drive.file`.
 * Anchored, so a namespace containing a colon or whitespace is rejected.
 */
const NAMESPACE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;

/**
 * Validate and normalise a RID. The single shared chokepoint for every write
 * path, mirroring `validateSlug`'s role for slugs — drift between call sites is
 * the bug class this prevents.
 *
 * Rejects the same hostile-character classes `validateSlug` rejects: NUL and
 * control bytes, Unicode bidirectional/RTL overrides (visual spoofing of the
 * real target), and whitespace. A RID is rendered into markdown frontmatter and
 * into citations, so a spoofable RID is a spoofable citation.
 *
 * Returns the RID unchanged on success (RIDs are case-sensitive in the
 * reference segment — an upstream file id may legitimately be mixed-case — so
 * unlike slugs this does NOT lowercase).
 */
export function validateRid(rid: string): string {
  if (typeof rid !== 'string' || rid.length === 0) {
    throw new Error('Invalid rid: must be a non-empty string.');
  }
  if (rid.length > 512) {
    throw new Error(`Invalid rid: "${rid.slice(0, 64)}…" exceeds 512 characters.`);
  }
  if (/[\x00-\x1f\x7f-\x9f]/.test(rid)) {
    throw new Error('Invalid rid: control characters are not allowed.');
  }
  if (/[\u202a-\u202e\u2066-\u2069]/.test(rid)) {
    throw new Error('Invalid rid: bidirectional/RTL override characters are not allowed.');
  }
  if (/\s/.test(rid)) {
    throw new Error(`Invalid rid: "${rid}". Whitespace is not allowed.`);
  }
  // Parse validates the structure (scheme, namespace shape, non-empty reference).
  parseRid(rid);
  return rid;
}

/**
 * Parse `orn:<namespace>:<reference>` into its parts.
 *
 * The reference may itself contain colons (some upstream systems use them in
 * their ids), so the split is on the FIRST TWO colons only and everything after
 * is the reference.
 *
 * Throws on a malformed RID rather than returning null — a malformed identifier
 * at a write site is a bug to surface, not a value to silently drop. Use
 * `tryParseRid` at read sites that must tolerate legacy or foreign data.
 */
export function parseRid(rid: string): ParsedRid {
  const firstColon = rid.indexOf(':');
  if (firstColon === -1) {
    throw new Error(`Invalid rid: "${rid}". Expected the form orn:<namespace>:<reference>.`);
  }
  const scheme = rid.slice(0, firstColon);
  if (scheme !== RID_SCHEME) {
    throw new Error(`Invalid rid: "${rid}". Scheme must be "${RID_SCHEME}:", got "${scheme}:".`);
  }
  const secondColon = rid.indexOf(':', firstColon + 1);
  if (secondColon === -1) {
    throw new Error(`Invalid rid: "${rid}". Missing the reference segment (orn:<namespace>:<reference>).`);
  }
  const namespace = rid.slice(firstColon + 1, secondColon);
  const reference = rid.slice(secondColon + 1);
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `Invalid rid: "${rid}". Namespace "${namespace}" must be dot-separated lowercase segments.`,
    );
  }
  if (reference.length === 0) {
    throw new Error(`Invalid rid: "${rid}". Reference segment cannot be empty.`);
  }
  return { namespace, reference };
}

/** Non-throwing `parseRid`. Returns null when the input isn't a well-formed RID. */
export function tryParseRid(rid: unknown): ParsedRid | null {
  if (typeof rid !== 'string') return null;
  try {
    return parseRid(rid);
  } catch {
    return null;
  }
}

/** Build a RID from its parts. Validates the result before returning it. */
export function formatRid(namespace: string, reference: string): string {
  const rid = `${RID_SCHEME}:${namespace}:${reference}`;
  return validateRid(rid);
}

/** True when `value` is a syntactically valid RID. */
export function isRid(value: unknown): value is string {
  return tryParseRid(value) !== null;
}

/**
 * Derive an artefact's RID from its existing `object_id`.
 *
 * Artefacts already carry a stable external identity (migration v123), so the
 * identifier is derived rather than minted — a second, independent identity for
 * the same object is exactly the drift RIDs exist to prevent.
 */
export function ridForArtifact(objectId: string): string {
  return formatRid(ARTIFACT_NAMESPACE, objectId);
}

/**
 * Deterministic RID for an externally-sourced object.
 *
 * Keying on the upstream system's own stable id is what makes a full re-ingest
 * reproduce identical identifiers: nothing about the RID depends on our
 * database state, so wiping the index and re-ingesting from source yields the
 * same names.
 */
export function ridForExternal(namespace: RidNamespace, upstreamId: string): string {
  return formatRid(namespace, upstreamId);
}

// ---------------------------------------------------------------------------
// RFC 8785 canonicalisation + manifest
// ---------------------------------------------------------------------------

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialisation.
 *
 * The point of a published canonicalisation standard is that an implementation
 * in another language reproduces our hash byte-for-byte. Two properties carry
 * that: object keys sorted by UTF-16 code unit, and ECMAScript number/string
 * serialisation.
 *
 * `JSON.stringify` already gives us the second for free — its number formatting
 * IS `Number::toString`, and its string escaping is exactly the minimal-escape
 * set RFC 8785 mandates (control characters as the short forms where they
 * exist, `\u00xx` otherwise, non-ASCII left as literal UTF-8). So the only work
 * here is key ordering and refusing the values JSON cannot represent.
 *
 * `Array.prototype.sort` on strings compares by UTF-16 code unit, which is the
 * ordering RFC 8785 specifies — no custom comparator needed.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('Cannot canonicalize a non-finite number (NaN / Infinity are not JSON).');
    }
    // JSON.stringify(-0) === '0', which is what RFC 8785 requires.
    return JSON.stringify(value as number);
  }
  if (t === 'string') return JSON.stringify(value as string);
  if (t === 'bigint') {
    throw new Error('Cannot canonicalize a bigint (not representable in JSON).');
  }
  if (Array.isArray(value)) {
    // `undefined` in an array position becomes null under JSON semantics.
    return `[${value.map(v => canonicalizeJson(v === undefined ? null : v)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    const body = keys
      .map(k => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`)
      .join(',');
    return `{${body}}`;
  }
  throw new Error(`Cannot canonicalize a value of type ${t}.`);
}

/** SHA-256 over the RFC 8785 canonical form, hex-encoded. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

/**
 * The portable descriptor a recipient can verify against the content they
 * received: identifier, timestamp, content hash.
 *
 * Hash semantics MATCH KOI's rather than extending them: the hash covers the
 * CONTENTS only, so the descriptor does not attest to its own binding. That is
 * a genuine weakness, but diverging costs wire compatibility, which is the whole
 * point of adopting the syntax. Self-certification belongs with signed envelopes
 * at the boundary — membrane work, out of scope here.
 */
export interface RidManifest {
  rid: string;
  timestamp: string;
  hash: string;
}

/**
 * Fields hashed by a manifest. Deliberately NOT reusing `pages.content_hash`:
 * there are two divergent `content_hash` implementations in this codebase
 * (`import-file.ts` includes tags and strips ephemeral frontmatter keys;
 * `utils.ts` does neither, despite a docstring claiming they match) and neither
 * canonicalises key order. Neither is reproducible from another language, which
 * is the whole requirement. The manifest hash is computed independently.
 */
export interface ManifestContents {
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}

/**
 * Build a manifest for a content object.
 *
 * `timestamp` is the object's last-updated time, not "now" — a manifest for
 * unchanged content must be reproducible, and a wall-clock stamp would make
 * every call return a different descriptor.
 */
export function buildManifest(
  rid: string,
  contents: ManifestContents,
  updatedAt: Date,
): RidManifest {
  return {
    rid: validateRid(rid),
    timestamp: updatedAt.toISOString(),
    hash: canonicalHash(canonicalManifestContents(contents)),
  };
}

/**
 * Normalise the hashed view of a content object.
 *
 * Tags are sorted so that tag ORDER — which carries no meaning and varies by
 * how a page was written — doesn't change the hash. Frontmatter key order is
 * handled by the canonicaliser itself.
 */
export function canonicalManifestContents(contents: ManifestContents): Record<string, unknown> {
  return {
    type: contents.type,
    title: contents.title,
    compiled_truth: contents.compiled_truth,
    timeline: contents.timeline,
    frontmatter: contents.frontmatter ?? {},
    tags: [...(contents.tags ?? [])].sort(),
  };
}

/** Verify a manifest against content the recipient actually holds. */
export function verifyManifest(manifest: RidManifest, contents: ManifestContents): boolean {
  return manifest.hash === canonicalHash(canonicalManifestContents(contents));
}

// ---------------------------------------------------------------------------
// Locator resolution
// ---------------------------------------------------------------------------

/**
 * One name, many locators.
 *
 * A RID says WHAT an object is; a locator says WHERE to reach a copy of it.
 * KOI specifies this relationship and never built it — there is no resolution
 * interface in their library — so there is no prior art to copy and the shape
 * is ours to get right.
 *
 * v1 defines the full interface and implements resolvers only for the sources
 * we actually have. An unknown namespace resolves to an empty locator list
 * rather than throwing: a RID minted by a system we don't know about is a
 * legitimate thing to hold, just not one we can reach.
 */
export interface RidLocator {
  /**
   * `internal` — reachable inside this brain (resolve via `resolve_rid`).
   * `external` — reachable in the system the object originated in.
   */
  kind: 'internal' | 'external';
  uri: string;
  /** Human-readable label for the system this locator points into. */
  system: string;
}

export type RidLocatorResolver = (parsed: ParsedRid) => RidLocator[];

const LOCATOR_RESOLVERS: Record<string, RidLocatorResolver> = {
  'habitat.page': ({ namespace, reference }) => [
    { kind: 'internal', uri: `gbrain://page/${namespace}/${reference}`, system: 'gbrain' },
  ],
  'habitat.artifact': ({ namespace, reference }) => [
    { kind: 'internal', uri: `gbrain://artifact/${namespace}/${reference}`, system: 'gbrain' },
  ],
  // Requirement 11: where the original lives outside the system, at least one
  // locator must reach it. Both external resolvers below satisfy that.
  'google_drive.file': ({ reference }) => [
    { kind: 'external', uri: `https://drive.google.com/file/d/${reference}/view`, system: 'google_drive' },
  ],
  'notion.page': ({ reference }) => [
    { kind: 'external', uri: `https://www.notion.so/${reference.replace(/-/g, '')}`, system: 'notion' },
  ],
};

/**
 * Resolve a RID to its locators. Pure — no database access, so it is safe to
 * call from any layer. The internal locators it returns are addresses, not
 * proof the object is present; `resolve_rid` is the op that answers presence.
 */
export function resolveLocators(rid: string): RidLocator[] {
  const parsed = tryParseRid(rid);
  if (!parsed) return [];
  const resolver = LOCATOR_RESOLVERS[parsed.namespace];
  return resolver ? resolver(parsed) : [];
}

/** Namespaces with a registered locator resolver. */
export function resolvableNamespaces(): string[] {
  return Object.keys(LOCATOR_RESOLVERS).sort();
}
