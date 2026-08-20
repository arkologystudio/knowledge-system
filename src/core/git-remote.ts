/**
 * gbrain remote-source git helpers (v0.28).
 *
 * Single source of SSRF-defensive git invocations. parseRemoteUrl delegates
 * to isInternalUrl from src/core/url-safety.ts (covers scheme allowlist,
 * IPv6 loopback, IPv4-mapped IPv6, metadata hostnames, hex/octal bypass,
 * and CGNAT 100.64/10).
 *
 * cloneRepo and pullRepo both spread GIT_SSRF_FLAGS so a future flag added
 * to one path lands on both — single source of truth.
 *
 * Tailscale 100.64/10 trips the integrations.ts allowlist (CGNAT line in
 * url-safety.ts isPrivateIpv4). For self-hosted internal git servers
 * reachable only via Tailscale, set GBRAIN_ALLOW_PRIVATE_REMOTES=1; loud
 * stderr warning at use site is the operator's signal.
 */
import { execFileSync } from 'child_process';
import { lstatSync, existsSync, readdirSync, mkdirSync, copyFileSync, symlinkSync, readlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { isInternalUrl } from './url-safety.ts';

/**
 * Git CLI accepts two flag positions:
 *   git [global -c flags] <subcommand> [subcommand flags] [args]
 *
 * Global flags (the `-c key=value` config overrides) MUST come before the
 * subcommand. Subcommand-specific flags (like `--no-recurse-submodules`)
 * MUST come after the subcommand. Mixing the two positions makes git fail
 * with `unknown option` (exit 129). Pre-v0.34 the single GIT_SSRF_FLAGS
 * constant spliced both positions before the verb; real git rejected the
 * subcommand flag but the test harness used a fake-git script that didn't
 * validate, so every remote-source clone/pull broke silently in production.
 *
 * Split into two constants so the call-site spread is unambiguous and the
 * type/name signal the position rule.
 */

/**
 * Global git config flags. Spread BEFORE the subcommand verb.
 * - http.followRedirects=false: closes DNS rebinding via redirect chains
 * - protocol.file.allow=never: no local-file URLs (defense in depth)
 * - protocol.ext.allow=never: no external helpers (`git-remote-foo`)
 */
export const GIT_SSRF_FLAGS = [
  '-c', 'http.followRedirects=false',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
] as const;

/**
 * Subcommand-level flags. Spread AFTER the subcommand verb (clone/pull).
 * - --no-recurse-submodules: .gitmodules cannot become a second fetch surface
 */
export const GIT_SSRF_SUBCOMMAND_FLAGS = [
  '--no-recurse-submodules',
] as const;

export type RemoteUrlErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'path_traversal'
  | 'internal_target';

export class RemoteUrlError extends Error {
  constructor(public code: RemoteUrlErrorCode, message: string) {
    super(message);
    this.name = 'RemoteUrlError';
  }
}

export interface ParsedRemoteUrl {
  url: string;
  hostname: string;
}

/**
 * Validate a remote git URL for clone safety. https:// only.
 * Rejects: non-https schemes, embedded credentials, path traversal, and
 * internal/private targets via isInternalUrl.
 *
 * GBRAIN_ALLOW_PRIVATE_REMOTES=1 lets the URL through with a stderr warning.
 * Needed for self-hosted git over Tailscale (CGNAT 100.64/10) and similar.
 */
export function parseRemoteUrl(s: string): ParsedRemoteUrl {
  if (!s || typeof s !== 'string') {
    throw new RemoteUrlError('invalid_url', 'URL is empty or not a string');
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new RemoteUrlError('invalid_url', `URL malformed: ${s}`);
  }
  if (url.protocol !== 'https:') {
    throw new RemoteUrlError(
      'unsupported_scheme',
      `URL scheme not supported (https:// only): ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new RemoteUrlError(
      'embedded_credentials',
      'URL must not contain embedded credentials (https://user:pass@host)',
    );
  }
  if (s.includes('..')) {
    throw new RemoteUrlError('path_traversal', 'URL must not contain path-traversal (..)');
  }
  if (isInternalUrl(s)) {
    if (process.env.GBRAIN_ALLOW_PRIVATE_REMOTES === '1') {
      console.error(
        `[gbrain] WARN: GBRAIN_ALLOW_PRIVATE_REMOTES=1, accepting internal/private URL: ${url.hostname}`,
      );
    } else {
      throw new RemoteUrlError(
        'internal_target',
        `URL targets internal/private network: ${url.hostname} ` +
          `(set GBRAIN_ALLOW_PRIVATE_REMOTES=1 for self-hosted git over Tailscale or similar)`,
      );
    }
  }
  return { url: s, hostname: url.hostname };
}

export interface CloneOpts {
  depth?: number; // default 1; 0 means full clone
  branch?: string;
  timeoutMs?: number; // default 600_000 (10 min)
}

export class GitOperationError extends Error {
  constructor(
    public op: 'clone' | 'pull' | 'fetch' | 'remote_get_url',
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

export const GIT_ENV = {
  // Confine to the gbrain SSRF model — no credential helpers, no SSH askpass,
  // no GUI prompts. Inherit PATH so git itself is findable.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
} as const;

/**
 * Auth-capable git env for the durability push/probe paths (v0.42.44).
 *
 * Read-only clone/pull keep the strict GIT_ENV (askpass=/bin/false) so they can
 * never prompt. But push, push-probe, and the durability cron's authed fetch
 * MUST be able to consult the repo's configured credential helper (repo-scoped
 * `store`/`osxkeychain`) — a `/bin/false` askpass would defeat that. We drop the
 * askpass overrides but KEEP `GIT_TERMINAL_PROMPT=0` so a *missing* credential
 * fails fast instead of hanging a non-interactive cron forever.
 */
export const GIT_ENV_AUTH = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
} as const;

/**
 * Clone a remote git repo with SSRF-defensive flags.
 * - destDir must NOT exist or must be empty.
 * - Default --depth=1 (no history); pass {depth: 0} for full clone.
 * - Throws GitOperationError on failure; caller is responsible for cleanup.
 */
export function cloneRepo(url: string, destDir: string, opts: CloneOpts = {}): void {
  if (existsSync(destDir)) {
    let entries: string[];
    try {
      entries = readdirSync(destDir);
    } catch (e) {
      throw new GitOperationError(
        'clone',
        `Cannot inspect destination ${destDir}: ${(e as Error).message}`,
        e,
      );
    }
    if (entries.length > 0) {
      throw new GitOperationError(
        'clone',
        `Destination ${destDir} exists and is not empty; refusing to clone`,
      );
    }
  }

  const args: string[] = [...GIT_SSRF_FLAGS, 'clone', ...GIT_SSRF_SUBCOMMAND_FLAGS];
  if (opts.depth !== 0) {
    args.push(`--depth=${opts.depth ?? 1}`);
  }
  if (opts.branch) {
    args.push('--branch', opts.branch);
  }
  args.push(url, destDir);

  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 600_000,
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'clone',
      `git clone failed for ${url}: ${(e as Error).message}`,
      e,
    );
  }
}

/** Pull a repo with --ff-only and the same SSRF-defensive flags as cloneRepo. */
export function pullRepo(repoPath: string, opts: { timeoutMs?: number } = {}): void {
  const args: string[] = ['-C', repoPath, ...GIT_SSRF_FLAGS, 'pull', ...GIT_SSRF_SUBCOMMAND_FLAGS, '--ff-only'];
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 300_000,
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'pull',
      `git pull failed in ${repoPath}: ${(e as Error).message}`,
      e,
    );
  }
}

/**
 * Fetch a single remote branch with the SAME SSRF-defensive flags + no-prompt
 * env as cloneRepo/pullRepo (GIT_SSRF_FLAGS, --no-recurse-submodules,
 * GIT_TERMINAL_PROMPT=0). Used by the sync cost-estimator's fetch-first path
 * (#2139) so a cost preview / dry-run never hits a remote through a
 * less-protected route than real sync. Throws GitOperationError on failure;
 * the estimator catches and falls back to local HEAD.
 */
export function fetchRemote(repoPath: string, branch: string, opts: { timeoutMs?: number } = {}): void {
  const args: string[] = ['-C', repoPath, ...GIT_SSRF_FLAGS, 'fetch', ...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', branch];
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 30_000,
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'fetch',
      `git fetch failed in ${repoPath}: ${(e as Error).message}`,
      e,
    );
  }
}

export type RepoState =
  | 'healthy'
  | 'missing'
  | 'not-a-dir'
  | 'no-git'
  | 'url-drift'
  | 'unmanaged-remote'
  | 'corrupted';

/**
 * Read `origin`'s URL from a clone. Returns null when the repo has no `origin`
 * remote at all (a legitimate state: `git init` with no remote), and throws
 * only when git itself fails.
 *
 * Split out of validateRepoState so callers that need the ACTUAL on-disk URL
 * — not just a verdict — don't have to shell out a second time. `sources_status`
 * reports it as `clone_remote_url` so an MCP caller can see the config-vs-clone
 * disagreement without SSH access to the brain host.
 */
export function readOriginUrl(repoPath: string): string | null {
  // `git remote` lists remotes and exits 0 even when there are none, so it
  // separates "this repo has no origin" from "git is broken here". Going
  // straight to `remote get-url origin` cannot: that exits non-zero for BOTH,
  // which is why a remote-less repo used to be misreported as `corrupted`.
  const remotes = execFileSync('git', ['-C', repoPath, 'remote'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: { ...process.env, ...GIT_ENV },
  }).toString().split('\n').map((l) => l.trim());
  if (!remotes.includes('origin')) return null;

  const out = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: { ...process.env, ...GIT_ENV },
  }).toString().trim();
  return out === '' ? null : out;
}

/**
 * Classify the on-disk state of a clone. Used by performSync to decide
 * whether to run pull (healthy), re-clone (missing/no-git/not-a-dir),
 * refuse with corruption error (corrupted), or refuse with rebase-clone
 * hint (url-drift).
 *
 * `expectedRemoteUrl` is three-valued, and the distinction is load-bearing:
 *   - `undefined` — caller has no expectation; never reports drift. This is the
 *     historical behavior and what non-source callers still get.
 *   - `string`    — config records this URL; a different one on disk is `url-drift`.
 *   - `null`      — config records NO remote, so gbrain will never pull this
 *     source. A clone that nonetheless has an `origin` is `unmanaged-remote`:
 *     not corruption, not drift, but the config and the clone disagree about
 *     whether anything upstream exists.
 *
 * `unmanaged-remote` is deliberately NOT `url-drift`. `url-drift` is a hard
 * failure — performSync throws on it and tells the operator to re-clone — and
 * pointing a source at a working tree the user pulls themselves (`sources add
 * --path`) is a supported, safe pattern that would otherwise start failing every
 * sync. The two states need to stay distinguishable so a diagnostic can flag the
 * disagreement without a recovery path refusing to run.
 */
export function validateRepoState(
  repoPath: string,
  expectedRemoteUrl?: string | null,
): RepoState {
  let stat;
  try {
    stat = lstatSync(repoPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    return 'not-a-dir';
  }
  if (!stat.isDirectory()) return 'not-a-dir';
  if (!existsSync(join(repoPath, '.git'))) return 'no-git';

  let remoteUrl: string | null;
  try {
    remoteUrl = readOriginUrl(repoPath);
  } catch {
    return 'corrupted';
  }

  // Config says "no remote". A clone that has one anyway is a silent
  // disagreement: gbrain's own sync will never pull it, yet the clone looks
  // like it tracks something. Reporting `healthy` here is what let a stale
  // snapshot pass as a consistent brain.
  if (expectedRemoteUrl === null) {
    return remoteUrl === null ? 'healthy' : 'unmanaged-remote';
  }

  if (expectedRemoteUrl !== undefined && remoteUrl !== expectedRemoteUrl) {
    return 'url-drift';
  }
  return 'healthy';
}

// ── Durability helpers (v0.42.44) ───────────────────────────────────────────
// Used by the brain-repo durability feature (`gbrain sources harden/pull`) and
// the DB-free pull cron. These are the auth-capable, rebase-aware counterparts
// to the strict read-only `pullRepo` (which stays `--ff-only` for `sync.ts`).

/**
 * Global SSRF flags for the durability fetch/pull/push paths. Identical to
 * GIT_SSRF_FLAGS except `protocol.file.allow` honors the env escape hatch
 * `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1` (mirrors GBRAIN_ALLOW_PRIVATE_REMOTES) so
 * self-hosted local-filesystem remotes — and the test suite — can use the file
 * transport. Default stays `never`. These ops act on an ALREADY-validated origin
 * (set + checked at clone time); `http.followRedirects=false` is the live guard.
 */
function durableSsrfFlags(): string[] {
  const fileAllow = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' ? 'always' : 'never';
  return [
    '-c', 'http.followRedirects=false',
    '-c', `protocol.file.allow=${fileAllow}`,
    '-c', 'protocol.ext.allow=never',
  ];
}

/** Run a git subcommand, returning trimmed stdout. Throws GitOperationError. */
function runGit(
  repoPath: string,
  globalFlags: readonly string[],
  subcommand: string,
  subArgs: readonly string[],
  op: GitOperationError['op'],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): string {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, ...globalFlags, subcommand, ...subArgs],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 120_000,
        env: { ...process.env, ...(opts.env ?? GIT_ENV) },
      },
    );
    return out.toString().trim();
  } catch (e) {
    throw new GitOperationError(op, `git ${subcommand} failed in ${repoPath}: ${(e as Error).message}`, e);
  }
}

/** True if the working tree has staged or unstaged changes (untracked too). */
export function isWorkingTreeDirty(repoPath: string): boolean {
  const out = runGit(repoPath, [], 'status', ['--porcelain'], 'pull', { timeoutMs: 30_000 });
  return out.length > 0;
}

/**
 * Resolve the repo's default branch, local-only (no network):
 *   origin/HEAD symbolic-ref → current branch (if not detached) → 'main'.
 */
export function detectDefaultBranch(repoPath: string): string {
  try {
    const sym = execFileSync('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    if (sym.startsWith('origin/')) return sym.slice('origin/'.length);
    if (sym) return sym;
  } catch { /* origin/HEAD not set — fall through */ }
  try {
    const cur = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    if (cur && cur !== 'HEAD') return cur;
  } catch { /* detached or no commits */ }
  return 'main';
}

/** True if a rebase is mid-flight (rebase-merge or rebase-apply state dir exists). */
function rebaseInProgress(repoPath: string): boolean {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    try {
      const p = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', name], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
      }).toString().trim();
      const abs = p.startsWith('/') ? p : join(repoPath, p);
      if (existsSync(abs)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export type PullOutcome =
  | { status: 'up_to_date' }
  | { status: 'advanced'; from: string; to: string }
  | { status: 'skipped_dirty' }
  | { status: 'conflict_aborted'; detail: string };

/**
 * Divergence-safe pull: `fetch` + `pull --rebase`, never leaving a mid-rebase.
 *
 *  - Dirty working tree  → `skipped_dirty` (NORMAL mid-session state, not an
 *    error; never auto-stashes, never touches in-progress edits).
 *  - Rebase conflict     → `git rebase --abort`, verify no rebase state remains,
 *    return `conflict_aborted` ("manual attention needed"). Never throws past
 *    this — the repo is always left clean (possibly un-advanced).
 *
 * Auth-capable (GIT_ENV_AUTH) so it works against private remotes via the
 * repo's configured credential helper. SSRF flags applied on every call.
 */
export function divergenceSafePull(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number } = {},
): PullOutcome {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  if (isWorkingTreeDirty(repoPath)) return { status: 'skipped_dirty' };

  const before = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'pull', { timeoutMs: 10_000 });
  const ssrf = durableSsrfFlags();

  runGit(repoPath, ssrf, 'fetch', [...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', branch], 'pull', {
    timeoutMs, env: { ...GIT_ENV_AUTH },
  });

  try {
    runGit(repoPath, ssrf, 'pull', [...GIT_SSRF_SUBCOMMAND_FLAGS, '--rebase', 'origin', branch], 'pull', {
      timeoutMs, env: { ...GIT_ENV_AUTH },
    });
  } catch (e) {
    // Abort any half-applied rebase so the tree is never left mid-rebase.
    try {
      execFileSync('git', ['-C', repoPath, 'rebase', '--abort'], {
        stdio: 'ignore', timeout: 30_000, env: { ...process.env, ...GIT_ENV },
      });
    } catch { /* best-effort */ }
    // If state STILL remains, try once more, then report regardless.
    if (rebaseInProgress(repoPath)) {
      try {
        execFileSync('git', ['-C', repoPath, 'rebase', '--abort'], {
          stdio: 'ignore', timeout: 30_000, env: { ...process.env, ...GIT_ENV },
        });
      } catch { /* best-effort */ }
    }
    return {
      status: 'conflict_aborted',
      detail: `pull --rebase on ${branch} conflicted; rebase aborted — manual attention needed (${(e as Error).message.slice(0, 120)})`,
    };
  }

  const after = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'pull', { timeoutMs: 10_000 });
  return before === after ? { status: 'up_to_date' } : { status: 'advanced', from: before, to: after };
}

export type PushProbeResult =
  | { ok: true }
  | { ok: false; reason: 'auth' | 'protected' | 'unreachable' | 'other'; detail: string };

/**
 * Authenticated `git push --dry-run` against origin/<branch>. Proves push auth
 * works AND surfaces read-only PATs / branch protection BEFORE harden declares
 * "hardened" — with zero history pollution (no commit). Auth-capable env.
 *
 * `redactDetail` (e.g. shell-redact's value scrubber bound to the PAT) is
 * applied to the captured stderr so a token echoed by git never reaches a log.
 */
export function pushProbe(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; redactDetail?: (s: string) => string } = {},
): PushProbeResult {
  const redact = opts.redactDetail ?? ((s: string) => s);
  try {
    execFileSync(
      'git',
      ['-C', repoPath, ...durableSsrfFlags(), 'push', ...GIT_SSRF_SUBCOMMAND_FLAGS, '--dry-run', 'origin', `HEAD:${branch}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 60_000, env: { ...process.env, ...GIT_ENV_AUTH } },
    );
    return { ok: true };
  } catch (e) {
    const raw = redact((e as Error).message || '');
    const low = raw.toLowerCase();
    let reason: 'auth' | 'protected' | 'unreachable' | 'other' = 'other';
    if (low.includes('authentication') || low.includes('403') || low.includes('permission') || low.includes('could not read')) reason = 'auth';
    else if (low.includes('protected') || low.includes('pre-receive') || low.includes('hook declined')) reason = 'protected';
    else if (low.includes('could not resolve') || low.includes('unable to access') || low.includes('timed out') || low.includes('network')) reason = 'unreachable';
    return { ok: false, reason, detail: raw.slice(0, 200) };
  }
}

