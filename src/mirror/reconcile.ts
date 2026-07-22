/**
 * Reconciliation: diff a leg's desired set against the manifest, guard against
 * mass deletion, and apply the result.
 *
 * Seed and sync are ONE code path — the first run is just a reconcile against an
 * empty manifest. Identity is keyed on the RID (from the upstream's stable id),
 * so a rename is a MOVE, not a delete-and-recreate. The mass-deletion guard is
 * the most important rail: the canonical failure of every sync tool is an auth
 * glitch returning an empty set that is then faithfully applied as "delete
 * everything". Here that aborts the leg instead.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentHash, ridFor, renderFile } from './frontmatter';
import { assertUnderSources, objectToPath } from './paths';
import type { LegState, ManifestEntry } from './state';
import type { LegPlan, MirrorSource, PlannedChange, SourceObject } from './types';

/** Default fraction of a leg's manifest that may be forgotten in one run before the guard trips. */
export const MASS_DELETION_DEFAULT = 0.5;

/** Raised when the mass-deletion guard refuses to apply a run. Carries the numbers for the operator. */
export class MassDeletionGuardError extends Error {
  constructor(
    public readonly legId: string,
    public readonly forgetCount: number,
    public readonly manifestSize: number,
    public readonly desiredSize: number,
  ) {
    super(
      `Source Mirror mass-deletion guard tripped for leg "${legId}": ` +
        `${forgetCount}/${manifestSize} mirrored items would be removed ` +
        `(desired set has ${desiredSize}). Refusing to commit. This usually means an ` +
        `upstream credential or fetch failure returned a short/empty result — investigate ` +
        `before re-running.`,
    );
    this.name = 'MassDeletionGuardError';
  }
}

interface DesiredEntry {
  obj: SourceObject;
  rid: string;
  path: string;
  hash: string;
}

/** Build the desired map, minting RID/path/hash for each object. Throws on a duplicate RID (identity collision). */
function indexDesired(leg: MirrorSource, desired: SourceObject[]): Map<string, DesiredEntry> {
  const map = new Map<string, DesiredEntry>();
  for (const obj of desired) {
    const rid = ridFor(leg, obj);
    if (map.has(rid)) {
      throw new Error(
        `Source Mirror: leg "${leg.id}" yielded two objects with the same identity ${rid} ` +
          `(upstream id "${obj.upstreamId}"). Upstream ids must be unique within a leg.`,
      );
    }
    map.set(rid, { obj, rid, path: objectToPath(leg, obj), hash: contentHash(leg, obj) });
  }
  return map;
}

/** Highest ISO-8601 upstream mtime in the desired set, or null when empty. */
function maxMtime(desired: SourceObject[]): string | null {
  let max: string | null = null;
  for (const o of desired) if (max === null || o.upstreamMtime > max) max = o.upstreamMtime;
  return max;
}

/**
 * Compute the reconciliation plan for a leg (pure). Runs the mass-deletion guard
 * and throws `MassDeletionGuardError` if it trips — before any write is planned.
 */
export function planLeg(
  leg: MirrorSource,
  prior: LegState,
  desired: SourceObject[],
  threshold: number = MASS_DELETION_DEFAULT,
): LegPlan {
  const desiredMap = indexDesired(leg, desired);
  const priorManifest = prior.manifest;
  const changes: PlannedChange[] = [];

  for (const [rid, d] of desiredMap) {
    const prev = priorManifest[rid];
    if (!prev) {
      // First time we've seen this identity.
      changes.push({ kind: 'new', refId: rid, path: d.path });
    } else if (prev.path !== d.path) {
      // The path changed — a relocation (typically an upstream rename). Identity
      // (the RID) is unchanged, so inbound links survive; we write the new path
      // and delete the old one. Content may also have changed; either way it is a
      // rewrite-and-relocate.
      changes.push({ kind: 'move', refId: rid, path: d.path, fromPath: prev.path });
    } else if (prev.content_hash !== d.hash) {
      // Same path, changed content — an in-place update.
      changes.push({ kind: 'update', refId: rid, path: d.path });
    } else {
      changes.push({ kind: 'unchanged', refId: rid, path: d.path });
    }
  }

  const forgets: PlannedChange[] = [];
  for (const rid of Object.keys(priorManifest)) {
    if (!desiredMap.has(rid)) {
      forgets.push({ kind: 'forget', refId: rid, path: priorManifest[rid].path });
    }
  }

  const manifestSize = Object.keys(priorManifest).length;
  const forgetCount = forgets.length;
  const emptyWipe = manifestSize > 0 && desired.length === 0;
  const overThreshold = manifestSize > 0 && forgetCount / manifestSize > threshold;
  if (emptyWipe || overThreshold) {
    throw new MassDeletionGuardError(leg.id, forgetCount, manifestSize, desired.length);
  }

  changes.push(...forgets);

  const nextCursor = maxMtime(desired) ?? prior.cursor;
  const unchanged = changes.every(c => c.kind === 'unchanged');
  return { legId: leg.id, changes, nextCursor, unchanged };
}

/** The result of applying a plan: the new leg state and the repo-relative paths that changed (for the commit). */
export interface ApplyResult {
  legState: LegState;
  touchedPaths: string[];
}

function writeFile(repoRoot: string, repoRelPath: string, contents: string): void {
  const abs = assertUnderSources(repoRoot, repoRelPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
}

function deleteFile(repoRoot: string, repoRelPath: string): void {
  const abs = assertUnderSources(repoRoot, repoRelPath);
  if (existsSync(abs)) unlinkSync(abs);
}

/**
 * Apply a plan to the filesystem and return the updated leg state. Every write
 * and delete passes through `assertUnderSources`, so a defect can never escape
 * `sources/`. Idempotent: an all-unchanged plan touches nothing.
 */
export function applyLeg(
  repoRoot: string,
  leg: MirrorSource,
  prior: LegState,
  desired: SourceObject[],
  plan: LegPlan,
  mirroredAt: string,
): ApplyResult {
  const manifest: Record<string, ManifestEntry> = { ...prior.manifest };
  const desiredMap = indexDesired(leg, desired);
  const touched = new Set<string>();

  for (const change of plan.changes) {
    if (change.kind === 'unchanged') continue;
    if (change.kind === 'forget') {
      deleteFile(repoRoot, change.path);
      delete manifest[change.refId];
      touched.add(change.path);
      continue;
    }
    // new | update | move
    const d = desiredMap.get(change.refId);
    if (!d) continue; // defensive; plan and desired are built from the same set
    writeFile(repoRoot, change.path, renderFile(leg, d.obj, mirroredAt));
    touched.add(change.path);
    if (change.fromPath && change.fromPath !== change.path) {
      deleteFile(repoRoot, change.fromPath);
      touched.add(change.fromPath);
    }
    manifest[change.refId] = {
      path: d.path,
      content_hash: d.hash,
      upstream_id: d.obj.upstreamId,
      upstream_mtime: d.obj.upstreamMtime,
    };
  }

  return {
    legState: { cursor: plan.nextCursor, manifest },
    touchedPaths: [...touched],
  };
}

/** A one-line human summary of a plan (for dry-run output and commit messages). */
export function summarisePlan(plan: LegPlan): string {
  const count = (k: string) => plan.changes.filter(c => c.kind === k).length;
  return `+${count('new')} ~${count('update')} >${count('move')} -${count('forget')} =${count('unchanged')}`;
}
