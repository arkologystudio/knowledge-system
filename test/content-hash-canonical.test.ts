/**
 * Pins the canonical page content-hash against the inline algorithm in
 * `importFromContent`, so the two cannot drift apart again.
 *
 * They had drifted: `utils.contentHash` omitted both the ephemeral-frontmatter
 * strip and the `tags` field while documenting itself as matching. Because
 * `putPage` falls back to it whenever a caller omits `content_hash`, every
 * agent-generated page was hashed by the divergent algorithm — reintroducing
 * the unbounded re-embed bug that CV8 and #1699 each fixed on the import side.
 *
 * The replica below is intentionally a literal copy of the import-file
 * expression rather than a call into the shared helper. A test that imported
 * the helper would pass trivially and prove nothing; this one fails if either
 * side changes independently.
 */

import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import {
  computeCanonicalPageHash,
  stripEphemeralFrontmatter,
  HASH_EPHEMERAL_FRONTMATTER_KEYS,
} from '../src/core/content-hash.ts';
import { contentHash } from '../src/core/utils.ts';
import { QUARANTINE_KEY, CONTENT_FLAG_KEY } from '../src/core/quarantine.ts';
import { EMBED_SKIP_KEY } from '../src/core/embed-skip.ts';
import type { PageType } from '../src/core/types.ts';

/** Literal replica of the hash expression in importFromContent. */
function importFileAlgorithm(parsed: {
  title: string;
  type: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}): string {
  const EPHEMERAL = ['captured_at', 'ingested_at', QUARANTINE_KEY, CONTENT_FLAG_KEY, EMBED_SKIP_KEY];
  const stableFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  for (const k of EPHEMERAL) delete stableFrontmatter[k];
  return createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: stableFrontmatter,
      tags: parsed.tags.sort(),
    }))
    .digest('hex');
}

const basePage = {
  title: 'Acme Example Overview',
  type: 'note',
  compiled_truth: 'Body text that stands in for real content.',
  timeline: '',
  frontmatter: { domain: 'example', sensitivity: 'internal' } as Record<string, unknown>,
  tags: ['alpha', 'beta'],
};

describe('canonical page content hash', () => {
  test('agrees with the importFromContent algorithm', () => {
    expect(computeCanonicalPageHash(basePage)).toBe(importFileAlgorithm({ ...basePage }));
  });

  test('agrees when frontmatter carries ephemeral keys', () => {
    const fm = {
      ...basePage.frontmatter,
      captured_at: '2026-07-20T10:00:00Z',
      ingested_at: '2026-07-20T10:00:01Z',
      [QUARANTINE_KEY]: { assessed_at: '2026-07-20T10:00:02Z' },
    };
    expect(computeCanonicalPageHash({ ...basePage, frontmatter: fm }))
      .toBe(importFileAlgorithm({ ...basePage, frontmatter: { ...fm } }));
  });

  test('is stable when only ephemeral keys change — the re-embed guard', () => {
    const first = computeCanonicalPageHash({
      ...basePage,
      frontmatter: { ...basePage.frontmatter, captured_at: '2026-07-20T10:00:00Z' },
    });
    const second = computeCanonicalPageHash({
      ...basePage,
      frontmatter: { ...basePage.frontmatter, captured_at: '2099-01-01T00:00:00Z' },
    });
    expect(first).toBe(second);
  });

  test('every declared ephemeral key is actually stripped', () => {
    for (const key of HASH_EPHEMERAL_FRONTMATTER_KEYS) {
      const withKey = computeCanonicalPageHash({
        ...basePage,
        frontmatter: { ...basePage.frontmatter, [key]: 'anything' },
      });
      expect(withKey).toBe(computeCanonicalPageHash(basePage));
    }
  });

  test('a real content change still changes the hash', () => {
    expect(computeCanonicalPageHash({ ...basePage, compiled_truth: 'different' }))
      .not.toBe(computeCanonicalPageHash(basePage));
  });

  test('adding a tag still changes the hash — tag reconciliation must not no-op', () => {
    expect(computeCanonicalPageHash({ ...basePage, tags: ['alpha', 'beta', 'gamma'] }))
      .not.toBe(computeCanonicalPageHash(basePage));
  });

  test('tag order does not affect the hash', () => {
    expect(computeCanonicalPageHash({ ...basePage, tags: ['beta', 'alpha'] }))
      .toBe(computeCanonicalPageHash(basePage));
  });

  test('stripEphemeralFrontmatter leaves authored keys intact', () => {
    const stripped = stripEphemeralFrontmatter({ domain: 'example', captured_at: 'x' });
    expect(stripped).toEqual({ domain: 'example' });
  });

  test('stripEphemeralFrontmatter does not mutate its input', () => {
    const original = { domain: 'example', captured_at: 'x' };
    stripEphemeralFrontmatter(original);
    expect(original.captured_at).toBe('x');
  });

  test('utils.contentHash delegates — tagless page matches the import algorithm', () => {
    const page = {
      title: basePage.title,
      type: basePage.type as PageType,
      compiled_truth: basePage.compiled_truth,
      timeline: '',
      frontmatter: { ...basePage.frontmatter, ingested_at: '2026-07-20T10:00:00Z' },
    };
    expect(contentHash(page)).toBe(importFileAlgorithm({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: '',
      frontmatter: { ...page.frontmatter },
      tags: [],
    }));
  });

  test('utils.contentHash is stable across ephemeral-only frontmatter churn', () => {
    const mk = (ts: string) => contentHash({
      title: basePage.title,
      type: basePage.type as PageType,
      compiled_truth: basePage.compiled_truth,
      timeline: '',
      frontmatter: { ...basePage.frontmatter, captured_at: ts },
    });
    expect(mk('2026-07-20T10:00:00Z')).toBe(mk('2099-01-01T00:00:00Z'));
  });
});
