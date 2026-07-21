/**
 * Surgical frontmatter stamping — insert ONE key into a file's existing YAML
 * frontmatter and leave every other byte exactly as it was found.
 *
 * WHY THIS EXISTS (#2153). `gbrain rid backfill` used to stamp `ref_id` by
 * round-tripping the file: parseMarkdown() → mutate the object → serializeMarkdown().
 * That pair is lossy and normalising by design — it exists to render a page the
 * engine composed, not to edit a file a human wrote. Run over Arkology's real
 * 356-page corpus it produced 330 files changed / 3634 insertions / 1475
 * deletions when only 330 lines (one `ref_id:` per file) were wanted. The
 * round-trip:
 *
 *   - REORDERED keys (serializeMarkdown emits `type` then `title` first, and
 *     re-appends `tags` last, regardless of where they sat in the file)
 *   - INJECTED `type:` into files that had none, inferred from the file's path
 *   - FABRICATED `title: Untitled` where the file declared no title
 *   - DELETED `slug:` outright — parseMarkdown strips it and nothing puts it back
 *   - DELETED every YAML comment in the block
 *   - NORMALISED dates: `created: 2026-05-04` → `created: 2026-05-04T00:00:00.000Z`
 *   - REWROTE quoting: `"Weekly Sync"` → `Weekly Sync`, `https://x` → `'https://x'`
 *   - REWROTE list style: `tags: [a, b]` → block sequence, and stripped quotes
 *     from entries inside author lists
 *   - CONVERTED folded `>` scalars to literal `|`, changing the text itself
 *   - MATERIALISED empty values: `empty_key:` → `empty_key: null`
 *
 * A frontmatter block is a human artifact in the source of truth. The only
 * defensible way for a mechanical pass to touch it is to add the one line it
 * came to add. So this module never parses YAML into an object and never
 * re-emits one. It finds the block's boundaries in the raw string, scans its
 * lines textually, and splices a single line in before the closing delimiter.
 * Everything outside that splice point — body, trailing-newline state, CRLF,
 * BOM, comments, indentation, quoting — is carried through by string identity.
 *
 * The invariant this buys, pinned by test/rid-backfill-diff-shape.test.ts:
 *   every added line begins with `<key>:`, and no line is ever removed.
 */

/** UTF-8 byte-order mark. Some editors emit it; it must survive untouched. */
const BOM = '﻿';

export type StampOutcome =
  /** Key inserted. `content` is the full new file text. */
  | { status: 'stamped'; content: string }
  /** File already carries this key with this exact value. Nothing to do. */
  | { status: 'already_stamped'; existing: string }
  /** File carries this key with a DIFFERENT (or empty) value. Caller decides;
   *  we never overwrite or complete a key line that is already present, because
   *  either would mean removing a line the author wrote. */
  | { status: 'conflict'; existing: string }
  /** No parseable frontmatter block to stamp into. See the comment on
   *  findFrontmatterBlock for why this is a skip and not a synthesis. */
  | { status: 'no_frontmatter'; reason: string };

interface FrontmatterBlock {
  /** Index of the first character after the opening `---` line. */
  bodyStart: number;
  /** Index of the first character of the closing `---` line. */
  closeStart: number;
  /** Line ending used by the block, so an inserted line matches its neighbours. */
  eol: string;
}

/**
 * Locate the YAML frontmatter block in raw file text.
 *
 * Deliberately strict, and deliberately textual — it mirrors gray-matter's
 * framing rule (the file opens with a `---` line, the block ends at the next
 * line that is exactly `---`) without invoking a YAML parser. If either
 * delimiter is missing we report no block rather than guessing: a wrong guess
 * here splices a line into prose.
 */
