/**
 * Tests for the `schema_undeclared_types` doctor check — the inverse of
 * `schema_pack_consistency`.
 *
 * `schema_pack_consistency` asks "how many pages have NO type?".  This check
 * asks "how many pages carry a type the active pack never declared?".  Those
 * pages work fine at runtime, so the check is warn-only and thresholded: a
 * brain that has deliberately settled on a couple of undeclared types must
 * report `ok` rather than nag forever.
 *
 * Driven through `doctorReportRemote()` (the surface `run_doctor` uses) rather
 * than the un-exported check function, so the assertions cover the wiring too.
 * Serial: pins GBRAIN_HOME + GBRAIN_SCHEMA_PACK and mutates the shared pack
 * locator.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { doctorReportRemote, type Check } from '../src/commands/doctor.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let priorHome: string | undefined;
let priorPack: string | undefined;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-undeclared-types-'));
  priorHome = process.env.GBRAIN_HOME;
  priorPack = process.env.GBRAIN_SCHEMA_PACK;
  process.env.GBRAIN_HOME = tmpHome;
  process.env.GBRAIN_SCHEMA_PACK = 'tiny';
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  _resetPackLocatorForTests();
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  if (priorPack === undefined) delete process.env.GBRAIN_SCHEMA_PACK;
  else process.env.GBRAIN_SCHEMA_PACK = priorPack;
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
});

/** Minimal single-type pack so "declared" is a tiny, obvious set. */
function seedTinyPack(): void {
  const dir = join(tmpHome, 'tiny');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(
    path,
    `api_version: gbrain-schema-pack-v1
name: tiny
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases: []
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`,
    'utf-8',
  );
  __setPackLocatorForTests((name) => (name === 'tiny' ? path : null));
}

async function seedPage(slug: string, type: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
     VALUES ($1, 'default', $2, $3, $1, '', '', '')`,
    [slug, `${slug}.md`, type],
  );
}

async function undeclaredCheck(): Promise<Check> {
  const report = await doctorReportRemote(engine);
  const check = report.checks.find((c) => c.name === 'schema_undeclared_types');
  expect(check).toBeDefined();
  return check!;
}

describe('doctor: schema_undeclared_types', () => {
  test('ok when every type in use is declared', async () => {
    seedTinyPack();
    await seedPage('people/alice', 'person');
    const check = await undeclaredCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Every type in use is declared');
  });

  test('warns above the 5% threshold and names the offending types', async () => {
    seedTinyPack();
    for (let i = 0; i < 10; i++) await seedPage(`people/p${i}`, 'person');
    for (let i = 0; i < 5; i++) await seedPage(`strategy/s${i}`, 'strategy');
    const check = await undeclaredCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('strategy (5)');
    // Never fails: undeclared types retrieve normally.
    expect(check.message).toContain('drift, not breakage');
    expect(check.details?.undeclared_page_count).toBe(5);
    expect(check.details?.typed_page_count).toBe(15);
  });

  test('stays ok below the 5% threshold — a settled-on type must not nag forever', async () => {
    seedTinyPack();
    for (let i = 0; i < 100; i++) await seedPage(`people/p${i}`, 'person');
    await seedPage('strategy/one', 'strategy');
    const check = await undeclaredCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('under the 5% warn threshold');
    // Still reported in `details` even when ok — classify, don't just flag.
    expect(check.details?.undeclared_type_count).toBe(1);
  });

  test('a bare pack primitive always warns, regardless of share', async () => {
    seedTinyPack();
    for (let i = 0; i < 100; i++) await seedPage(`people/p${i}`, 'person');
    await seedPage('x', 'entity');  // 1/101 — well under 5%
    const check = await undeclaredCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('is a pack primitive');
  });

  test('untyped pages belong to schema_pack_consistency, not to this check', async () => {
    seedTinyPack();
    await seedPage('people/alice', 'person');
    await seedPage('nothing', '');  // untyped
    const check = await undeclaredCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Every type in use is declared');
  });

  test('stays ok (not warn) when no pack resolves — schema_pack_active owns that', async () => {
    __setPackLocatorForTests(() => null);
    await seedPage('a', 'strategy');
    const check = await undeclaredCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No active pack resolved');
  });
});
