/**
 * stdio MCP transport — ctx.auth threading + fail-closed source scoping.
 *
 * The bug this pins: the stdio serve transport (`gbrain serve` over an
 * SSH-gated stdio pipe — the production `knowledge-system-serve` shape)
 * dispatched with `remote: true` and NO `ctx.auth`. Consequences:
 *
 *   1. `whoami` fell through to the fail-closed `unknown_transport` throw.
 *   2. `resolveRequestedScope`'s out-of-grant guard was INERT — with
 *      `ctx.auth?.allowedSources` undefined the resolver runs the
 *      "scalar-floor model" and honours ANY `source_id` the caller names.
 *      Harmless with a single `default` source; a cross-scope read the
 *      moment a second source/tenant exists.
 *
 * The fix threads a synthetic principal (`buildStdioAuth`) whose
 * `allowedSources: [sourceId]` grant makes the resolver fail-closed while
 * preserving single-source behaviour. These tests are the multi-scope
 * isolation proof required before any multi-tenancy work lands on top.
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveRequestedScope,
  OperationError,
  STDIO_LOCAL_CLIENT_ID,
  type OperationContext,
} from '../src/core/operations.ts';
import { buildStdioAuth } from '../src/mcp/dispatch.ts';

/** A ctx as the stdio transport builds it: remote=true, auth = stdio principal. */
function stdioCtx(sourceId: string): OperationContext {
  return {
    engine: {} as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth: buildStdioAuth(sourceId),
  } as OperationContext;
}

describe('buildStdioAuth — shape', () => {
  test('carries the sentinel clientId + single-source federated grant', () => {
    const auth = buildStdioAuth('default');
    expect(auth.clientId).toBe(STDIO_LOCAL_CLIENT_ID);
    expect(auth.allowedSources).toEqual(['default']);
    expect(auth.sourceId).toBe('default');
    // Honest capability; inert for stdio authorization (no hasScope gate).
    expect(auth.scopes).toEqual(['read', 'write']);
  });

  test('scopes the grant to the operator-configured source', () => {
    expect(buildStdioAuth('zoa-confidential').allowedSources).toEqual(['zoa-confidential']);
  });
});

describe('stdio transport — fail-closed source scoping (the seal)', () => {
  test('an out-of-grant source_id is REJECTED (was silently honoured pre-fix)', () => {
    const ctx = stdioCtx('default');
    expect(() => resolveRequestedScope(ctx, 'zoa-confidential')).toThrow(OperationError);
    try {
      resolveRequestedScope(ctx, 'zoa-confidential');
    } catch (e) {
      expect((e as OperationError).code).toBe('permission_denied');
    }
  });

  test('the in-grant source_id is allowed', () => {
    expect(resolveRequestedScope(stdioCtx('default'), 'default')).toEqual({ sourceId: 'default' });
  });

  test('no source_id → scoped to the pipe grant, never the whole brain', () => {
    expect(resolveRequestedScope(stdioCtx('default'), undefined)).toEqual({ sourceIds: ['default'] });
  });

  test('__all__ collapses to the pipe grant, NOT every source', () => {
    // A stdio caller must not opt out of its grant by naming __all__.
    expect(resolveRequestedScope(stdioCtx('default'), '__all__')).toEqual({ sourceIds: ['default'] });
  });
});

describe('regression guard — the pre-fix leak shape', () => {
  test('WITHOUT stdio auth, an out-of-grant source_id leaks (documents why the fix is needed)', () => {
    // This is the exact behaviour the fix removes from the stdio path: a
    // remote ctx with no allowedSources grant runs the scalar-floor model and
    // returns whatever source_id was asked for. Kept as an explicit contrast
    // so a future regression that drops `auth` from the stdio dispatch is
    // visible here, not just in production.
    const leakyCtx = {
      engine: {} as any,
      config: {} as any,
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      // auth intentionally absent — the pre-fix stdio shape
    } as OperationContext;
    expect(resolveRequestedScope(leakyCtx, 'zoa-confidential')).toEqual({ sourceId: 'zoa-confidential' });
  });
});