function findFrontmatterBlock(raw: string): FrontmatterBlock | null {
  const offset = raw.startsWith(BOM) ? BOM.length : 0;

  // Opening delimiter must be the very first line: `---` plus optional trailing
  // horizontal whitespace, then a line break. A file starting with prose, or
  // with a blank line before `---`, has no frontmatter as far as gray-matter
  // (and therefore the rest of the engine) is concerned.
  const open = /^---[ \t]*\r?\n/.exec(raw.slice(offset));
  if (!open) return null;

  const bodyStart = offset + open[0].length;
  const eol = open[0].includes('\r\n') ? '\r\n' : '\n';

  // Walk lines forward to the closing delimiter. A closing line is exactly
  // `---` (trailing horizontal whitespace tolerated, as YAML allows). We scan
  // by index rather than split('\n') so every offset stays exact.
  let i = bodyStart;
  while (i <= raw.length) {
    const nl = raw.indexOf('\n', i);
    const lineEnd = nl === -1 ? raw.length : nl;
    const line = raw.slice(i, lineEnd).replace(/\r$/, '');
    if (/^---[ \t]*$/.test(line)) {
      return { bodyStart, closeStart: i, eol };
    }
    if (nl === -1) break;
    i = nl + 1;
  }

  // Unterminated block. Refuse: we cannot tell where metadata stops and the
  // document starts, and inserting into the ambiguity risks corrupting prose.
  return null;
}

/**
 * Read the value of a TOP-LEVEL key from the raw frontmatter text.
 *
 * Column-0 anchored on purpose: `  ref_id: x` nested under another mapping is
 * a different field, and treating it as the page's own identifier would make
 * the backfill both skip a real stamp and report a phantom conflict.
 *
 * Returns null when the key is absent. The value is returned with surrounding
 * quotes stripped and an inline `#` comment removed only when it follows
 * whitespace outside quotes — enough to compare an identifier for equality,
 * which is all any caller needs. This function never writes.
 */
function readTopLevelKey(fmText: string, key: string): string | null {
  const keyRe = new RegExp(`^${escapeRegExp(key)}[ \\t]*:(.*)$`);
  for (const line of fmText.split('\n')) {
    const m = keyRe.exec(line.replace(/\r$/, ''));
    if (m) return unquoteScalar(m[1]);
  }
  return null;
}

function unquoteScalar(rawValue: string): string {
  let v = rawValue.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  // Unquoted plain scalar: strip a trailing comment introduced by ` #`.
  const hash = v.search(/\s#/);
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

/**
 * Emit a scalar that YAML will read back as the exact string given.
 *
 * Single-quoted unless the value is unambiguously plain. RIDs contain colons
 * (`orn:gbrain:...`), so in practice they quote — which also matches what the
 * old serialiser wrote, keeping already-stamped files a byte-for-byte no-op
 * instead of a churn diff.
 */
function emitScalar(value: string): string {
  if (/^[A-Za-z0-9_][A-Za-z0-9_\-.]*$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert `key: value` into raw markdown's existing frontmatter block.
 *
 * The ONLY mutation is one inserted line immediately before the closing `---`.
 * Appending at the end of the block (rather than at the top) is what preserves
 * the author's key order — the existing keys keep both their relative order and
 * their absolute line numbers, so the diff is a single `+` hunk.
 */
export function stampFrontmatterKey(
  raw: string,
  key: string,
  value: string,
): StampOutcome {
  const block = findFrontmatterBlock(raw);
  if (!block) {
    return {
      status: 'no_frontmatter',
      reason:
        'file has no terminated YAML frontmatter block; refusing to synthesize one',
    };
  }

  const fmText = raw.slice(block.bodyStart, block.closeStart);
  const existing = readTopLevelKey(fmText, key);
  if (existing !== null && existing === value) {
    return { status: 'already_stamped', existing };
  }
  if (existing !== null) {
    // Present but not equal — including the malformed `ref_id:` with no value.
    // Completing or correcting it in place would mean REMOVING an authored
    // line, which is exactly the class of edit this module refuses to make.
    return { status: 'conflict', existing };
  }

  const line = `${key}: ${emitScalar(value)}${block.eol}`;
  return {
    status: 'stamped',
    content: raw.slice(0, block.closeStart) + line + raw.slice(block.closeStart),
  };
}