// ── Mirror convergence (v0.43.0.22) ─────────────────────────────────────────

/**
 * What convergence found that should not have existed.
 *
 * These are not errors — the run continues and the mirror converges regardless.
 * They are EVIDENCE that something wrote to a tree a machine owns, which is worth
 * surfacing loudly precisely because the old behaviour (wedge forever on
 * `--ff-only`) made the same evidence indistinguishable from a network problem.
 */
export interface MirrorViolation {
  kind: 'local_commits' | 'dirty_files' | 'unremovable';
  detail: string;
  /** Where the evidence was preserved: a git ref, or a quarantine directory. */
  preservedAt: string;
}

/**
 * Raised when convergence fails PART WAY THROUGH. It carries the violations
 * gathered before the failure, because the destructive step (`clean`) runs before
 * the step most likely to throw (`reset`) — so a bare throw would delete files
 * and take the only record of where they were preserved down with it.
 */
export class MirrorConvergeError extends Error {
  constructor(
    message: string,
    public violations: MirrorViolation[],
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'MirrorConvergeError';
  }
}

export interface MirrorConvergeResult {
  /** HEAD before convergence. */
  before: string;
  /** HEAD after convergence — always the remote's tip for the tracked branch. */
  after: string;
  branch: string;
  violations: MirrorViolation[];
}

