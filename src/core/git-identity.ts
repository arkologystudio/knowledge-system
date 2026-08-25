/**
 * Git author identity for agent-originated writes.
 *
 * The git-first writer shells out to `git commit`. With no identity in the
 * process environment git falls back to its implicit `user@host` guess, so on
 * a server that runs the MCP as root every agent write lands as
 * `root <root@host>`. The commit's `Knowledge-Actor` trailer still records WHO
 * wrote it, but `git log`, `git blame`, and forge contribution graphs all read
 * the author field and see the daemon instead of the person.
 *
 * The stdio transport can fix this from outside — the operator exports
 * `GIT_AUTHOR_*` into the SSH command and the writer inherits it. The HTTP /
 * OAuth transport cannot: one long-lived server process serves every client,
 * so identity has to be resolved per request from the calling principal.
 *
 * Resolution order, most authoritative first:
 *
 *   1. The credential's PRINCIPAL. A PAT or minted token carries
 *      `access_tokens.principal_id`, and `principals` already holds the human's
 *      subject (email) and display name. This is the real identity edge: it
 *      needs no configuration and stays correct as credentials rotate, because
 *      it is bound to the person rather than to a credential id.
 *   2. OPERATOR-DECLARED CONFIG, for client-credentials OAuth clients that have
 *      no principal behind them:
 *
 *        writer.git_identity.<client_id>  → 'Che Coelho <che@example.com>'
 *        writer.git_identity.default      → fallback for unmapped clients
 *
 *   3. Nothing — the process environment's identity stands. Unchanged
 *      pre-existing behaviour, never an error.
 *
 * What is NEVER consulted is anything the caller supplies for itself: a client
 * that could name its own author could forge history under someone else's name.
 * It supplies only its authenticated credential; both sources above are
 * server-side facts about that credential.
 */
import type { BrainEngine } from './engine.ts';

export interface GitIdentity {
  name: string;
  email: string;
}

export const GIT_IDENTITY_CONFIG_PREFIX = 'writer.git_identity.';
export const GIT_IDENTITY_DEFAULT_KEY = `${GIT_IDENTITY_CONFIG_PREFIX}default`;

/** `Name <local@host>` — the shape git itself prints and accepts. */
const IDENTITY_PATTERN = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/;

/** Client ids are pasted into a config key; keep the key space boring. */
const SAFE_CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Parse an operator-declared `Name <email>` string.
 *
 * Returns undefined for anything malformed rather than throwing: a typo in
 * config must not take the write path down, it must fall through to the
 * pre-existing environment identity.
 */
export function parseGitIdentity(raw: string | null | undefined): GitIdentity | undefined {
  if (!raw) return undefined;
  // Newlines would let a config value forge extra commit-object headers.
  const cleaned = raw.replace(/[\r\n\0]/g, ' ').trim();
  const match = IDENTITY_PATTERN.exec(cleaned);
  if (!match) return undefined;
  const name = match[1].trim().slice(0, 120);
  const email = match[2].trim().slice(0, 254);
  if (!name || name.includes('<') || name.includes('>')) return undefined;
  return { name, email };
}

/**
 * Environment overlay that pins both author and committer.
 *
 * Committer as well as author: leaving the committer as root would still show
 * the daemon on `git log --format=%cn` and in forge UIs that surface it.
 */
export function gitIdentityEnv(identity: GitIdentity | undefined): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

type IdentityEngine = Pick<BrainEngine, 'getConfig' | 'executeRaw'>;

/** The credential's bound human, when it has one. */
async function principalIdentity(
  engine: IdentityEngine,
  principalId: number,
): Promise<GitIdentity | undefined> {
  let rows: { subject: string | null; display_name: string | null }[];
  try {
    rows = await engine.executeRaw<{ subject: string | null; display_name: string | null }>(
      'SELECT subject, display_name FROM principals WHERE id = $1',
      [principalId],
    );
  } catch {
    // Brains older than the principals migration simply have no table. Fall
    // through to config rather than failing a write over an identity lookup.
    return undefined;
  }
  const row = rows[0];
  if (!row?.subject) return undefined;
  const email = row.subject.trim();
  // Principal subjects are only email-shaped for `kind = 'human'`; a service
  // principal's subject is not an address and must not become one.
  if (!/^[^<>\s]+@[^<>\s]+$/.test(email)) return undefined;
  const name = (row.display_name ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 120) || email;
  if (name.includes('<') || name.includes('>')) return undefined;
  return { name, email };
}

/**
 * Resolve the git identity for an authenticated caller: the principal behind
 * the credential, else the client's operator-declared mapping, else the
 * operator's default, else undefined (inherit the environment).
 */
export async function resolveGitIdentity(
  engine: IdentityEngine,
  auth?: { clientId?: string; principalId?: number },
): Promise<GitIdentity | undefined> {
  if (auth?.principalId != null) {
    const bound = await principalIdentity(engine, auth.principalId);
    if (bound) return bound;
  }
  const clientId = auth?.clientId;
  if (clientId && SAFE_CLIENT_ID.test(clientId)) {
    const specific = parseGitIdentity(await engine.getConfig(`${GIT_IDENTITY_CONFIG_PREFIX}${clientId}`));
    if (specific) return specific;
  }
  return parseGitIdentity(await engine.getConfig(GIT_IDENTITY_DEFAULT_KEY));
}
