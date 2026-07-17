/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, STDIO_LOCAL_CLIENT_ID, sourceScopeOpts } from '../core/operations.ts';
import type { Operation, OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';

/**
 * KS-C: the confidential-corpus read ops whose ENTIRE read surface lies within
 * the v125 RLS-covered tables (pages, content_chunks, artifacts, links,
 * timeline_entries, tags, raw_data, page_versions, facts, files, ingest_log)
 * plus the policy-scoped support tables (sources, config, query_cache,
 * page_aliases, slug_aliases). ONLY these are safe to run under the
 * NOBYPASSRLS `gbrain_request` role.
 *
 * Every OTHER read op touches a DEFERRED table (decision D: takes / calibration
 * / eval / code-edges / oauth / identity …) that `gbrain_request` has no SELECT
 * grant on — running it under the role hard-fails `permission denied`. Those
 * deferred ops (takes_list, takes_search, code_def, code_callers/callees,
 * get_calibration_profile, find_experts, …) MUST run on the normal BYPASSRLS
 * path exactly as before; the app-layer `sourceScopeOpts` ladder stays their
 * isolation. This allowlist is the fix for review finding CRITICAL-2 (the wrap
 * previously fired for every `op.scope === 'read'`).
 *
 * Verified per-op against handlers + engine methods (2026-07-10):
 *   query / search     → hybridSearch/searchVector read content_chunks, pages,
 *                        query_cache, config, sources, page_aliases,
 *                        slug_aliases; relationalFanout reads pages, links,
 *                        content_chunks — all covered/granted/policy-scoped.
 *   get_page           → pages, tags.        get_chunks → content_chunks.
 *   get_links / get_backlinks / list_link_sources → links, pages.
 *   get_timeline       → timeline_entries, pages.
 *   search_by_image    → content_chunks, pages.
 * Code ops (code_def / code_callers / code_callees / code_blast / code_flow /
 * code_refs) read code_symbols / code_edges (DEFERRED) → intentionally EXCLUDED.
 * `retrieve` is not an operation (the T4 unified surface is query/search/get_page).
 */
const RLS_WRAPPED_READ_OPS: ReadonlySet<string> = new Set([
  'query',
  'search',
  'get_page',
  'get_chunks',
  'get_links',
  'get_backlinks',
  'get_timeline',
  'list_link_sources',
  'search_by_image',
]);

/**
 * KS-C (review finding CRITICAL-1): resolve the RLS GUC scope from the SAME
 * precedence ladder the app-layer read filter uses (`sourceScopeOpts`), NOT
 * raw `ctx.auth.allowedSources`. This guarantees the DB scope can never be
 * NARROWER than the app-layer filter for a legitimate caller:
 *
 *   - federated grant (`ctx.auth.allowedSources` non-empty) → those sourceIds.
 *   - scalar principal (allowedSources absent, `ctx.sourceId` set — e.g. the
 *     stdio pipe, a legacy scalar token) → `[ctx.sourceId]`. Deriving from raw
 *     `ctx.auth.allowedSources` here would yield `[]` → deny-all; routing
 *     through `sourceScopeOpts` closes that stdio deny-all independent of the
 *     ctx.auth transport fix (PR #5).
 *   - neither (a deliberately empty scope) → `[]` → the v125 policies match 0
 *     rows (fail-closed), NEVER the scalar `default`.
 *
 * A legitimately ALL-scoped caller needs no special-case: a trusted-local
 * all-sources caller has `ctx.remote === false` and is never wrapped (keeps
 * full BYPASSRLS visibility); a remote principal granted every source carries
 * the explicit source list in `allowedSources`, so `sourceScopeOpts` returns
 * that full array and the GUC spans exactly those sources.
 */
export function resolveRlsAllowedSources(ctx: OperationContext): string[] {
  const scope = sourceScopeOpts(ctx);
  if (scope.sourceIds && scope.sourceIds.length > 0) return scope.sourceIds;
  if (scope.sourceId) return [scope.sourceId];
  return [];
}

/**
 * Synthesise the `AuthInfo` for the local stdio MCP transport (`gbrain serve`
 * over SSH stdio). The stdio pipe carries no OAuth/bearer credential — the SSH
 * key is the transport-layer gate, outside this process — so this builds an
 * explicit principal scoped to the single source the operator configured
 * (`GBRAIN_SOURCE` / `--source`, default `'default'`).
 *
 * Why this exists (the ctx.auth transport bug): before this, the stdio
 * transport dispatched with `remote: true` and NO `ctx.auth`. Two failures:
 *   1. `whoami` hit the fail-closed `unknown_transport` throw.
 *   2. `resolveRequestedScope`'s out-of-grant guard was a no-op
 *      (`ctx.auth?.allowedSources` undefined → "scalar-floor model"), so a
 *      stdio caller could pass `source_id: '<other-tenant>'` and read a source
 *      it was never granted the moment a second scope exists.
 *
 * The grant is `allowedSources: [sourceId]` — the pipe reads exactly its
 * configured source and nothing else (fail-closed). `scopes` is honest about
 * capability (the stdio path runs no `hasScope` gate, so it is inert for
 * authorization and consumed only by `whoami` introspection). This is
 * deliberately model-agnostic w.r.t. multi-tenant auth: SSH-key-as-boundary
 * (one node/key per tenant → its own `GBRAIN_SOURCE`) and per-principal auth
 * (replace this synthetic principal with a real threaded one) both build on
 * the now-populated `ctx.auth` seam.
 */
export function buildStdioAuth(sourceId: string): AuthInfo {
  return {
    token: '',
    clientId: STDIO_LOCAL_CLIENT_ID,
    clientName: 'local stdio pipe',
    // Honest capability of the local pipe (read + write). Inert for stdio
    // authorization (no scope gate on this transport); reported by whoami.
    scopes: ['read', 'write'],
    // The fail-closed lever: an explicit single-source federated grant so
    // resolveRequestedScope rejects an out-of-grant source_id param.
    sourceId,
    allowedSources: [sourceId],
  };
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * v0.31 (eD3): MCP spec-blessed metadata slot for server-supplied data.
   * The dispatcher injects `_meta.brain_hot_memory` here when an op succeeds
   * and the configured `metaHook` returns a payload.
   *
   * Existing clients ignore unknown `_meta` fields; capable clients (Claude
   * Code, Claude Desktop) read it. NOT a wrapper around the result body —
   * `content` stays the same shape it always had. Best-effort: any error in
   * the meta hook is absorbed and the tool call still succeeds.
   */
  _meta?: Record<string, unknown>;
}

export interface DispatchOpts {
  /** Defaults to true (remote/untrusted). Local CLI callers (`gbrain call`) pass false. */
  remote?: boolean;
  /** Override the default stderr logger (e.g. CLI uses console.* directly). */
  logger?: OperationContext['logger'];
  /**
   * v0.28: per-token allow-list for the takes.holder field. Threaded by
   * the HTTP/stdio transport from `access_tokens.permissions.takes_holders`.
   * When set, takes_list / takes_search / query (when it returns takes)
   * MUST filter `WHERE holder = ANY($takesHoldersAllowList)`. Local CLI
   * callers leave this unset (no filter — they own the brain).
   */
  takesHoldersAllowList?: string[];
  /**
   * v0.31 (eD4): tenancy axis for facts hot memory ops (extract_facts,
   * recall, forget_fact). When set, the OperationContext receives a
   * matching `sourceId`. CLI dispatch resolves this from --source flag /
   * GBRAIN_SOURCE / .gbrain-source / 'default'; HTTP MCP transport
   * resolves it from the per-token allow-list (eE3).
   */
  sourceId?: string;
  /**
   * v0.31 (eD3): hook called by the dispatcher AFTER op.handler succeeds
   * to compute `_meta.brain_hot_memory` for the response. Wrapped in its
   * own try/catch (eE4) so a DB blip in the helper degrades to no _meta
   * rather than flipping the whole tool call to error.
   *
   * Returning undefined means "no _meta to inject"; the dispatcher
   * preserves the existing response shape.
   */
  metaHook?: (
    name: string,
    ctx: OperationContext,
  ) => Promise<Record<string, unknown> | undefined>;
  /**
   * OAuth auth info threaded through from the HTTP MCP transport. Set so
   * the whoami op (and any future scope-aware op handlers) can introspect
   * the calling identity. Without this, every whoami call from HTTP
   * transports throws unknown_transport — the v0.31 D12 / eE1 refactor
   * silently dropped this field when the inlined OperationContext literal
   * was replaced by dispatchToolCall.
   */
  auth?: AuthInfo;
}

/**
 * Build a privacy-safe summary of MCP request params for logging + the admin
 * SSE feed.
 *
 * The previous default of `JSON.stringify(params)` wrote raw payloads —
 * page bodies, search queries, file paths — into `mcp_request_log` and
 * broadcast them to every connected admin browser. For a personal-knowledge
 * brain those payloads include private notes about real people / deals /
 * companies, retained indefinitely.
 *
 * The redactor returns the SHAPE of the request (what op was called, which
 * declared params were passed, approximate size) without any of the values.
 *
 * Hardening note (codex C8): a naive "dump all submitted keys" summary still
 * leaks via attacker-controlled key names — a caller can submit
 * `put_page {"wiki/people/sensitive_name": "..."}` and the key becomes a
 * persistent log entry. To prevent this, we intersect submitted keys
 * against the operation's declared `params` allow-list (the same definition
 * `validateParams` reads). Anything outside the allow-list is counted but
 * not named.
 *
 * Operators who want full payloads for debugging set `--log-full-params` on
 * `gbrain serve --http`; that path bypasses this helper and writes the raw
 * JSON, with a loud startup warning.
 */
export interface ParamSummary {
  redacted: true;
  kind: 'array' | 'object' | string;
  declared_keys?: string[];
  unknown_key_count?: number;
  length?: number;
  approx_bytes?: number;
}

/**
 * Round a byte count UP to the nearest 1KB so the redacted summary keeps a
 * coarse size signal without enabling a size-based side channel.
 *
 * Why bucketing matters: the previous shape published `approx_bytes` as the
 * exact JSON.stringify(params).length. An attacker who can submit
 * `put_page` with a known prefix and observe the resulting log entry
 * could binary-search the byte length of secret content (the body the
 * legitimate user just wrote) via repeated probes. Bucketing to 1KB
 * resolution destroys that channel while preserving the operator-useful
 * "roughly how large was the request" signal.
 */
function bucketBytes(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  const KB = 1024;
  return Math.ceil(n / KB) * KB;
}

export function summarizeMcpParams(opName: string, params: unknown): ParamSummary | null {
  if (params == null) return null;

  let approxBytes: number | undefined;
  try { approxBytes = bucketBytes(JSON.stringify(params).length); } catch { approxBytes = undefined; }

  if (Array.isArray(params)) {
    return {
      redacted: true,
      kind: 'array',
      length: params.length,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  if (typeof params === 'object') {
    const submittedKeys = Object.keys(params as Record<string, unknown>);
    const op = operations.find(o => o.name === opName);
    const allowList = op ? new Set(Object.keys(op.params)) : new Set<string>();
    const declared: string[] = [];
    let unknown = 0;
    for (const k of submittedKeys) {
      if (allowList.has(k)) declared.push(k);
      else unknown += 1;
    }
    declared.sort();
    return {
      redacted: true,
      kind: 'object',
      declared_keys: declared,
      unknown_key_count: unknown,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  return {
    redacted: true,
    kind: typeof params,
    ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
  };
}

/** Validate required params exist and have the expected type. Returns null on success, error message on failure. */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

const stderrLogger: OperationContext['logger'] = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};

export function buildOperationContext(
  engine: BrainEngine,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: opts.logger || stderrLogger,
    dryRun: !!params.dry_run,
    remote: opts.remote ?? true,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    // v0.34 D4: sourceId is REQUIRED at the type level. Auto-fill 'default'
    // for single-source brains and any caller who didn't resolve a sourceId.
    // CLI / HTTP / stdio transports SHOULD pass an explicit sourceId via opts;
    // this fallback covers code paths that historically passed undefined.
    sourceId: opts.sourceId ?? 'default',
    auth: opts.auth,
  };
}

/**
 * Resolve operation, validate params, build context, invoke handler, format result.
 *
 * Returns a `ToolResult` with the same shape both MCP transports need:
 * `{ content: [{ type: 'text', text }], isError?: boolean }`.
 */
export async function dispatchToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  const op = operations.find(o => o.name === name);
  if (!op) {
    // Always return JSON-shaped error content. v0.31 e2e tests
    // (sources-remote-mcp.test.ts) parse content via JSON.parse so a
    // plain `Error: ...` string here breaks the contract on every
    // unknown-op path and the resulting test failure looked like a
    // transport bug.
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `Unknown tool: ${name}` }, null, 2) }],
      isError: true,
    };
  }

  const safeParams = params || {};
  const validationError = validateParams(op, safeParams);
  if (validationError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }],
      isError: true,
    };
  }

  const ctx = buildOperationContext(engine, safeParams, opts);

  try {
    // KS-C: in-DB RLS backstop. For remote (untrusted, `ctx.remote === true`)
    // CONFIDENTIAL-CORPUS read ops (the explicit `RLS_WRAPPED_READ_OPS`
    // allowlist), run the handler under the NOBYPASSRLS `gbrain_request` role +
    // a per-transaction `app.allowed_sources` GUC, so the database itself
    // refuses any covered-table row outside the caller's granted spaces even if
    // an app-layer filter is missed.
    //
    // CRITICAL-2 fix: the allowlist replaces the previous `op.scope === 'read'`
    // gate. `gbrain_request` only holds SELECT on the covered + support tables,
    // so a DEFERRED read op (takes_list, code_def, …) would `permission denied`
    // under the role — those run unwrapped on the normal BYPASSRLS path.
    //
    // CRITICAL-1 fix: the scope is derived via `resolveRlsAllowedSources(ctx)`
    // (mirrors the app-layer `sourceScopeOpts` ladder), never raw
    // `ctx.auth.allowedSources` — so the DB scope is never narrower than the
    // app filter, and a scalar/stdio principal doesn't deny-all. Fail-closed: an
    // empty resolved scope yields 0 rows, never the scalar `default`.
    //
    // Write/admin ops and the trusted CLI path (`ctx.remote !== true`) keep
    // today's pooled behavior; PGLite's `withRlsScope` is a pass-through no-op.
    // The app-layer `sourceScopeOpts` ladder stays primary — this is
    // defense-in-depth beneath it.
    const result = (ctx.remote === true && RLS_WRAPPED_READ_OPS.has(op.name))
      ? await engine.withRlsScope(
          resolveRlsAllowedSources(ctx),
          (scopedEngine) => op.handler({ ...ctx, engine: scopedEngine }, safeParams),
        )
      : await op.handler(ctx, safeParams);
    const out: ToolResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    // v0.31 (eD3 + eE4): best-effort _meta.brain_hot_memory injection.
    // The hook is wrapped in its own try/catch — any DB blip / cache miss /
    // helper crash degrades to no `_meta` rather than flipping the whole
    // tool call to error.
    if (opts.metaHook) {
      try {
        const meta = await opts.metaHook(name, ctx);
        if (meta && Object.keys(meta).length > 0) out._meta = meta;
      } catch (metaErr) {
        const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
        ctx.logger.warn(`[mcp] _meta hook failed for ${name}: ${msg}; degrading to no-_meta`);
      }
    }
    return out;
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
    }
    // Non-OperationError (uncaught throws) — wrap in the same shape so
    // every error response is JSON-parseable. The pre-v0.31 path emitted
    // plain `Error: ${msg}` strings here, which broke any caller that
    // tried JSON.parse(content).
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message: msg }, null, 2) }],
      isError: true,
    };
  }
}
