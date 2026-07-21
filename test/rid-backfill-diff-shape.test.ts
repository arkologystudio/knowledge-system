/**
 * #2153 — the diff-shape pin for `gbrain rid backfill`.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. The backfill's job is to add one
 * `ref_id:` line per file. Run against Arkology's real 356-page corpus it
 * instead produced 330 files changed, 3634 insertions, 1475 deletions: it
 * reordered keys, injected `type:`, fabricated titles, normalised
 * `created: 2026-05-04` into an ISO timestamp, rewrote quoting and list style,
 * and deleted `slug:` and every YAML comment. The cause was a
 * parseMarkdown → serializeMarkdown round-trip; the fix is a textual splice
 * (src/core/frontmatter-stamp.ts).
 *
 * The defect shipped because NOTHING ASSERTED THE DIFF SHAPE. Unit tests on
 * the stamper alone would not have caught it either — the round-trip lived in
 * the command. So this test drives the real command over a real fixture corpus
 * on a real filesystem, with the real writer, and diffs actual before/after
 * bytes. Nothing here is mocked except the engine's page enumeration, because
 * a test that mocks the write proves exactly nothing: the entire defect was in
 * what got written.
 *
 * The invariant, asserted structurally rather than by golden file:
 *   1. every ADDED line begins with `ref_id:`
 *   2. NO line is ever removed
 *   3. every other byte of every file is unchanged
 *
 * (3) is the strongest of the three and subsumes ordering, quoting, date
 * normalisation, comment survival, trailing-newline state, and CRLF.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRid } from '../src/commands/rid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { RID_FRONTMATTER_KEY } from '../src/core/rid.ts';
import { withEnv } from './helpers/with-env.ts';

// ---------------------------------------------------------------------------
// Fixture corpus — deliberately awkward frontmatter.
//
// Every file here encodes at least one thing the old round-trip destroyed.
// They are written as raw template strings, NOT built by a serialiser, so the
// fixture itself cannot drift toward whatever the serialiser happens to emit.
// ---------------------------------------------------------------------------

interface Fixture {
  slug: string;
  rid: string;
  content: string;
  /** Expected outcome, asserted against the counters at the end. */
  expect: 'stamped' | 'already_stamped' | 'no_frontmatter';
}

const FIXTURES: Fixture[] = [
  {
    // The full horror: unusual key order (title NOT first, no `type` at all),
    // mixed quoting, a bare date, keys the Page model does not carry, a flow
    // sequence, a quoted name inside a list, a nested map, and a comment.
    slug: 'weekly-sync',
    rid: 'orn:gbrain:01HZZWEEKLYSYNC',
    expect: 'stamped',
    content: `---
updated: 2026-05-11
title: "Weekly Sync — 2026-05-04"
created: 2026-05-04
transcript_hash: abc123def456
source_channel_id: C09XYZ123
meeting_notes_channel_id: C01ABC789
openclaw_session_file: /var/lib/openclaw/sess-42.json
live-url: https://example.invalid/recording
authors:
  - "Eyre, Ross"
  - Ché
  - 'de la Cruz, María'
tags: [ops, weekly, "q2-planning"]
sources:
  - name: slack
    id: 42
    imported: 2026-05-04
# provenance note: hand-corrected on 2026-05-06
---

# Weekly Sync

Body paragraph with a --- horizontal rule below.

---

Trailing paragraph.
`,
  },
  {
    // No trailing newline on the final line. The splice must not add one.
    slug: 'no-trailing-newline',
    rid: 'orn:gbrain:01HZZNOTRAILNL',
    expect: 'stamped',
    content: `---
title: Terse
slug: no-trailing-newline
empty_value:
---

Body with no trailing newline.`,
  },
  {
    // CRLF throughout. The inserted line must match, and the body's CRLFs must
    // survive byte-for-byte.
    slug: 'crlf-page',
    rid: 'orn:gbrain:01HZZCRLFPAGE0',
    expect: 'stamped',
    content:
      '---\r\ntitle: CRLF Page\r\ncreated: 2026-01-09\r\nwindows_path: C:\\Users\\ross\\notes\r\n---\r\n\r\nBody line one.\r\n\r\nBody line two.\r\n',
  },
  {
    // Block and folded scalars. The old path converted `>` to `|`, silently
    // changing the text. Also an unterminated-looking `---` INSIDE a scalar,
    // which must not be mistaken for the closing delimiter... it is indented,
    // so the block-scalar content carries it.
    slug: 'scalars',
    rid: 'orn:gbrain:01HZZSCALARS00',
    expect: 'stamped',
    content: `---
title: Scalars
literal_block: |
  line A
  line B
folded_block: >
  wrapped text
  that folds
weird_key.with.dots: kept
"quoted key": also kept
---

Body.
`,
  },
  {
    // Already carries the exact ref_id → must be a byte-for-byte no-op and land
    // in the `already stamped` counter, not the `stamped` one.
    slug: 'already-stamped',
    rid: 'orn:gbrain:01HZZALREADY000',
    expect: 'already_stamped',
    content: `---
title: Already Stamped
${RID_FRONTMATTER_KEY}: 'orn:gbrain:01HZZALREADY000'
created: 2026-03-02
---

Body.
`,
  },
  {
    // Same, but written unquoted by hand. Equality is on the VALUE, so this is
    // still a no-op — the stamper must not "normalise" it into quotes.
    slug: 'already-stamped-bare',
    rid: 'orn:gbrain:01HZZBARE000000',
    expect: 'already_stamped',
    content: `---
title: Already Stamped Bare
${RID_FRONTMATTER_KEY}: orn:gbrain:01HZZBARE000000
---

Body.
`,
  },
  {
    // No frontmatter block at all. Decision: SKIP, never synthesize.
    slug: 'plain-prose',
    rid: 'orn:gbrain:01HZZPLAINPROSE',
    expect: 'no_frontmatter',
    content: `# Plain Prose

This file never had frontmatter. A backfill must not invent one.

---

That rule above is a horizontal rule, not a delimiter.
`,
  },
];

