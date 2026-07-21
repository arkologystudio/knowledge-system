/**
 * v128 — the ingest lane's half of Reference Identifiers.
 *
 * Covers the three behaviours that only the importer can prove:
 *   1. A frontmatter `ref_id` is honoured, so a stamped file re-imported after
 *      a wipe restores its original identity rather than getting a new one.
 *   2. An identifier already held by a different page is REFUSED — the hijack
 *      guard, same class as the slug hijack.
 *   3. Stamping `ref_id` into a file does NOT change its content_hash, so the
 *      `gbrain rid backfill` pass cannot trigger a corpus-wide re-embed.
 *
 * PGLite hermetic; the sibling of test/import-dedup-frontmatter-id.test.ts,
 * which is the existing test about frontmatter-carried external identity.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { RID_FRONTMATTER_KEY, tryParseRid } from '../src/core/rid.ts';

let engine: PGLiteEngine;
let tmpRoot: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-rid-import-'));
});

function makeFile(rel: string, body: string): { path: string; rel: string } {
  const full = join(tmpRoot, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return { path: full, rel };
}

function page(opts: { title?: string; refId?: string; body?: string } = {}): string {
  const lines = ['---', 'type: note', `title: ${opts.title ?? 'A note'}`];
  if (opts.refId) lines.push(`${RID_FRONTMATTER_KEY}: ${opts.refId}`);
  lines.push('---', '', opts.body ?? 'Body text.');
  return lines.join('\n');
}

describe('minting', () => {
  test('a file with no ref_id gets a fresh identifier minted', async () => {
    const f = makeFile('notes/fresh.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const p = await engine.getPage('notes/fresh');
    expect(p!.rid).toBeDefined();
    expect(tryParseRid(p!.rid)!.namespace).toBe('habitat.page');
  });

  test('re-importing an unchanged file preserves the minted identifier', async () => {
    const f = makeFile('notes/stable.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const first = await engine.getPage('notes/stable');
    // Edit the body so the hash changes and the import actually re-writes the
    // row rather than short-circuiting on the hash-match skip.
    writeFileSync(f.path, page({ body: 'Edited body.' }));
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const second = await engine.getPage('notes/stable');
    expect(second!.rid).toBe(first!.rid);
  });
});

describe('externally-keyed identity', () => {
  test('a frontmatter ref_id is honoured on first import', async () => {
    const rid = 'orn:google_drive.file:1AbC_dEfGhIjKlMnOpQr';
    const f = makeFile('mirror/drive-doc.md', page({ refId: rid }));
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    expect((await engine.getPage('mirror/drive-doc'))!.rid).toBe(rid);
  });

  test('a stamped file re-imported after a wipe restores its ORIGINAL identity', async () => {
    // ACCEPTANCE CRITERION: "wiping the index and re-ingesting from source
    // reproduces identical identifiers." This is why the backfill stamps the
    // identifier into the file rather than leaving it only in the database.
    const f = makeFile('notes/survives-wipe.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const original = (await engine.getPage('notes/survives-wipe'))!.rid!;

    // Stamp it into the file the way `gbrain rid backfill` does, then wipe.
    writeFileSync(f.path, page({ refId: original }));
    await engine.deletePage('notes/survives-wipe');
    expect(await engine.getPage('notes/survives-wipe')).toBeNull();

    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    expect((await engine.getPage('notes/survives-wipe'))!.rid).toBe(original);
  });

  test('a malformed ref_id is rejected rather than silently ignored', async () => {
    const f = makeFile('notes/bad-ref.md', page({ refId: 'definitely-not-a-rid' }));
    await expect(importFromFile(engine, f.path, f.rel, { noEmbed: true })).rejects.toThrow(/Invalid rid/);
  });
});

describe('hijack guard', () => {
  test('a file claiming another page\'s identifier is REFUSED', async () => {
    // Same class as the slug hijack: in a shared brain where PRs are mergeable,
    // this would otherwise let one file steal another page's identity — worse
    // than stealing its slug, because every reference held elsewhere would
    // silently start resolving to the attacker's content.
    const victim = makeFile('notes/victim.md', page({ title: 'Victim' }));
    await importFromFile(engine, victim.path, victim.rel, { noEmbed: true });
    const victimRid = (await engine.getPage('notes/victim'))!.rid!;

    const attacker = makeFile('notes/attacker.md', page({ title: 'Attacker', refId: victimRid }));
    await expect(importFromFile(engine, attacker.path, attacker.rel, { noEmbed: true }))
      .rejects.toThrow(/already held by a different page/);

    // The victim keeps its identity, and the attacker never landed.
    expect((await engine.getPage('notes/victim'))!.rid).toBe(victimRid);
    expect(await engine.getPage('notes/attacker')).toBeNull();
  });

  test('a page re-declaring its OWN identifier is fine', async () => {
    // The legitimate case the guard must not break: this is exactly what a
    // backfilled file looks like on every subsequent sync.
    const f = makeFile('notes/self-claim.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const rid = (await engine.getPage('notes/self-claim'))!.rid!;

    writeFileSync(f.path, page({ refId: rid, body: 'Edited body.' }));
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    expect((await engine.getPage('notes/self-claim'))!.rid).toBe(rid);
  });

  test('a soft-deleted page still holds its identifier against a claim', async () => {
    // A tombstoned page is recoverable for 72h and the unique index still
    // covers it, so letting a second page take the name would make restore
    // fail with an opaque constraint violation.
    const f = makeFile('notes/tombstone.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const rid = (await engine.getPage('notes/tombstone'))!.rid!;
    await engine.softDeletePage('notes/tombstone', { sourceId: 'default' });

    const claimant = makeFile('notes/claimant.md', page({ title: 'Claimant', refId: rid }));
    await expect(importFromFile(engine, claimant.path, claimant.rel, { noEmbed: true }))
      .rejects.toThrow(/already held by a different page/);
  });
});

describe('the identifier is identity, not content', () => {
  test('stamping ref_id does NOT change the page content_hash', async () => {
    // THE COST-CONTROL INVARIANT. If `ref_id` counted toward the hash, the
    // single `gbrain rid backfill` pass would change every page's hash and
    // re-chunk + re-embed the whole corpus — real, unbounded embedding spend
    // for a value that says nothing about what the page says.
    const f = makeFile('notes/hashless.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const before = (await engine.getPage('notes/hashless'))!;

    writeFileSync(f.path, page({ refId: before.rid! }));
    const result = await importFromFile(engine, f.path, f.rel, { noEmbed: true });

    // The hash is unchanged, so the importer takes its hash-match skip branch
    // and no chunking or embedding work happens at all.
    expect(result.status).toBe('skipped');
    const after = (await engine.getPage('notes/hashless'))!;
    expect(after.content_hash).toBe(before.content_hash);
  });

  test('editing the BODY still changes the hash (the exclusion is narrow)', async () => {
    // Guard against over-broad exclusion: dropping too much from the hash would
    // make real edits invisible to sync.
    const f = makeFile('notes/narrow.md', page());
    await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    const before = (await engine.getPage('notes/narrow'))!;

    writeFileSync(f.path, page({ refId: before.rid!, body: 'Genuinely different body.' }));
    const result = await importFromFile(engine, f.path, f.rel, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect((await engine.getPage('notes/narrow'))!.content_hash).not.toBe(before.content_hash);
  });
});
