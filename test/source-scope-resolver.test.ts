/**
 * Source-isolation trust+grant resolver (#1924, #1371, #1393).
 *
 * The cross-source leak class: a remote OAuth client scoped to one source could
 * pass `source_id: "__all__"` (or an explicit out-of-grant source_id) to read
 * sources it was never granted. Every source-scoped read op now routes through
 * ONE resolver. These tests pin the trust+grant matrix at the unit level so a
 * future per-handler "optimization" that re-inlines the `__all__` branch fails
 * loudly here.
 */
import { describe, test, expect } from 'bun:test';
import { intersectSources, scopesForGrants, type PrincipalGrant } from '../src/core/principal-grants.ts';
import {
  resolveRequestedScope,
  resolveCodeIntelScope,
  sourceScopeOpts,
  OperationError,
  type OperationContext,
} from '../src/core/operations.ts';

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: {} as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('resolveRequestedScope — __all__ / all_sources', () => {
  test('trusted local + __all__ spans every source (empty scope)', () => {
    const scope = resolveRequestedScope(ctxOf({ remote: false, sourceId: 'a' }), '__all__');
    expect(scope).toEqual({});
  });

  test('remote + __all__ collapses to the caller grant, NOT the whole brain', () => {
    const ctx = ctxOf({ remote: true, sourceId: 'a', auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a', 'b'] } as any });
    const scope = resolveRequestedScope(ctx, '__all__');
    expect(scope).toEqual({ sourceIds: ['a', 'b'] });
  });

  test('remote + __all__ with single-source grant scopes to that one source', () => {
    const ctx = ctxOf({ remote: true, sourceId: 'a', auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a'] } as any });
    expect(resolveRequestedScope(ctx, '__all__')).toEqual({ sourceIds: ['a'] });
  });

  test('remote + __all__ with no federated grant falls back to scalar sourceId (never empty)', () => {
    const ctx = ctxOf({ remote: true, sourceId: 'a' });
    expect(resolveRequestedScope(ctx, '__all__')).toEqual({ sourceId: 'a' });
  });

  test('all_sources=true is treated identically to __all__', () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['x'] } as any });
    expect(resolveRequestedScope(ctx, undefined, true)).toEqual({ sourceIds: ['x'] });
  });
});

describe('resolveRequestedScope — explicit source_id', () => {
  test('remote + explicit source_id OUTSIDE the grant is rejected', () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a'] } as any });
    expect(() => resolveRequestedScope(ctx, 'b')).toThrow(OperationError);
    try {
      resolveRequestedScope(ctx, 'b');
    } catch (e) {
      expect((e as OperationError).code).toBe('permission_denied');
    }
  });

  test('remote + explicit source_id INSIDE the grant is allowed', () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a', 'b'] } as any });
    expect(resolveRequestedScope(ctx, 'b')).toEqual({ sourceId: 'b' });
  });

  test('trusted local + explicit source_id is allowed even with no grant', () => {
    expect(resolveRequestedScope(ctxOf({ remote: false }), 'anything')).toEqual({ sourceId: 'anything' });
  });

  test('remote with no federated grant array can pass an explicit source_id (scalar-floor model)', () => {
    // allowedSources undefined → no federated restriction to enforce; the scalar
    // sourceId path governs. (Empty [] is treated the same as undefined.)
    expect(resolveRequestedScope(ctxOf({ remote: true }), 'z')).toEqual({ sourceId: 'z' });
    const emptyGrant = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: [] } as any });
    expect(resolveRequestedScope(emptyGrant, 'z')).toEqual({ sourceId: 'z' });
  });
});

describe('resolveRequestedScope — default (no param)', () => {
  test('falls back to the canonical sourceScopeOpts ladder (federated array wins)', () => {
    const ctx = ctxOf({ remote: true, sourceId: 'a', auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a', 'b'] } as any });
    expect(resolveRequestedScope(ctx, undefined)).toEqual({ sourceIds: ['a', 'b'] });
  });

  test('falls back to scalar sourceId when no federated grant', () => {
    expect(resolveRequestedScope(ctxOf({ remote: true, sourceId: 'a' }), undefined)).toEqual({ sourceId: 'a' });
  });
});

describe('resolveCodeIntelScope — single-source code traversal', () => {
  test('scalar sourceId → that source, allSources false', () => {
    expect(resolveCodeIntelScope(ctxOf({ remote: true, sourceId: 'a' }), undefined)).toEqual({ allSources: false, sourceId: 'a' });
  });

  test('single-element federated grant → that one source', () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['only'] } as any });
    expect(resolveCodeIntelScope(ctx, '__all__')).toEqual({ allSources: false, sourceId: 'only' });
  });

  test('multi-source federated grant → rejected (must specify one)', () => {
    const ctx = ctxOf({ remote: true, sourceId: 'a', auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a', 'b'] } as any });
    expect(() => resolveCodeIntelScope(ctx, '__all__')).toThrow(OperationError);
  });

  test('trusted local + all → allSources true (spans the brain)', () => {
    // ctx.sourceId is empty so the resolver yields {} → trusted-local allSources.
    expect(resolveCodeIntelScope(ctxOf({ remote: false, sourceId: '' }), '__all__')).toEqual({ allSources: true, sourceId: undefined });
  });

  test('remote with no source in scope is denied, never widened to all', () => {
    const ctx = ctxOf({ remote: true, sourceId: '' });
    expect(() => resolveCodeIntelScope(ctx, '__all__')).toThrow(OperationError);
  });
});

// ---------------------------------------------------------------------------
// KS-A: a principal's (source, role) grants feed the SAME resolver. Building
// the AuthInfo the way mintPrincipalToken does (allowedSources = the grant
// intersection) must produce identical isolation to a native OAuth client — no
// second enforcement path.
// ---------------------------------------------------------------------------
describe('resolveRequestedScope — principal grants feed the ladder unchanged', () => {
  // A principal granted read on space A + write on space B.
  const grants: PrincipalGrant[] = [
    { source_id: 'space-a', role: 'read' },
    { source_id: 'space-b', role: 'write' },
  ];
  const allowed = intersectSources(grants.map((g) => g.source_id));
  const scopes = scopesForGrants(grants);
  const principalAuth = { token: 't', clientId: 'principal:human:x', scopes, allowedSources: allowed } as any;

  test('the grant intersection becomes the federated read scope', () => {
    const ctx = ctxOf({ remote: true, auth: principalAuth });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['space-a', 'space-b'] });
  });

  test('an in-grant explicit source resolves; an out-of-grant one is denied', () => {
    const ctx = ctxOf({ remote: true, auth: principalAuth });
    expect(resolveRequestedScope(ctx, 'space-a')).toEqual({ sourceId: 'space-a' });
    expect(() => resolveRequestedScope(ctx, 'space-z')).toThrow(OperationError);
  });

  test('a single-source grant (agent ≤ owner) scopes to exactly that source', () => {
    const narrowed = intersectSources(grants.map((g) => g.source_id), ['space-a']);
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'pat', scopes: scopesForGrants(grants.filter((g) => narrowed.includes(g.source_id))), allowedSources: narrowed } as any });
    expect(resolveRequestedScope(ctx, undefined)).toEqual({ sourceIds: ['space-a'] });
    expect(() => resolveRequestedScope(ctx, 'space-b')).toThrow(OperationError);
  });
});