/**
 * Converge a read-mirror onto `origin/<branch>`, unconditionally.
 *
 * WHY NOT `git pull --ff-only`
 * ----------------------------
 * `--ff-only` PROTECTS local commits. That is the right instinct for a checkout
 * a human works in and exactly the wrong one for a mirror, which must never have
 * local commits worth protecting. When the Arkology mirror acquired one — an
 * uncommitted `put_page` file that an operator committed to tidy the tree — every
 * subsequent pull failed, and it stayed failed until a human intervened a day
 * later. Divergence was a permanently wedging condition.
 *
 * Fetch + `reset --hard` makes divergence IMPOSSIBLE rather than merely detected:
 * there is no state this clone can reach from which it cannot recover unattended.
 *
 * NOTHING IS DISCARDED SILENTLY
 * -----------------------------
 * Before the reset, anything that should not exist is preserved first:
 *   - local-only commits  → a rescue ref, recoverable with ordinary git
 *   - dirty/untracked files → a timestamped quarantine directory
 * and reported in `violations`. A reset that quietly destroyed a colleague's work
 * would trade one incident class for a worse one.
 */
/**
 * Parse `git status --porcelain -z -uall` into records.
 *
 * `-z` and `-uall` are both load-bearing. Without `-uall` an untracked DIRECTORY
 * collapses to one `dir/` entry that cannot be copied but IS deleted by
 * `clean -fd`. Without `-z` git quotes and C-escapes any path containing
 * non-ASCII, a quote, a backslash or a tab, so the path never resolves and the
 * file is skipped — then destroyed. `-z` emits raw bytes with NUL terminators and
 * no quoting, which removes the parsing problem rather than out-guessing it.
 *
 * Record grammar: `XY <path>\0`, with renames/copies emitting an EXTRA
 * `\0<origin>` field that must be consumed or every later entry shifts by one.
 */
