/**
 * Principal → source-grant resolution (Knowledge System KS-A).
 *
 * The identity layer ABOVE the existing `allowedSources` enforcement ladder
 * (sourceScopeOpts / resolveRequestedScope in operations.ts). A `principal`
 * (human / agent / service) holds `(principal, source, role)` grants in
 * `principal_source_grants`; a minted token or a scoped PAT resolves those
 * grants into the `allowedSources` array the ladder already enforces.
 *
 * Re-derives habitat-KB's `CLIENT_LAYER.md` §4.2/§6 (member creds → JWT-mint →
 * per-project RBAC) against `source` (not `project`), reusing gbrain's
 * `federated_read` primitive instead of inventing a parallel one.
 *
 * FAIL-CLOSED is the whole point: a zero-grant principal must resolve to a
 * DENY, never to an empty `allowedSources` (which sourceScopeOpts treats as
 * "no federated scope" → scalar `default` fallthrough — the exact leak class
 * the ctx.auth transport fix sealed). Callers intersect requested ⊆ granted
 * and MUST reject an empty result rather than mint an unscoped token.
 */

import type { SqlQuery } from './sql-query.ts';
import type { Scope } from './scope.ts';

/** Grant role on a single source. Mirrors habitat-KB `ProjectPermission.role`. */
export type GrantRole = 'read' | 'write' | 'admin';

export const GRANT_ROLES: ReadonlySet<GrantRole> = new Set<GrantRole>(['read', 'write', 'admin']);

export function isGrantRole(s: unknown): s is GrantRole {
  return typeof s === 'string' && GRANT_ROLES.has(s as GrantRole);
}

/** Principal kind. Humans (portal), agents (PAT/OAuth), service accounts (client_credentials). */
export type PrincipalKind = 'human' | 'agent' | 'service';

export const PRINCIPAL_KINDS: ReadonlySet<PrincipalKind> = new Set<PrincipalKind>(['human', 'agent', 'service']);

export function isPrincipalKind(s: unknown): s is PrincipalKind {
  return typeof s === 'string' && PRINCIPAL_KINDS.has(s as PrincipalKind);
}

export interface PrincipalGrant {
  source_id: string;
  role: GrantRole;
}

export interface PrincipalRow {
  id: number;
  kind: PrincipalKind;
  subject: string;
  display_name: string | null;
}

/**
 * Expand a role into the flat scope list AuthInfo carries. `write` implies
 * `read`, `admin` implies `write` + `read` (mirrors the scope hierarchy in
 * scope.ts). Listing the implied scopes explicitly keeps parity with how
 * legacy tokens surface `['read','write','admin']` and makes the token's
 * capability self-describing rather than relying on hasScope() implication.
 */
export function roleToScopes(role: GrantRole): Scope[] {
  switch (role) {
    case 'admin':
      return ['read', 'write', 'admin'];
    case 'write':
      return ['read', 'write'];
    case 'read':
    default:
      return ['read'];
  }
}

const ROLE_RANK: Record<GrantRole, number> = { read: 0, write: 1, admin: 2 };

/**
 * The token-level capability for a principal token = the HIGHEST role among
 * the grants for the sources actually included in the token (least privilege:
 * ranked over the intersected/allowed set, not every grant the principal
 * holds). Returns `['read']` as the floor when the set is non-empty but every
 * grant is read. Returns `[]` for an empty grant set — the caller MUST treat
 * that as a deny, never mint a token with no scopes.
 */
export function scopesForGrants(grants: readonly PrincipalGrant[]): Scope[] {
  if (grants.length === 0) return [];
  let max: GrantRole = 'read';
  for (const g of grants) {
    if (ROLE_RANK[g.role] > ROLE_RANK[max]) max = g.role;
  }
  return roleToScopes(max);
}

/**
 * Intersect the principal's granted sources with an optional requested set.
 * - `requested` omitted/empty → all granted sources (dedup, order-stable).
 * - `requested` present → granted ∩ requested (out-of-grant requests are
 *   silently dropped, NOT an error; an empty intersection is the caller's
 *   deny signal).
 *
 * Never widens: a requested source the principal doesn't hold is excluded.
 */
export function intersectSources(granted: readonly string[], requested?: readonly string[] | null): string[] {
  const grantedSet = new Set(granted.filter((s) => typeof s === 'string' && s.length > 0));
  if (!requested || requested.length === 0) {
    return Array.from(grantedSet);
  }
  const requestedClean = requested.filter((s) => typeof s === 'string' && s.length > 0);
  return requestedClean.filter((s) => grantedSet.has(s));
}

/**
 * Resolve every `(source, role)` grant for a principal id.
 *
 * The `principal_id` bind is compared SQL-side, so the postgres.js BIGSERIAL
 * (string/bigint) vs PGLite (number) representation trap never reaches a JS
 * `===` — the DB coerces on comparison. Rows with a malformed role are dropped
 * (fail-closed) rather than trusted.
 */
export async function resolvePrincipalGrants(sql: SqlQuery, principalId: number | string | bigint): Promise<PrincipalGrant[]> {
  const rows = await sql`
    SELECT source_id, role
    FROM principal_source_grants
    WHERE principal_id = ${principalId as never}
    ORDER BY source_id
  `;
  const out: PrincipalGrant[] = [];
  for (const r of rows) {
    const source_id = r.source_id as string;
    const role = r.role as string;
    if (typeof source_id === 'string' && source_id.length > 0 && isGrantRole(role)) {
      out.push({ source_id, role });
    }
  }
  return out;
}

/**
 * Resolve a principal by subject (and optional kind). `(kind, subject)` is
 * UNIQUE, so a subject alone can match at most one row PER kind. Returns:
 *   - the row when exactly one matches,
 *   - `null` when none match (caller → 403 unknown principal),
 *   - `'ambiguous'` when >1 kind shares the subject and no kind was supplied
 *     (caller must disambiguate by passing kind).
 */
export async function resolvePrincipalBySubject(
  sql: SqlQuery,
  subject: string,
  kind?: PrincipalKind,
): Promise<PrincipalRow | null | 'ambiguous'> {
  const rows = kind
    ? await sql`SELECT id, kind, subject, display_name FROM principals WHERE subject = ${subject} AND kind = ${kind}`
    : await sql`SELECT id, kind, subject, display_name FROM principals WHERE subject = ${subject}`;
  if (rows.length === 0) return null;
  if (rows.length > 1) return 'ambiguous';
  const r = rows[0];
  return {
    id: Number(r.id),
    kind: r.kind as PrincipalKind,
    subject: r.subject as string,
    display_name: (r.display_name as string | null) ?? null,
  };
}