// ---------------------------------------------------------------------------

let brainDir: string;
let homeDir: string;

/**
 * Drive the real command, with GBRAIN_HOME pointed at a temp dir so the
 * mandatory backups land there instead of the developer's real ~/.gbrain.
 * withEnv is the repo's canonical env pattern (process.env is process-global
 * and the parallel runner shares one process per shard).
 */
function backfill(args: string[] = []): Promise<void> {
  return withEnv({ GBRAIN_HOME: homeDir }, () => runRid(stubEngine(), ['backfill', ...args]));
}

function stubEngine(): BrainEngine {
  const pages = FIXTURES.map(f => ({
    slug: f.slug,
    rid: f.rid,
    source_id: 'default',
    type: 'note',
    title: f.slug,
  }));
  return {
    listAllSources: async () => [{ id: 'default', local_path: brainDir }],
    listPages: async () => pages,
    getPage: async (slug: string) => pages.find(p => p.slug === slug) ?? null,
  } as unknown as BrainEngine;
}

function writeCorpus(): Map<string, string> {
  const before = new Map<string, string>();
  for (const f of FIXTURES) {
    const p = join(brainDir, `${f.slug}.md`);
    writeFileSync(p, f.content, 'utf8');
    before.set(f.slug, f.content);
  }
  return before;
}

function readCorpus(): Map<string, string> {
  const after = new Map<string, string>();
  for (const f of FIXTURES) {
    after.set(f.slug, readFileSync(join(brainDir, `${f.slug}.md`), 'utf8'));
  }
  return after;
}

/**
 * Line-level diff, split on \n with \r retained so a CRLF→LF rewrite shows up
 * as BOTH a removal and an addition rather than silently comparing equal.
 */
function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  const remaining = [...b];
  const removed: string[] = [];
  for (const line of a) {
    const i = remaining.indexOf(line);
    if (i === -1) removed.push(line);
    else remaining.splice(i, 1);
  }
  return { added: remaining, removed };
}

