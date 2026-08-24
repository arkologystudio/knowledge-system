/**
 * The guest read path, end to end through the OP layer.
 *
 * Every other v129 test proves the DATABASE enforces labels correctly. None of
 * them prove a real guest can actually READ anything, because they either drive
 * raw SQL under the role, or hand the caller its source id alongside the label.
 *
 * A real guest holds ONLY a label — never the source id, because the backfill
 * gave every page its source as a label, so granting the source id would grant
 * the whole corpus. This file pins what such a caller actually gets back from
 * the ops the UI and MCP call.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SRC = 'ks-guest-src';
const LABEL = 'ks-guest-habitat';
const SHARED = 'ks-guest-shared';
const PRIVATE = 'ks-guest-private';

describeDb('guest read path (label-only grant)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SRC]);
    await engine.executeRaw('DELETE FROM spaces WHERE id = $1', [LABEL]);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [SRC, 'guest fixture']);
    await engine.executeRaw(
      "INSERT INTO spaces (id, label, class) VALUES ($1, 'Guest habitat', 'shareable')", [LABEL],
    );
    await engine.executeRaw(
      "INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1,$2,'note','Shared','body shared')",
      [SRC, SHARED],
    );
    await engine.executeRaw(
      "INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1,$2,'note','Private','body private')",
      [SRC, PRIVATE],
    );
    // Steward shares exactly one artifact.
    await engine.executeRaw(
      'INSERT INTO page_spaces (page_id, space_id) SELECT id, $1 FROM pages WHERE slug = $2',
      [LABEL, SHARED],
    );
  }, 60_000);

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SRC]);
      await engine.executeRaw('DELETE FROM spaces WHERE id = $1', [LABEL]);
      await engine.disconnect();
    }
  });

  /** A guest: remote, holding ONE label, and no source id anywhere. */
  const guestAuth: AuthInfo = {
    token: 't', clientId: 'guest', scopes: ['read'], allowedSources: [LABEL],
  };
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };

  /**
   * Drive the REAL MCP entry point, not the op handler directly. The dispatcher
   * is what drops to the RLS role and resolves the source list the app-layer
   * filter needs to stand down — calling a handler directly skips both and
   * tests a path no client ever takes.
   */
  async function guestCall(tool: string, params: Record<string, unknown>) {
    return dispatchToolCall(engine, tool, params, {
      remote: true, auth: guestAuth, logger: quiet,
    });
  }
  const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

  test('get_page returns the shared artifact to a label-only guest', async () => {
    const res = await guestCall('get_page', { slug: SHARED });
    expect(res.isError).toBeFalsy();
    expect(body(res).slug).toBe(SHARED);
  });

  test('get_page hides the unlabelled artifact as absence, not refusal', async () => {
    // Absence, not refusal: a guest must not learn that an artifact they may
    // not read exists. Same rule as the silent edge-drop in the v129 links
    // policy and the not_found in classify_page.
    const res = await guestCall('get_page', { slug: PRIVATE });
    expect(res.isError).toBeTruthy();
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/not[_ ]found/i);
    expect(text).not.toMatch(/permission|forbidden|denied/i);
  });

  test('list_pages enumerates exactly the shared artifact', async () => {
    // The web UI builds its whole roster from this op. Empty here means a
    // signed-in guest sees an empty knowledge base.
    const res = await guestCall('list_pages', { limit: 50 });
    expect(res.isError).toBeFalsy();
    expect(body(res).map((r: { slug: string }) => r.slug)).toEqual([SHARED]);
  });

  test('search never surfaces the unlabelled artifact', async () => {
    const res = await guestCall('search', { query: 'body', limit: 10 });
    expect(JSON.stringify(body(res))).not.toContain(PRIVATE);
  });
});
