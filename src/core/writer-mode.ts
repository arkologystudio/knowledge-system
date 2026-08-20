/**
 * Writer mode — WHERE the truth for a source's pages lives, and therefore what
 * a page write must do before it is allowed to claim success.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module, `put_page` had one behaviour for every source: write the
 * DB row, then drop an *uncommitted* `.md` into whatever checkout `sync.repo_path`
 * resolved to. On a hand-tended wiki that is exactly right — the working tree is
 * the truth and a human commits it. On a machine-managed clone it is a half-write:
 * the brain becomes authoritative for content that exists nowhere in git history,
 * and stays that way until someone happens to commit it.
 *
 * On 2026-08-18 that half-write became an incident. Two pages written via
 * `put_page` sat untracked in the Arkology mirror; an operator committed them to
 * tidy the tree; the clone diverged from origin; `--ff-only` pulls and every
 * `commit_page` push failed for a day, and the brain served three-week-old
 * content behind a green health screen. See `docs/designs/git-canonical-writes.md`.
 *
 * The fix is not "tell agents to call commit_page instead" — that is prose, and
 * prose is what failed (a CLAUDE.md actively instructed the losing call). The fix
 * is to make the dangerous state unreachable: on a machine-managed source there
 * is no code path that leaves the DB ahead of git.
 *
 * THE THREE MODES
 * ---------------
 *   git-first   Truth is `origin/main`. A write commits and PUSHES before the
 *               index is updated; a push failure is a write failure. The brain
 *               is a derived cache of a specific commit.
 *   local-tree  Truth is the working tree; a human commits. The write-through
 *               file IS the deliverable. (Ross's personal wiki: a daemon imports
 *               the tree, Obsidian commits it.)
 *   db-only     No repo at all. The DB is the truth, explicitly and visibly.
 *
 * DERIVATION, NOT FREE CHOICE
 * ---------------------------
 * The discriminator is NOT "does this source have a git remote" — the personal
 * wiki has an origin and is legitimately hand-committed. It is **"does a machine
 * pull and reset this working tree"**, which is a fact about the deployment, not
 * a preference. Declared once via `writer.managed_sources`.
 *
 * Given managed, `git-first` is FORCED: asking for `local-tree` or `db-only` on a
 * machine-managed source is refused, because that combination is the incident
 * again by configuration. Given unmanaged, the operator picks, and the default is
 * the pre-existing behaviour so nothing changes for anyone who has not declared a
 * managed source.
 */

import type { BrainEngine } from './engine.ts';

export type WriterMode = 'git-first' | 'local-tree' | 'db-only';

export const WRITER_MODES: readonly WriterMode[] = ['git-first', 'local-tree', 'db-only'];

/** Config key declaring which sources a machine pulls/resets. Comma-separated ids. */
export const MANAGED_SOURCES_KEY = 'writer.managed_sources';
/** Global default mode for UNMANAGED sources. */
export const WRITER_MODE_KEY = 'writer.mode';
/** Per-source override for UNMANAGED sources: `writer.mode.<sourceId>`. */
export function writerModeKeyFor(sourceId: string): string {
  return `${WRITER_MODE_KEY}.${sourceId}`;
}

export class WriterModeError extends Error {
  constructor(public code: 'invalid_mode' | 'managed_requires_repo' | 'mode_refused', message: string) {
    super(message);
    this.name = 'WriterModeError';
  }
}

export interface WriterResolution {
  mode: WriterMode;
  /** True when a machine pulls/resets this working tree (declared, not guessed). */
  managed: boolean;
  /** The source's checkout, or null when the source has none. */
  repoPath: string | null;
  /** Human-readable derivation, surfaced in diagnostics so this is never a mystery. */
  reason: string;
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeMode(raw: string | null | undefined): WriterMode | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return (WRITER_MODES as readonly string[]).includes(v) ? (v as WriterMode) : null;
}

/**
 * The source's on-disk checkout, or null. Shared with `git-page-write.ts` so the
 * two cannot disagree about which directory a source's writes belong in.
 *
 * `sync.repo_path` is a single-source fallback only: if ANOTHER source already
 * claims that path, this source does not get to write there (#2018 — nesting a
 * page under a sibling's working tree pollutes a repo nobody asked us to touch).
 */
export async function resolveSourceRepoPath(
  engine: BrainEngine,
  sourceId: string,
): Promise<string | null> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    'SELECT local_path FROM sources WHERE id = $1',
    [sourceId],
  );
  const own = rows[0]?.local_path ?? null;
  if (own) return own;

  const configured = await engine.getConfig('sync.repo_path');
  if (!configured) return null;

  const others = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id <> $1 AND local_path = $2 LIMIT 1',
    [sourceId, configured],
  );
  return others.length > 0 ? null : configured;
}

/** True when `sourceId` is declared machine-managed. */
export async function isManagedSource(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const declared = parseList(await engine.getConfig(MANAGED_SOURCES_KEY));
  return declared.includes(sourceId);
}

/**
 * Resolve the effective writer mode for a source. Throws rather than guessing
 * when the declared configuration is self-contradictory — a source that claims
 * to be machine-managed but has no checkout cannot be git-first, and silently
 * degrading it to db-only would reintroduce exactly the half-write this module
 * exists to remove.
 */
export async function resolveWriterMode(
  engine: BrainEngine,
  sourceId: string,
): Promise<WriterResolution> {
  const repoPath = await resolveSourceRepoPath(engine, sourceId);
  const managed = await isManagedSource(engine, sourceId);

  const rawOverride = (await engine.getConfig(writerModeKeyFor(sourceId)))
    ?? (await engine.getConfig(WRITER_MODE_KEY));
  const requested = rawOverride ? normalizeMode(rawOverride) : null;
  if (rawOverride && !requested) {
    throw new WriterModeError(
      'invalid_mode',
      `unrecognized writer mode '${rawOverride}' (expected one of: ${WRITER_MODES.join(', ')})`,
    );
  }

  if (managed) {
    if (!repoPath) {
      throw new WriterModeError(
        'managed_requires_repo',
        `source '${sourceId}' is declared in ${MANAGED_SOURCES_KEY} but has no local checkout; ` +
          `a machine-managed source must have a working tree to commit into`,
      );
    }
    if (requested && requested !== 'git-first') {
      // Refused rather than honoured: this exact combination — DB-authoritative
      // pages inside a tree a machine resets — is the 2026-08-18 incident.
      throw new WriterModeError(
        'mode_refused',
        `source '${sourceId}' is machine-managed, so writer mode is forced to 'git-first'; ` +
          `remove it from ${MANAGED_SOURCES_KEY} before selecting '${requested}'`,
      );
    }
    return {
      mode: 'git-first',
      managed: true,
      repoPath,
      reason: `declared in ${MANAGED_SOURCES_KEY}; git-first is forced for machine-managed sources`,
    };
  }

  if (requested) {
    if (requested !== 'db-only' && !repoPath) {
      throw new WriterModeError(
        'invalid_mode',
        `writer mode '${requested}' requires a local checkout, but source '${sourceId}' has none`,
      );
    }
    return {
      mode: requested,
      managed: false,
      repoPath,
      reason: `explicitly configured (${rawOverride})`,
    };
  }

  // Default preserves pre-existing behaviour exactly, so declaring nothing
  // changes nothing.
  return repoPath
    ? { mode: 'local-tree', managed: false, repoPath, reason: 'default for an unmanaged source with a checkout' }
    : { mode: 'db-only', managed: false, repoPath: null, reason: 'no checkout configured for this source' };
}
