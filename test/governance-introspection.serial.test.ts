/**
 * GOV-2 — Token seam: KS verifies governance-minted tokens (consumer half).
 *
 * The KS's `verifyAccessToken` gains a governance-introspection branch (RFC
 * 7662): a token carrying a governance prefix (`hab_at_` / `hab_pat_`) is
 * resolved by introspecting against the co-located governance service, and its
 * `allowed_sources` becomes `AuthInfo.allowedSources`. The local DB path is
 * retained only for the transitional bootstrap/legacy admin token.
 *
 * This suite is the PRIMARY security proof for the seam (FE QA tier = none). It
 * pins the byte-identical cross-repo contract fixture and asserts EVERY
 * fail-closed exit: not-configured, inactive, empty/missing scope, expired,
 * unreachable, non-200, malformed JSON — all DENY, never the local path, never
 * the scalar `default`. Plus the bounded cache (TTL=0 re-introspects; active
 * cached; active:false never cached).
 *
 * Serial: stubs `globalThis.fetch`. Hermetic via PGLite in-memory (the SQL is
 * only touched by the non-governance local-path fall-through test).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

// The byte-identical shared contract artifact (copied from habitat-governance
// origin/staging; GOV-1 tests against the same file). This checksum is the
// cross-repo acceptance gate — if the producer changes the shape, this fails
// until the fixture is re-synced and both sides agree.
const CONTRACT_SHA256 = 'dec84746730da912facec41111358a73112cdcfaa52efb3744ce34552056a250';
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'governance-introspection.contract.json');
const fixtureRaw = readFileSync(FIXTURE_PATH);
const contract = JSON.parse(fixtureRaw.toString('utf8'));

const INTROSPECT_URL = 'https://governance.internal/v1/introspect';
const GOV_TOKEN = 'hab_at_' + 'a'.repeat(64);
const PAT_TOKEN = 'hab_pat_' + 'b'.repeat(64);

let engine: PGLiteEngine;
const realFetch = globalThis.fetch;

/** Install a fetch stub that returns `impl(url, init)`; returns a call counter. */
function stubFetch(impl: (url: any, init: any) => Promise<any> | any): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async (url: any, init: any) => {
    counter.calls++;
    return impl(url, init);
  }) as typeof globalThis.fetch;
  return counter;
}

// The canonical fixture's `expires_at` is a fixed example epoch (see the
// fixture $comment: "tests assert the FIELD SET and shape, not literal
// values"), which is in the past relative to any real run. Active-path tests
// inject a live expiry so they exercise a non-expired token; the field-set pin
// test below asserts the literal contract shape separately.
const LIVE_EXPIRY = Math.floor(Date.now() / 1000) + 3600;

/** A well-formed 200 JSON response, RFC-7662-active (with a live expiry). */
function activeResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ...contract.response_active, expires_at: LIVE_EXPIRY, ...overrides }),
  };
}

