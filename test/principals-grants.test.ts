/**
 * KS-A principal grants → token scope, end to end.
 *
 * Proves the identity layer above the `allowedSources` enforcement ladder:
 *   - grant resolution + role→scope + requested∩granted intersection,
 *   - mintPrincipalToken issues a short-TTL token whose allowedSources = the
 *     grant intersection, verifiable through the legacy-fallback read path,
 *   - the mint→verify→resolveRequestedScope cross-scope isolation proof (a
 *     principal granted space A gets permission_denied on B),
 *   - scoped PATs (long-lived, revocable),
 *   - and — the security headline — FAIL-CLOSED behavior: a zero-grant
 *     principal, an empty requested-intersection, and a defense-in-depth
 *     empty-allowed_sources row all DENY, never defaulting to `default`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import {
  resolvePrincipalGrants,
  intersectSources,
  scopesForGrants,
  roleToScopes,
} from '../src/core/principal-grants.ts';
import { sourceScopeOpts, resolveRequestedScope, OperationError } from '../src/core/operations.ts';
import type { AuthInfo, OperationContext } from '../src/core/operations.ts';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken } from '../src/core/utils.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let sql: ReturnType<typeof sqlQueryForEngine>;

// Principal ids captured at setup.
let alice: number; // granted read on src-a, write on src-b
let bob: number; //   granted admin on src-a only
let carol: number; // no grants

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sql = sqlQueryForEngine(engine);
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60 });

  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('src-a','Space A'),('src-b','Space B') ON CONFLICT DO NOTHING`);

  const [a] = await engine.executeRaw<{ id: number }>(`INSERT INTO principals (kind, subject) VALUES ('human','alice@ark') RETURNING id`);
  alice = Number(a.id);
  const [b] = await engine.executeRaw<{ id: number }>(`INSERT INTO principals (kind, subject) VALUES ('agent','bob-agent') RETURNING id`);
  bob = Number(b.id);
  const [c] = await engine.executeRaw<{ id: number }>(`INSERT INTO principals (kind, subject) VALUES ('human','carol@ark') RETURNING id`);
  carol = Number(c.id);

  await engine.executeRaw(`INSERT INTO principal_source_grants (principal_id, source_id, role) VALUES ($1,'src-a','read'),($1,'src-b','write')`, [alice]);
  await engine.executeRaw(`INSERT INTO principal_source_grants (principal_id, source_id, role) VALUES ($1,'src-a','admin')`, [bob]);
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('grant helpers', () => {
  test('roleToScopes expands the hierarchy', () => {
    expect(roleToScopes('read')).toEqual(['read']);
    expect(roleToScopes('write')).toEqual(['read', 'write']);
    expect(roleToScopes('admin')).toEqual(['read', 'write', 'admin']);
  });

  test('scopesForGrants takes the highest role over the included set', () => {
    expect(scopesForGrants([{ source_id: 's', role: 'read' }])).toEqual(['read']);
    expect(scopesForGrants([
      { source_id: 's1', role: 'read' },
      { source_id: 's2', role: 'write' },
    ])).toEqual(['read', 'write']);
    expect(scopesForGrants([])).toEqual([]); // empty → caller must deny
  });

  test('intersectSources never widens beyond the grant', () => {
    expect(intersectSources(['a', 'b'], ['b', 'c']).sort()).toEqual(['b']);
    expect(intersectSources(['a', 'b']).sort()).toEqual(['a', 'b']); // no request = all grants
    expect(intersectSources(['a'], ['zzz'])).toEqual([]); // out-of-grant request → empty (deny signal)
  });

  test('resolvePrincipalGrants reads the grant rows', async () => {
    const grants = await resolvePrincipalGrants(sql, alice);
    expect(grants.sort((x, y) => x.source_id.localeCompare(y.source_id))).toEqual([
      { source_id: 'src-a', role: 'read' },
      { source_id: 'src-b', role: 'write' },
    ]);
    expect(await resolvePrincipalGrants(sql, carol)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mintPrincipalToken → verifyAccessToken
// ---------------------------------------------------------------------------

describe('mintPrincipalToken', () => {
  test('mints a token scoped to the grant intersection, verifiable through the read path', async () => {
    const minted = await provider.mintPrincipalToken({ subject: 'alice@ark', requestedSources: ['src-a'] });
    expect(minted.allowed_sources).toEqual(['src-a']);
    expect(minted.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const info = (await provider.verifyAccessToken(minted.access_token)) as unknown as AuthInfo;
    expect(info.allowedSources).toEqual(['src-a']);
    expect(info.sourceId).toBe('src-a');
    // alice's role on src-a is read → read-only token.
    expect(info.scopes).toEqual(['read']);
  });

  test('omitting requested_sources grants the full set; scope = highest role', async () => {
    const minted = await provider.mintPrincipalToken({ subject: 'alice@ark' });
    expect(minted.allowed_sources.sort()).toEqual(['src-a', 'src-b']);
    const info = (await provider.verifyAccessToken(minted.access_token)) as unknown as AuthInfo;
    // spans src-a(read) + src-b(write) → highest = write.
    expect(info.scopes).toEqual(['read', 'write']);
  });

  test('CROSS-SCOPE ISOLATION: a token granted space A is permission_denied on B', async () => {
    const minted = await provider.mintPrincipalToken({ subject: 'bob-agent', kind: 'agent' });
    const info = (await provider.verifyAccessToken(minted.access_token)) as unknown as AuthInfo;
    expect(info.allowedSources).toEqual(['src-a']);

    const ctx = { remote: true, sourceId: 'default', auth: info } as unknown as OperationContext;
    // In-grant source resolves fine.
    expect(resolveRequestedScope(ctx, 'src-a')).toEqual({ sourceId: 'src-a' });
    // The federated grant reaches the enforcement ladder.
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['src-a'] });
    // Out-of-grant source is denied — the exact leak the ctx.auth fix sealed.
    expect(() => resolveRequestedScope(ctx, 'src-b')).toThrow(OperationError);
  });

  test('FAIL-CLOSED: unknown principal → deny', async () => {
    await expect(provider.mintPrincipalToken({ subject: 'nobody@ark' })).rejects.toThrow(/unknown principal/i);
  });

  test('FAIL-CLOSED: zero-grant principal → deny (never an empty allowedSources)', async () => {
    await expect(provider.mintPrincipalToken({ subject: 'carol@ark' })).rejects.toThrow(/no source grants/i);
  });

  test('FAIL-CLOSED: empty requested-intersection → deny', async () => {
    await expect(
      provider.mintPrincipalToken({ subject: 'alice@ark', requestedSources: ['src-nonexistent'] }),
    ).rejects.toThrow(/no granted sources match/i);
  });
});

// ---------------------------------------------------------------------------
// Personal Access Tokens
// ---------------------------------------------------------------------------

describe('issuePersonalAccessToken', () => {
  test('issues a long-lived scoped PAT (no expiry) that verifies and revokes', async () => {
    const pat = await provider.issuePersonalAccessToken({ principalId: bob, label: 'bob-laptop' });
    expect(pat.allowed_sources).toEqual(['src-a']);
    expect(pat.scopes).toEqual(['read', 'write', 'admin']); // bob is admin on src-a

    const info = (await provider.verifyAccessToken(pat.access_token)) as unknown as AuthInfo;
    expect(info.allowedSources).toEqual(['src-a']);

    // Revoke by label → the token stops verifying.
    await engine.executeRaw(`UPDATE access_tokens SET revoked_at = now() WHERE name = 'bob-laptop'`);
    await expect(provider.verifyAccessToken(pat.access_token)).rejects.toThrow(InvalidTokenError);
  });

  test('a PAT can be scoped BELOW the principal grant (least privilege / agent ≤ owner)', async () => {
    // alice holds src-a + src-b; issue a PAT limited to src-a only.
    const pat = await provider.issuePersonalAccessToken({ principalId: alice, label: 'alice-readonly-agent', requestedSources: ['src-a'] });
    expect(pat.allowed_sources).toEqual(['src-a']);
    expect(pat.scopes).toEqual(['read']);
  });
});

// ---------------------------------------------------------------------------
// verifyAccessToken — expiry + defense-in-depth
// ---------------------------------------------------------------------------

describe('principal-token read path (defense-in-depth)', () => {
  test('an expired minted token is rejected', async () => {
    // Directly plant a principal row with a past expiry (mint can only set a
    // future one). expires_at is epoch SECONDS.
    const past = Math.floor(Date.now() / 1000) - 10;
    const raw = 'gbrain_at_expired_' + Math.random().toString(16).slice(2);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, scopes, principal_id, allowed_sources, expires_at)
       VALUES ('expired-tok', $1, ARRAY['read'], $2, ARRAY['src-a'], $3)`,
      [hashToken(raw), bob, past],
    );
    await expect(provider.verifyAccessToken(raw)).rejects.toThrow(/expired/i);
  });

  test('a principal row with EMPTY allowed_sources is DENIED, never defaulted', async () => {
    // The critical leak-class guard: an empty allowedSources would fall through
    // sourceScopeOpts to the scalar `default` source. Verify must reject.
    const raw = 'gbrain_at_empty_' + Math.random().toString(16).slice(2);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, scopes, principal_id, allowed_sources)
       VALUES ('empty-scope-tok', $1, ARRAY['read'], $2, ARRAY[]::text[])`,
      [hashToken(raw), bob],
    );
    await expect(provider.verifyAccessToken(raw)).rejects.toThrow(InvalidTokenError);
  });

  test('a legacy grandfather token (no principal, no allowed_sources) still gets full admin', async () => {
    // Regression guard: the new branch must NOT hijack pre-existing legacy tokens.
    const raw = 'gbrain_legacy_' + Math.random().toString(16).slice(2);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash) VALUES ('legacy-tok', $1)`,
      [hashToken(raw)],
    );
    const info = (await provider.verifyAccessToken(raw)) as unknown as AuthInfo;
    expect(info.scopes).toEqual(['read', 'write', 'admin']);
    expect(info.sourceId).toBe('default');
  });
});
