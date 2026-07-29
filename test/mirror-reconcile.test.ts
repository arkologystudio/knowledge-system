/**
 * Source Mirror — reconciliation diff + the mass-deletion guard (pure logic).
 */
import { describe, expect, test } from 'bun:test';
import { contentHash, ridFor } from '../src/mirror/frontmatter';
import { objectToPath } from '../src/mirror/paths';
import { MassDeletionGuardError, planLeg } from '../src/mirror/reconcile';
import type { LegState } from '../src/mirror/state';
import type { ChangeKind } from '../src/mirror/types';
import { FakeLeg, obj } from './mirror-test-helpers';

const leg = new FakeLeg('drive', 'google_drive.file', []);

/** Build a manifest LegState from a set of objects (as if already mirrored). */
function manifestFrom(objects: ReturnType<typeof obj>[]): LegState {
  const manifest: LegState['manifest'] = {};
  for (const o of objects) {
    manifest[ridFor(leg, o)] = {
      path: objectToPath(leg, o),
      content_hash: contentHash(leg, o),
      upstream_id: o.upstreamId,
      upstream_mtime: o.upstreamMtime,
    };
  }
  return { cursor: null, manifest };
}

function kinds(objects: ReturnType<typeof obj>[], prior: LegState): Record<string, ChangeKind> {
  const plan = planLeg(leg, prior, objects);
  const out: Record<string, ChangeKind> = {};
  for (const c of plan.changes) out[c.refId] = c.kind;
  return out;
}

describe('planLeg', () => {
  const a = obj({ upstreamId: 'a', title: 'A', body: 'a1' });
  const b = obj({ upstreamId: 'b', title: 'B', body: 'b1' });

  test('a first run against an empty manifest is all new (seed = sync)', () => {
    const plan = planLeg(leg, { cursor: null, manifest: {} }, [a, b]);
    expect(plan.changes.every(c => c.kind === 'new')).toBe(true);
    expect(plan.unchanged).toBe(false);
  });

  test('an unchanged run is all unchanged', () => {
    const prior = manifestFrom([a, b]);
    const plan = planLeg(leg, prior, [a, b]);
    expect(plan.changes.every(c => c.kind === 'unchanged')).toBe(true);
    expect(plan.unchanged).toBe(true);
  });

  test('an edited body is an update; a retitle is a move; a removal is a forget', () => {
    const prior = manifestFrom([a, b]);
    const aEdited = obj({ upstreamId: 'a', title: 'A', body: 'a2-edited' });
    const bRenamed = obj({ upstreamId: 'b', title: 'B renamed', body: 'b1' });
    const result = kinds([aEdited, bRenamed], prior);
    expect(result[ridFor(leg, a)]).toBe('update');
    expect(result[ridFor(leg, b)]).toBe('move');
  });

  test('a move carries the prior path so the old file is removed', () => {
    const prior = manifestFrom([a]);
    const aRenamed = obj({ upstreamId: 'a', title: 'A renamed', body: 'a1' });
    const plan = planLeg(leg, prior, [aRenamed]);
    const move = plan.changes.find(c => c.kind === 'move');
    expect(move?.fromPath).toBe(objectToPath(leg, a));
    expect(move?.path).toBe(objectToPath(leg, aRenamed));
  });

  test('a dropped object is a forget', () => {
    const prior = manifestFrom([a, b]);
    const result = kinds([a], prior);
    expect(result[ridFor(leg, b)]).toBe('forget');
  });
});

describe('mass-deletion guard', () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    obj({ upstreamId: `id${i}`, title: `T${i}`, body: `b${i}` }),
  );

  test('an empty desired set over a non-empty manifest aborts', () => {
    const prior = manifestFrom(items);
    expect(() => planLeg(leg, prior, [])).toThrow(MassDeletionGuardError);
  });

  test('forgetting more than the threshold aborts (default 0.5)', () => {
    const prior = manifestFrom(items);
    // keep 4 of 10 → 6 forgets = 0.6 > 0.5 → trips
    expect(() => planLeg(leg, prior, items.slice(0, 4))).toThrow(MassDeletionGuardError);
  });

  test('forgetting under the threshold is allowed', () => {
    const prior = manifestFrom(items);
    // keep 6 of 10 → 4 forgets = 0.4 < 0.5 → allowed
    expect(() => planLeg(leg, prior, items.slice(0, 6))).not.toThrow();
  });

  test('the threshold is configurable', () => {
    const prior = manifestFrom(items);
    // keep 6 → 0.4 forgets, but a strict 0.3 threshold trips
    expect(() => planLeg(leg, prior, items.slice(0, 6), 0.3)).toThrow(MassDeletionGuardError);
  });

  test('the error carries the numbers for the operator', () => {
    const prior = manifestFrom(items);
    try {
      planLeg(leg, prior, []);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MassDeletionGuardError);
      const e = err as MassDeletionGuardError;
      expect(e.forgetCount).toBe(10);
      expect(e.manifestSize).toBe(10);
      expect(e.desiredSize).toBe(0);
    }
  });
});

describe('identity integrity', () => {
  test('a leg yielding two objects with the same upstream id is rejected', () => {
    const dup1 = obj({ upstreamId: 'same', title: 'One', body: 'x' });
    const dup2 = obj({ upstreamId: 'same', title: 'Two', body: 'y' });
    expect(() => planLeg(leg, { cursor: null, manifest: {} }, [dup1, dup2])).toThrow(/same identity/);
  });
});