function providerWith(overrides: Record<string, unknown> = {}): GBrainOAuthProvider {
  return new GBrainOAuthProvider({
    sql: sqlQueryForEngine(engine),
    governanceIntrospectUrl: INTROSPECT_URL,
    governanceClientId: 'knowledge-system',
    governanceClientSecret: 'test-secret',
    ...overrides,
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (engine) await engine.disconnect();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Contract fixture pin (cross-repo acceptance gate)
// ---------------------------------------------------------------------------

describe('GOV-2 contract fixture pin (byte-identical to habitat-governance)', () => {
  test('KS copy is byte-identical to the producer fixture (sha256)', () => {
    const sha = createHash('sha256').update(fixtureRaw).digest('hex');
    expect(sha).toBe(CONTRACT_SHA256);
  });

  test('active_field_set exactly matches the keys of response_active', () => {
    const keys = Object.keys(contract.response_active).sort();
    const declared = [...contract.active_field_set].sort();
    expect(declared).toEqual(keys);
  });

  test('the token prefixes are the ones KS routes on', () => {
    expect(contract.token_prefixes.access).toBe('hab_at_');
    expect(contract.token_prefixes.pat).toBe('hab_pat_');
  });

  test('inactive response is { active:false } ONLY (RFC 7662 §2.2, no leaked claims)', () => {
    expect(contract.response_inactive).toEqual({ active: false });
  });
});

// ---------------------------------------------------------------------------
// Active token → AuthInfo with correct allowedSources
// ---------------------------------------------------------------------------

describe('GOV-2 active token → AuthInfo', () => {
  test('active:true yields AuthInfo with allowedSources from the response', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = providerWith();
    const auth = (await provider.verifyAccessToken(GOV_TOKEN)) as any;

    expect(auth.token).toBe(GOV_TOKEN);
    expect(auth.allowedSources).toEqual(['zoa']);
    expect(auth.clientId).toBe(contract.response_active.token_id); // token_id → clientId
    expect(auth.clientName).toBe(contract.response_active.client_name);
    expect(auth.scopes).toEqual(['read']);
    expect(auth.expiresAt).toBe(LIVE_EXPIRY);
    // sourceId stays undefined so sourceScopeOpts prefers the federated array.
    expect(auth.sourceId).toBeUndefined();
    expect(counter.calls).toBe(1);
  });

  test('introspection call is RFC-7662 shaped (Basic auth + form body)', async () => {
    let seenUrl = '';
    let seenInit: any = {};
    stubFetch((url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return activeResponse();
    });
    await providerWith().verifyAccessToken(GOV_TOKEN);

    expect(seenUrl).toBe(INTROSPECT_URL);
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const expectedBasic = 'Basic ' + Buffer.from('knowledge-system:test-secret').toString('base64');
    expect(seenInit.headers.Authorization).toBe(expectedBasic);
    expect(seenInit.body).toContain('token=' + GOV_TOKEN);
    expect(seenInit.body).toContain('token_type_hint=access_token');
  });

  test('hab_pat_ prefix is also routed to introspection', async () => {
    const counter = stubFetch(() => activeResponse());
    const auth = (await providerWith().verifyAccessToken(PAT_TOKEN)) as any;
    expect(auth.allowedSources).toEqual(['zoa']);
    expect(counter.calls).toBe(1);
  });

  test('PAT (expires_at null) → revocable-immortal AuthInfo with far-future expiry', async () => {
    stubFetch(() => activeResponse({ expires_at: null }));
    const now = Math.floor(Date.now() / 1000);
    const auth = (await providerWith().verifyAccessToken(PAT_TOKEN)) as any;
    expect(typeof auth.expiresAt).toBe('number');
    expect(auth.expiresAt).toBeGreaterThan(now + 300 * 24 * 3600);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed paths (the security crux)
// ---------------------------------------------------------------------------

describe('GOV-2 fail-closed (every deny path)', () => {
  test('not configured (no URL) → governance token DENIES, never local path', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) }); // no governance config
    await expect(provider.verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/not configured/i);
    expect(counter.calls).toBe(0); // never even called the endpoint
  });

  test('configured URL but missing client credentials → DENY (misconfig fails closed)', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = new GBrainOAuthProvider({
      sql: sqlQueryForEngine(engine),
      governanceIntrospectUrl: INTROSPECT_URL,
      // no client id/secret
    });
    await expect(provider.verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/not configured/i);
    expect(counter.calls).toBe(0);
  });

  test('active:false → DENY (zero access)', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => contract.response_inactive }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow();
  });

  test('active:true but empty allowed_sources → DENY (never unscoped / default)', async () => {
    stubFetch(() => activeResponse({ allowed_sources: [] }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/allowed sources/i);
  });

  test('active:true but missing allowed_sources → DENY', async () => {
    stubFetch(() => activeResponse({ allowed_sources: undefined }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/allowed sources/i);
  });

  test('active:true but allowed_sources holds only junk (non-strings/empties) → DENY', async () => {
    stubFetch(() => activeResponse({ allowed_sources: ['', 123, null] }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/allowed sources/i);
  });

  test('active:true but expires_at in the past → DENY (defensive clock-skew re-check)', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    stubFetch(() => activeResponse({ expires_at: past }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/expired/i);
  });

  test('introspection unreachable (fetch throws) → DENY, never local path', async () => {
    const counter = stubFetch(() => { throw new Error('ECONNREFUSED'); });
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/unreachable/i);
    expect(counter.calls).toBe(1);
  });

  test('non-200 response → DENY', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/failed/i);
  });

  test('malformed JSON body → DENY', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }));
    await expect(providerWith().verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/unreachable/i);
  });
});

