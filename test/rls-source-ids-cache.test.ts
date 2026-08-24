/**
 * The cached source-id read behind `sourceScopeOpts`'s RLS stand-down.
 *
 * Uncached, this fired once per RLS-wrapped call. Invisible for one `get_page`;
 * pathological for the web graph path, which — with no `export_graph` tool —
 * issues one `get_links` per page and so paid ~466 redundant round trips inside
 * a single page load.
 *
 * The property that must hold is the FAILURE direction: a failed read returns
 * undefined and is NOT cached, so the app-layer filter stays in force (degrading
 * closed) and a transient blip does not persist for the whole TTL.
 */

import { describe, test, expect } from 'bun:test';
import { dispatchToolCall, _clearSourceIdsCache } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** Engine stub counting `SELECT id FROM sources` reads. */
function stubEngine(opts: { failSources?: boolean } = {}) {
  let sourceReads = 0;
  const engine = {
    kind: 'postgres',
    async executeRaw(query: string): Promise<unknown[]> {
      if (/FROM sources/.test(query)) {
        sourceReads++;
        if (opts.failSources) throw new Error('boom');
        return [{ id: 'default' }];
      }
      return [];
    },
    // Mimic the real contract: the callback gets an engine marked rlsScoped.
    async withRlsScope<T>(_allowed: string[], fn: (e: BrainEngine) => Promise<T>): Promise<T> {
      const scoped = Object.create(engine) as BrainEngine;
      Object.defineProperty(scoped, 'rlsScoped', { value: true });
      return fn(scoped);
    },
    async getPage() { return null; },
    async listPages() { return []; },
  } as unknown as BrainEngine;
  return { engine, reads: () => sourceReads };
}

async function call(engine: BrainEngine) {
  return dispatchToolCall(engine, 'list_pages', { limit: 10 }, {
    remote: true,
    auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default'] },
    logger: quiet,
  });
}

describe('source-id cache for the RLS stand-down', () => {
  // Each test builds its OWN engine, so the WeakMap keying isolates them.

  test('reads sources ONCE across many RLS-wrapped calls', async () => {
    const { engine, reads } = stubEngine();
    for (let i = 0; i < 25; i++) await call(engine);
    // The graph path makes one call per page; without the cache this would be
    // one source read per page.
    expect(reads()).toBe(1);
  });

  test('a failed read is NOT cached, so a blip cannot persist for the TTL', async () => {
    const failing = stubEngine({ failSources: true });
    await call(failing.engine);
    await call(failing.engine);
    // Both attempts must hit the DB — caching the failure would keep the
    // app-layer filter pinned on for the whole TTL after one transient error.
    expect(failing.reads()).toBe(2);
  });

  test('the cache can be dropped explicitly', async () => {
    const { engine, reads } = stubEngine();
    await call(engine);
    _clearSourceIdsCache(engine);
    await call(engine);
    expect(reads()).toBe(2);
  });
});
