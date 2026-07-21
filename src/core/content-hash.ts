/**
 * Canonical page content-hash.
 *
 * There were two independent implementations of "the page content hash":
 * one inline in `importFromContent` (src/core/import-file.ts) and one exported
 * as `contentHash` from src/core/utils.ts. They disagreed, while utils.ts
 * documented itself as matching. This module is the single definition both
 * are meant to converge on.
 *
 * The divergence mattered because `putPage` falls back to the utils version
 * whenever a caller omits `content_hash`:
 *
 *     const hash = page.content_hash || contentHash(page);
 *
 * and many production writers do omit it — the cycle/synthesis, chronicle,
 * think, enrichment and output-writer paths all write agent-generated pages
 * that way. Those pages were therefore hashed WITHOUT the ephemeral-key
 * normalisation below, which exists precisely to stop timestamp-bearing
 * frontmatter from producing a fresh hash on every write and re-chunking and
 * re-embedding unchanged content forever. That bug class has been fixed twice
 * already (v0.39.3.0 CV8 for captured_at/ingested_at, v0.42 #1699 for the
 * gate-derived markers); the fallback path quietly reintroduced it.
 *
 * SCOPE NOTE — this module deliberately reproduces the import-file algorithm
 * bit-for-bit rather than improving it, so that adopting it changes no hash on
 * the markdown import path. Two known limitations are therefore preserved and
 * left to follow-up work:
 *
 *   1. Key order is not canonicalised. `JSON.stringify` serialises in
 *      insertion order, so semantically identical frontmatter with keys in a
 *      different order hashes differently. Fixing this needs RFC 8785 (JCS)
 *      canonicalisation and rehashes the whole corpus, so it belongs with the
 *      Manifest work rather than here.
 *   2. `PageInput` carries no `tags`, so the fallback cannot include them.
 *      A tagged page written through `putPage` and later imported from
 *      markdown will still differ by one hash, converging after a single
 *      re-import. Closing this needs a `PageInput` signature change.
 */

import { createHash } from 'crypto';
import { QUARANTINE_KEY, CONTENT_FLAG_KEY } from './quarantine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';
import { RID_FRONTMATTER_KEY } from './rid.ts';

/**
 * Frontmatter keys excluded from the content hash.
 *
 * These are stamped by the system rather than authored, and each carries a
 * fresh timestamp per write. Including them makes every re-write look like a
 * content change. The gate re-derives its markers deterministically on the
 * next import, so dropping them is safe.
 *
 * Only the timestamp-bearing keys are stripped, never the whole frontmatter
 * object — a user adding a tag must still change the hash, or tag
 * reconciliation silently no-ops behind the hash-match short-circuit.
 *
 * This list is THE list. `importFromContent` imports it rather than holding its
 * own copy: the two were separate once, disagreed, and the disagreement is what
 * this module exists to end. v128 nearly recreated it — the Reference Identifier
 * work added `ref_id` to the import-side copy while this module was being
 * written, and because the two live in different files git merged them clean.
 * Keep them in one place so that cannot happen again.
 */
export const HASH_EPHEMERAL_FRONTMATTER_KEYS: readonly string[] = [
  'captured_at',
  'ingested_at',
  QUARANTINE_KEY,
  CONTENT_FLAG_KEY,
  EMBED_SKIP_KEY,
  // v128: the Reference Identifier is IDENTITY, not content. `gbrain rid
  // backfill` stamps it into every source file on disk; counting it toward the
  // hash would change every page's content_hash on that single pass and
  // re-chunk + re-embed the entire corpus for a value that says nothing about
  // what the page says. Same bug class as captured_at / ingested_at above.
  //
  // It also has to be stripped HERE, not only on the import side: the strip in
  // importFromContent is hash-only, so `ref_id` persists into stored
  // frontmatter. If putPage's fallback hashed it while import did not, the two
  // paths would disagree permanently for every stamped page — the exact defect
  // this module was written to close.
  RID_FRONTMATTER_KEY,
];

/** Fields that participate in the content hash. */
export interface HashablePage {
  title: string;
  type: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
}

/** Strip system-stamped, timestamp-bearing keys from a frontmatter object. */
export function stripEphemeralFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const stable: Record<string, unknown> = { ...(frontmatter ?? {}) };
  for (const k of HASH_EPHEMERAL_FRONTMATTER_KEYS) {
    delete stable[k];
  }
  return stable;
}

/**
 * SHA-256 of a page's meaningful content, used for import idempotency.
 *
 * Field order is load-bearing: it must match `importFromContent` exactly, or
 * the same page hashes differently depending on which write path created it.
 */
export function computeCanonicalPageHash(page: HashablePage): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline ?? '',
      frontmatter: stripEphemeralFrontmatter(page.frontmatter),
      tags: [...(page.tags ?? [])].sort(),
    }))
    .digest('hex');
}