// ---------------------------------------------------------------------------
// Prefix routing — non-governance tokens keep the local path
// ---------------------------------------------------------------------------

describe('GOV-2 prefix routing', () => {
  test('non-governance token is NOT introspected (takes local DB path)', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = providerWith();
    // A bootstrap/legacy-shaped token with no DB row → local path throws
    // "Invalid token", proving it did NOT enter the governance branch (which
    // would have thrown a governance-specific message or called fetch).
    await expect(provider.verifyAccessToken('gbrain_cl_' + 'c'.repeat(40))).rejects.toThrow(/invalid token/i);
    expect(counter.calls).toBe(0);
  });

  test('custom prefixes override the default set', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = providerWith({ governanceTokenPrefixes: ['zoa_tok_'] });
    // hab_at_ is no longer a governance prefix → local path, no introspection.
    await expect(provider.verifyAccessToken(GOV_TOKEN)).rejects.toThrow(/invalid token/i);
    expect(counter.calls).toBe(0);
    // The custom prefix IS introspected.
    const auth = (await provider.verifyAccessToken('zoa_tok_' + 'd'.repeat(40))) as any;
    expect(auth.allowedSources).toEqual(['zoa']);
    expect(counter.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bounded cache
// ---------------------------------------------------------------------------

describe('GOV-2 bounded cache', () => {
  test('default TTL=0 re-introspects on every read (instant revocation)', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = providerWith(); // TTL defaults to 0
    await provider.verifyAccessToken(GOV_TOKEN);
    await provider.verifyAccessToken(GOV_TOKEN);
    expect(counter.calls).toBe(2);
  });

  test('TTL=0: a token revoked at governance denies on the very next read', async () => {
    let active = true;
    stubFetch(() => (active
      ? activeResponse()
      : { ok: true, status: 200, json: async () => ({ active: false }) }));
    const provider = providerWith();
    const first = (await provider.verifyAccessToken(GOV_TOKEN)) as any;
    expect(first.allowedSources).toEqual(['zoa']);
    active = false; // revoked at governance
    await expect(provider.verifyAccessToken(GOV_TOKEN)).rejects.toThrow();
  });

  test('TTL>0: active result is cached (second read served without a call)', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = providerWith({ governanceCacheTtlMs: 5000 });
    await provider.verifyAccessToken(GOV_TOKEN);
    await provider.verifyAccessToken(GOV_TOKEN);
    expect(counter.calls).toBe(1);
  });

  test('active:false is NEVER cached — a later active read is not served a cached deny', async () => {
    let active = false;
    const counter = stubFetch(() => (active
      ? activeResponse()
      : { ok: true, status: 200, json: async () => ({ active: false }) }));
    const provider = providerWith({ governanceCacheTtlMs: 5000 });
    await expect(provider.verifyAccessToken(GOV_TOKEN)).rejects.toThrow(); // deny, not cached
    active = true;
    const auth = (await provider.verifyAccessToken(GOV_TOKEN)) as any; // must re-introspect
    expect(auth.allowedSources).toEqual(['zoa']);
    expect(counter.calls).toBe(2);
  });

  test('negative / NaN TTL clamps to disabled (re-introspects)', async () => {
    const counter = stubFetch(() => activeResponse());
    const provider = providerWith({ governanceCacheTtlMs: -1 });
    await provider.verifyAccessToken(GOV_TOKEN);
    await provider.verifyAccessToken(GOV_TOKEN);
    expect(counter.calls).toBe(2);
  });
});