beforeEach(() => {
  brainDir = mkdtempSync(join(tmpdir(), 'rid-backfill-brain-'));
  homeDir = mkdtempSync(join(tmpdir(), 'rid-backfill-home-'));
  mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('rid backfill — diff shape', () => {
  test('every added line is a ref_id line, and no line is ever removed', async () => {
    const before = writeCorpus();
    await backfill();
    const after = readCorpus();

    let totalAdded = 0;
    for (const f of FIXTURES) {
      const { added, removed } = diffLines(before.get(f.slug)!, after.get(f.slug)!);

      // (2) NOTHING is ever removed. This is the assertion the 1475 deletions
      // would have tripped.
      expect({ slug: f.slug, removed }).toEqual({ slug: f.slug, removed: [] });

      // (1) every added line is the one line we came to add.
      for (const line of added) {
        expect({ slug: f.slug, line }).toEqual({
          slug: f.slug,
          line: expect.stringMatching(
            new RegExp(`^${RID_FRONTMATTER_KEY}: `),
          ) as unknown as string,
        });
      }
      totalAdded += added.length;

      if (f.expect === 'stamped') expect(added.length).toBe(1);
      else expect(added.length).toBe(0);
    }

    // Exactly one line per stampable file across the whole corpus — the
    // corpus-level shape the real run got wrong (330 wanted, 3634 written).
    const stampable = FIXTURES.filter(f => f.expect === 'stamped').length;
    expect(totalAdded).toBe(stampable);
  });

  test('every other byte of every file is unchanged', async () => {
    const before = writeCorpus();
    await backfill();
    const after = readCorpus();

    for (const f of FIXTURES) {
      const original = before.get(f.slug)!;
      const result = after.get(f.slug)!;

      if (f.expect !== 'stamped') {
        // (3a) untouched files are byte-identical, including the file that has
        // no frontmatter and the two that were already stamped.
        expect({ slug: f.slug, same: result === original }).toEqual({
          slug: f.slug,
          same: true,
        });
        continue;
      }

      // (3b) Removing the single inserted ref_id line must reconstruct the
      // original file EXACTLY. This is the byte-level statement of the
      // invariant: quoting, key order, `created: 2026-05-04` un-normalised,
      // the YAML comment, the flow sequence, the quoted names, CRLF, and the
      // presence or absence of a trailing newline all ride on it.
      const stampRe = new RegExp(
        `^${RID_FRONTMATTER_KEY}: .*(\\r?\\n)`,
        'm',
      );
      expect({ slug: f.slug, hasStamp: stampRe.test(result) }).toEqual({
        slug: f.slug,
        hasStamp: true,
      });
      const reconstructed = result.replace(stampRe, '');
      expect({ slug: f.slug, content: reconstructed }).toEqual({
        slug: f.slug,
        content: original,
      });
    }
  });

  test('specific destructions from the incident do not recur', async () => {
    writeCorpus();
    await backfill();
    const sync = readFileSync(join(brainDir, 'weekly-sync.md'), 'utf8');

    // Dates stay as authored — the incident turned this into an ISO timestamp.
    expect(sync).toContain('created: 2026-05-04\n');
    expect(sync).not.toContain('2026-05-04T00:00:00.000Z');

    // Keys the Page model does not carry survive.
    expect(sync).toContain('transcript_hash: abc123def456');
    expect(sync).toContain('source_channel_id: C09XYZ123');
    expect(sync).toContain('meeting_notes_channel_id: C01ABC789');
    expect(sync).toContain('openclaw_session_file: /var/lib/openclaw/sess-42.json');
    expect(sync).toContain('live-url: https://example.invalid/recording');

    // Quoting and list style are the author's, not the serialiser's.
    expect(sync).toContain('title: "Weekly Sync — 2026-05-04"');
    expect(sync).toContain('tags: [ops, weekly, "q2-planning"]');
    expect(sync).toContain('  - "Eyre, Ross"');
    expect(sync).toContain(`  - 'de la Cruz, María'`);

    // Comments survive.
    expect(sync).toContain('# provenance note: hand-corrected on 2026-05-06');

    // No `type:` was injected, and key order is untouched: `updated` still
    // precedes `title`, which still precedes `created`.
    expect(sync).not.toContain('\ntype:');
    expect(sync.indexOf('updated:')).toBeLessThan(sync.indexOf('title:'));
    expect(sync.indexOf('title:')).toBeLessThan(sync.indexOf('created:'));

    // `slug:` is not deleted — the incident dropped it entirely.
    const terse = readFileSync(join(brainDir, 'no-trailing-newline.md'), 'utf8');
    expect(terse).toContain('slug: no-trailing-newline');
    // ...nor is an empty value materialised into `null`.
    expect(terse).toContain('empty_value:\n');
    expect(terse).not.toContain('empty_value: null');

    // Folded scalars keep their folding marker.
    const scalars = readFileSync(join(brainDir, 'scalars.md'), 'utf8');
    expect(scalars).toContain('folded_block: >');
    expect(scalars).not.toContain('folded_block: |');
  });

  test('the stamp lands inside the frontmatter block, not the body', async () => {
    writeCorpus();
    await backfill();

    for (const f of FIXTURES.filter(x => x.expect === 'stamped')) {
      const text = readFileSync(join(brainDir, `${f.slug}.md`), 'utf8');
      const lines = text.split(/\r?\n/);
      const stampIdx = lines.findIndex(l => l.startsWith(`${RID_FRONTMATTER_KEY}:`));
      const closeIdx = lines.findIndex((l, i) => i > 0 && l === '---');
      expect({ slug: f.slug, inside: stampIdx > 0 && stampIdx < closeIdx }).toEqual({
        slug: f.slug,
        inside: true,
      });
    }
  });

  test('the stamped value round-trips through the YAML parser', async () => {
    writeCorpus();
    await backfill();

    // The splice is textual, so it owes a proof that what it wrote is valid
    // YAML that reads back as the exact identifier.
    const { parseMarkdown } = await import('../src/core/markdown.ts');
    for (const f of FIXTURES.filter(x => x.expect !== 'no_frontmatter')) {
      const text = readFileSync(join(brainDir, `${f.slug}.md`), 'utf8');
      const fm = parseMarkdown(text).frontmatter as Record<string, unknown>;
      expect({ slug: f.slug, rid: fm[RID_FRONTMATTER_KEY] }).toEqual({
        slug: f.slug,
        rid: f.rid,
      });
    }
  });

  test('a second pass is a no-op — idempotent to the byte', async () => {
    writeCorpus();
    await backfill();
    const afterFirst = readCorpus();
    await backfill();
    const afterSecond = readCorpus();

    for (const f of FIXTURES) {
      expect({ slug: f.slug, same: afterSecond.get(f.slug) === afterFirst.get(f.slug) }).toEqual({
        slug: f.slug,
        same: true,
      });
    }
  });

  test('--dry-run writes nothing at all', async () => {
    const before = writeCorpus();
    await backfill(['--dry-run']);
    const after = readCorpus();
    for (const f of FIXTURES) {
      expect({ slug: f.slug, same: after.get(f.slug) === before.get(f.slug) }).toEqual({
        slug: f.slug,
        same: true,
      });
    }
  });

  test('a file claiming a different ref_id is refused, not overwritten', async () => {
    writeCorpus();
    const conflicted = `---
title: Conflicted
${RID_FRONTMATTER_KEY}: 'orn:gbrain:SOMEONEELSESID'
---

Body.
`;
    writeFileSync(join(brainDir, 'weekly-sync.md'), conflicted, 'utf8');
    await backfill();
    expect(readFileSync(join(brainDir, 'weekly-sync.md'), 'utf8')).toBe(conflicted);
  });

  test('counters and output shape report the corpus honestly', async () => {
    writeCorpus();
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (c: any) => {
      chunks.push(String(c));
      return true;
    };
    try {
      await backfill(['--json']);
    } finally {
      (process.stdout as any).write = orig;
    }
    const out = JSON.parse(chunks.join('').trim());

    expect(out.scanned).toBe(FIXTURES.length);
    expect(out.stamped).toBe(FIXTURES.filter(f => f.expect === 'stamped').length);
    expect(out.already_stamped).toBe(
      FIXTURES.filter(f => f.expect === 'already_stamped').length,
    );
    expect(out.no_frontmatter).toBe(
      FIXTURES.filter(f => f.expect === 'no_frontmatter').length,
    );
    expect(out.missing_file).toBe(0);
    expect(out.errors).toEqual([]);
  });

  test('the backup safety net still fires for every file written', async () => {
    writeCorpus();
    await backfill();

    // Backups are the operator's last resort; the surgical write must not have
    // been bought by removing them.
    const { readdirSync } = await import('fs');
    const root = join(homeDir, '.gbrain', 'backups', 'frontmatter');
    const runs = readdirSync(root);
    expect(runs.length).toBe(1);

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else found.push(e.name);
      }
    };
    walk(join(root, runs[0]));

    for (const f of FIXTURES.filter(x => x.expect === 'stamped')) {
      expect(found).toContain(`${f.slug}.md.bak`);
    }
    // And each backup holds the PRE-stamp bytes.
    const backupOf = (slug: string) => {
      let hit = '';
      const walk2 = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk2(p);
          else if (e.name === `${slug}.md.bak`) hit = p;
        }
      };
      walk2(join(root, runs[0]));
      return readFileSync(hit, 'utf8');
    };
    for (const f of FIXTURES.filter(x => x.expect === 'stamped')) {
      expect({ slug: f.slug, content: backupOf(f.slug) }).toEqual({
        slug: f.slug,
        content: f.content,
      });
    }
  });
});
