/**
 * The mirror state file: `<repo>/.mirror/state.json`.
 *
 * Per-leg cursors + a manifest keyed on RID. The manifest is what makes renames
 * safe (same RID + new path = a MOVE, never delete-and-recreate) and what the
 * mass-deletion guard measures against. It is versioned, diffable, and lives in
 * the repository, so it is recoverable and travels with the corpus.
 *
 * Emitted as deterministic sorted-key JSON so an unchanged run leaves the file
 * byte-identical and a real change produces a minimal, readable diff.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One manifest entry: where a RID currently lives and what it currently hashes to. */
export interface ManifestEntry {
  path: string;
  content_hash: string;
  upstream_id: string;
  upstream_mtime: string;
}

/** Per-leg persisted state. */
export interface LegState {
  /** Advisory checkpoint (max upstream mtime seen). */
  cursor: string | null;
  /** RID → entry. */
  manifest: Record<string, ManifestEntry>;
}

/** The whole state file. */
export interface MirrorState {
  version: number;
  legs: Record<string, LegState>;
}

export const STATE_VERSION = 1;
export const STATE_DIR = '.mirror';
export const STATE_FILE = 'state.json';

/** Absolute path to the state file for a repo. */
export function stateFilePath(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, STATE_FILE);
}

/** Repo-relative path to the state file (for git staging). */
export function stateFileRepoRelative(): string {
  return `${STATE_DIR}/${STATE_FILE}`;
}

/** Load state, or an empty state when none exists yet (the seed case). */
export function loadState(repoRoot: string): MirrorState {
  const p = stateFilePath(repoRoot);
  if (!existsSync(p)) return { version: STATE_VERSION, legs: {} };
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as MirrorState;
  if (!parsed.legs) parsed.legs = {};
  return parsed;
}

/** The state for one leg, or an empty leg state. */
export function legState(state: MirrorState, legId: string): LegState {
  return state.legs[legId] ?? { cursor: null, manifest: {} };
}

/** Recursively sort object keys so serialisation is deterministic. */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/** Serialise state deterministically (sorted keys, trailing newline). */
export function serialiseState(state: MirrorState): string {
  return JSON.stringify(sortKeys(state), null, 2) + '\n';
}

/** Write state to disk, creating `.mirror/` if needed. */
export function saveState(repoRoot: string, state: MirrorState): void {
  const p = stateFilePath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, serialiseState(state), 'utf8');
}
