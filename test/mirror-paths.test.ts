/**
 * Source Mirror — path derivation, the allowlist guard, and provenance frontmatter.
 */
import { describe, expect, test } from 'bun:test';
import { parseRid } from '../src/core/rid';
import { contentHash, provenanceFields, renderFile, ridFor } from '../src/mirror/frontmatter';
import { assertUnderSources, objectToPath, slugify } from '../src/mirror/paths';
import { FakeLeg, obj } from './mirror-test-helpers';

const drive = new FakeLeg('drive', 'google_drive.file', []);

describe('slugify', () => {
  test('lowercases, dashes non-alphanumerics, trims', () => {
    expect(slugify('Weekly Sync — Q3 Plan!')).toBe('weekly-sync-q3-plan');
  });
  test('neutralises path-traversal characters', () => {
    expect(slugify('../../wiki/secret')).toBe('wiki-secret');
    expect(slugify('/etc/passwd')).toBe('etc-passwd');
  });
  test('falls back to untitled for an empty result', () => {
    expect(slugify('///')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
  });
});

describe('objectToPath', () => {
  test('is deterministic and lands under sources/<leg>/', () => {
    const o = obj({ upstreamId: 'abc123', title: 'My Doc', body: 'hi' });
    const p1 = objectToPath(drive, o);
    const p2 = objectToPath(drive, o);
    expect(p1).toBe(p2);
    expect(p1.startsWith('sources/drive/')).toBe(true);
    expect(p1.endsWith('.md')).toBe(true);
  });
  test('a rename changes the path (slug) but not the identity', () => {
    const before = obj({ upstreamId: 'same-id', title: 'Old Name', body: 'x' });
    const after = obj({ upstreamId: 'same-id', title: 'New Name', body: 'x' });
    expect(objectToPath(drive, before)).not.toBe(objectToPath(drive, after));
    expect(ridFor(drive, before)).toBe(ridFor(drive, after));
  });
});

describe('assertUnderSources', () => {
  const root = '/tmp/brain';
  test('accepts a path under sources/', () => {
    expect(() => assertUnderSources(root, 'sources/drive/x.md')).not.toThrow();
  });
  test('refuses a parent-traversal escape', () => {
    expect(() => assertUnderSources(root, 'sources/../wiki/x.md')).toThrow(/allowlist violation/);
  });
  test('refuses an absolute path outside sources/', () => {
    expect(() => assertUnderSources(root, '/etc/passwd')).toThrow(/allowlist violation/);
  });
  test('refuses the wiki tree', () => {
    expect(() => assertUnderSources(root, 'wiki/note.md')).toThrow(/allowlist violation/);
  });
});

describe('provenance frontmatter', () => {
  test('mints ref_id via the RID layer and links back via the locator', () => {
    const o = obj({ upstreamId: 'FILEID', title: 'Report', body: 'body text' });
    const fields = Object.fromEntries(provenanceFields(drive, o));
    expect(fields.ref_id).toBe('orn:google_drive.file:FILEID');
    expect(parseRid(fields.ref_id).namespace).toBe('google_drive.file');
    expect(fields.source).toBe('google_drive');
    expect(fields.source_id).toBe('FILEID');
    expect(fields.source_url).toBe('https://drive.google.com/file/d/FILEID/view');
    expect(fields.title).toBe('Report');
  });

  test('records original hash + extractor when the body is derived', () => {
    const o = obj({
      upstreamId: 'PDF1',
      title: 'Scan',
      body: 'extracted text',
      originalSha256: 'deadbeef',
      extractor: 'pdf-text@1',
    });
    const fields = Object.fromEntries(provenanceFields(drive, o));
    expect(fields.original_sha256).toBe('deadbeef');
    expect(fields.extractor).toBe('pdf-text@1');
  });

  test('renderFile includes mirrored_at, contentHash excludes it (idempotency)', () => {
    const o = obj({ upstreamId: 'X', title: 'T', body: 'B' });
    const a = renderFile(drive, o, '2026-07-01T00:00:00.000Z');
    const b = renderFile(drive, o, '2026-07-22T09:00:00.000Z');
    expect(a).toContain('mirrored_at:');
    expect(a).not.toBe(b); // the rendered file differs by the stamp
    expect(contentHash(drive, o)).toBe(contentHash(drive, o)); // but the change-detection hash is stable
  });

  test('a newer extractor changes contentHash while identity holds', () => {
    const v1 = obj({ upstreamId: 'P', title: 'T', body: 'old extraction', extractor: 'pdf-text@1' });
    const v2 = obj({ upstreamId: 'P', title: 'T', body: 'better extraction', extractor: 'pdf-text@2' });
    expect(ridFor(drive, v1)).toBe(ridFor(drive, v2));
    expect(contentHash(drive, v1)).not.toBe(contentHash(drive, v2));
  });

  test('rendered frontmatter is valid framing (opens and closes with ---)', () => {
    const o = obj({ upstreamId: 'X', title: 'Title: with colon "and quotes"', body: 'B' });
    const file = renderFile(drive, o, '2026-07-01T00:00:00.000Z');
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('\n---\n\n');
    // title with special chars is JSON-quoted, so it can't break the YAML block
    expect(file).toContain('title: "Title: with colon \\"and quotes\\""');
  });
});