function scanStatus(repoPath: string): { xy: string; path: string }[] {
  const raw = execFileSync('git', ['-C', repoPath, 'status', '--porcelain', '-z', '-uall'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    env: { ...process.env, ...GIT_ENV },
  });
  const entries: { xy: string; path: string }[] = [];
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const xy = f.slice(0, 2);
    const p = f.slice(3);
    if (!p) continue;
    entries.push({ xy, path: p });
    if (xy[0] === 'R' || xy[0] === 'C') i++;   // skip the origin-path field
  }
  return entries;
}

export function convergeMirror(
  repoPath: string,
  opts: { branch?: string; quarantineRoot: string; timeoutMs?: number } = { quarantineRoot: '' },
): MirrorConvergeResult {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const run = (args: string[], t = 30_000): string =>
    execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: t,
      env: { ...process.env, ...GIT_ENV },
    }).trim();

  const branch = opts.branch ?? run(['rev-parse', '--abbrev-ref', 'HEAD'], 10_000);
  if (!branch || branch === 'HEAD') {
    throw new GitOperationError('pull', `mirror ${repoPath} is on a detached HEAD; cannot converge`);
  }

  const before = run(['rev-parse', 'HEAD'], 10_000);

  // Fetch FIRST. A failed fetch must leave the mirror exactly as it was rather
  // than resetting it onto a stale remote-tracking ref.
  try {
    // durableSsrfFlags(), not the static constant: same hardening, but it honours
    // the file-transport escape hatch the git-backed test suites rely on.
    execFileSync('git', ['-C', repoPath, ...durableSsrfFlags(), 'fetch', ...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', branch], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: { ...process.env, ...GIT_ENV, ...GIT_ENV_AUTH },
    });
  } catch (e) {
    throw new GitOperationError('fetch', `git fetch failed in ${repoPath}: ${(e as Error).message}`, e);
  }

  const violations: MirrorViolation[] = [];
  const stamp = run(['rev-parse', 'HEAD'], 10_000).slice(0, 12);

  // 1. Local-only commits → rescue ref.
  const ahead = run(['log', '--format=%H %s', `origin/${branch}..HEAD`], 30_000);
  if (ahead) {
    // The ref is named for the tip commit, so re-converging at the same HEAD is
    // idempotent rather than collision-prone. One ref preserves the whole chain:
    // every local commit is an ancestor of the tip, so `git log <ref>` shows all
    // of them and the objects stay GC-rooted.
    const ref = `refs/gbrain/rescue/${stamp}`;
    let preserved = true;
    try {
      run(['update-ref', ref, 'HEAD'], 10_000);
    } catch {
      // Claiming preservation that did not happen is worse than admitting the
      // loss: an operator who trusts the report will not go looking in the reflog
      // while it is still recoverable.
      preserved = false;
    }
    const lines = ahead.split('\n').filter(Boolean);
    violations.push({
      kind: 'local_commits',
      detail: `${lines.length} local-only commit(s) on ${branch}; someone committed inside a machine-managed mirror. Tip: ${lines[0]}`,
      preservedAt: preserved
        ? `${ref} (recover with: git -C ${repoPath} log ${ref})`
        : `PRESERVATION FAILED — could not write ${ref}. The commits are only in the reflog: git -C ${repoPath} reflog`,
    });
  }

  // 2. Dirty / untracked files → quarantine directory.
  const entries = scanStatus(repoPath);
  const untrackedCount = entries.filter((e) => e.xy === '??').length;
  const trackedDirtyCount = entries.length - untrackedCount;
  const quarantineDest = opts.quarantineRoot
    ? join(opts.quarantineRoot, `${stamp}-${process.pid}`)
    : '';

  if (entries.length > 0 && quarantineDest) {
    let moved = 0;
    let failed = 0;
    const preserve = (rel: string): void => {
      const src = join(repoPath, rel);
      let st;
      try {
        st = lstatSync(src);
      } catch {
        return;                                  // deleted entries have nothing to save
      }
      const target = join(quarantineDest, rel);
      try {
        if (st.isDirectory()) {
          mkdirSync(target, { recursive: true });
          for (const child of readdirSync(src)) preserve(join(rel, child));
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        if (st.isSymbolicLink()) {
          // Preserve the LINK, not its target: copyFileSync would dereference it
          // and silently turn a symlink into a copy of whatever it pointed at.
          symlinkSync(readlinkSync(src), target);
        } else {
          copyFileSync(src, target);
        }
        moved++;
      } catch {
        failed++;                                // one unreadable file must not stop convergence
      }
    };
    for (const e of entries) preserve(e.path);
    violations.push({
      kind: 'dirty_files',
      detail: `${entries.length} uncommitted change(s) in a machine-managed mirror (${moved} preserved${failed > 0 ? `, ${failed} FAILED to preserve` : ''})`,
      preservedAt: quarantineDest,
    });
  } else if (entries.length > 0) {
    // No quarantine root configured. Still report it — destroying files AND
    // staying silent about it is the worst of both worlds.
    violations.push({
      kind: 'dirty_files',
      detail: `${entries.length} uncommitted change(s) in a machine-managed mirror DISCARDED — no quarantine root was configured`,
      preservedAt: '(nothing preserved)',
    });
  }

  // 3. Converge.
  //
  // ORDER MATTERS: clean BEFORE reset.
  //
  // The scan above ran against the CURRENT `.gitignore`. Running `clean -fd`
  // after the reset would apply the INCOMING one, so any file the old rules
  // ignored and the new rules do not is deleted without ever having been seen by
  // the scan — unpreserved, and with no violation reported. Cleaning first bounds
  // the deletion to exactly the working-tree state the scan measured.
  //
  // Everything from here to the final rev-parse is wrapped, because `clean` is
  // destructive: any throw after it must still carry the violations, or the
  // operator gets a generic "pull failed" and no idea files were removed — or
  // where the copies went.
  const finish = (): MirrorConvergeResult => ({
    before, after: run(['rev-parse', 'HEAD'], 10_000), branch, violations,
  });
  try {
    // A NON-ZERO EXIT FROM `clean` IS NOT FATAL.
    //
    // `git clean -fd` exits 1 when it cannot unlink something — a path the
    // process cannot write, an EBUSY mount, an NFS silly-rename. Treating that as
    // fatal meant `reset` never ran and the mirror NEVER converged: permanently
    // stale, recoverable only by hand. That is the original wedging bug in a new
    // costume, and it defeated the survivor handling below, which exists to
    // report exactly this case.
    //
    // (A nested git repository is the confusing sibling: `clean` REFUSES it but
    // exits 0, so that path always worked. The two cases look identical to an
    // operator and behaved completely differently.)
    //
    // Whatever clean could not remove is caught by the re-scan and reported as
    // `unremovable`; the reset then proceeds, which is what actually makes the
    // brain fresh again.
    let cleanFailure: string | null = null;
    try {
      run(['clean', '-fd'], timeoutMs);
    } catch (e) {
      cleanFailure = (e as Error).message;
    }

    // Anything still untracked was therefore NOT destroyed. It must not be
    // reported as quarantined-and-deleted, and its copies must not accumulate: on
    // a 5-minute timer an un-cleanable path would otherwise produce a fresh
    // quarantine tree and a fresh violation forever — the alert-fatigue shape
    // this design exists to avoid.
    //
    // Intersected with the ORIGINAL untracked set: a file created by a human or
    // Obsidian between the scan and the re-scan is not serialised by our repo
    // lock, and counting it as a survivor could drive the arithmetic below to
    // delete the quarantine of files that genuinely were destroyed.
    const originalUntracked = new Set(entries.filter((e) => e.xy === '??').map((e) => e.path));
    const survivors = new Set(
      scanStatus(repoPath)
        .filter((e) => e.xy === '??' && originalUntracked.has(e.path))
        .map((e) => e.path),
    );

    if (survivors.size > 0) {
      if (quarantineDest) {
        // Guarded: with no quarantine root this join yields a RELATIVE path and
        // rmSync would delete from the process CWD — outside the repo entirely.
        for (const rel of survivors) {
          try { rmSync(join(quarantineDest, rel), { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      }
      const dirty = violations.find((v) => v.kind === 'dirty_files');
      const destroyedCount = (untrackedCount - survivors.size) + trackedDirtyCount;
      if (dirty) {
        if (destroyedCount <= 0) {
          violations.splice(violations.indexOf(dirty), 1);   // nothing was destroyed
          if (quarantineDest) {
            try { rmSync(quarantineDest, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        } else {
          // Report what was actually destroyed, not the whole scan: counting
          // survivors as losses overstates the damage and erodes trust in the
          // number when it matters.
          dirty.detail =
            `${destroyedCount} uncommitted change(s) destroyed in a machine-managed mirror ` +
            `(${survivors.size} further path(s) could not be removed — see the unremovable violation)`;
        }
      }
      violations.push({
        kind: 'unremovable',
        detail:
          `${survivors.size} untracked path(s) could not be removed by \`git clean -fd\` ` +
          `(a nested git repository, or a path the process cannot write` +
          `${cleanFailure ? `; git reported: ${cleanFailure.split('\n')[0].slice(0, 200)}` : ''}): ` +
          `${[...survivors].slice(0, 5).join(', ')}${survivors.size > 5 ? ', …' : ''}. ` +
          `They were NOT destroyed and were NOT quarantined; the mirror converges ` +
          `regardless, but will keep reporting this until a human removes them.`,
        preservedAt: '(still in the working tree — nothing was lost)',
      });
    } else if (cleanFailure) {
      // Clean failed but left nothing untracked behind — report it rather than
      // swallowing a non-zero exit entirely.
      violations.push({
        kind: 'unremovable',
        detail: `git clean reported a failure but left no untracked paths: ${cleanFailure.split('\n')[0].slice(0, 200)}`,
        preservedAt: '(nothing left in the working tree)',
      });
    }

    run(['reset', '--hard', `origin/${branch}`], timeoutMs);
    return finish();
  } catch (e) {
    throw new MirrorConvergeError(
      `mirror convergence failed in ${repoPath} after clean removed untracked files` +
        (violations.some((v) => v.kind === 'dirty_files')
          ? ` (quarantined at ${violations.find((v) => v.kind === 'dirty_files')!.preservedAt})`
          : '') +
        `: ${(e as Error).message}`,
      violations,
      e,
    );
  }
}
