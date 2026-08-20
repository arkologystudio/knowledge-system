/**
 * Serial (stubs globalThis.fetch): `gbrain self-upgrade --check-only --json`
 * surfaces the changelog so the notify prompt can tell the operator WHAT they'll
 * get, not just a version number. Network stubbed; the JSON shape + changelog
 * extraction are real.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version.ts';
import { parseSemver } from '../src/core/semver.ts';
import { runSelfUpgrade } from '../src/commands/self-upgrade.ts';
import { isForkBuild, DISTRIBUTION_REPO } from '../src/core/distribution.ts';

const realFetch = globalThis.fetch;
const realLog = console.log;
let home: string;
let priorHome: string | undefined;
let captured: string[];

function minorBump(): string {
  const v = parseSemver(VERSION)!;
  return `${v[0]}.${v[1] + 1}.0`;
}

function stub(tag: string | null, changelog: string): void {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes('/releases/latest')) {
      if (tag === null) throw new Error('network down');
      return new Response(JSON.stringify({ tag_name: tag, published_at: '2026-01-01', html_url: 'https://x/rel' }), { status: 200 });
    }
    if (u.includes('CHANGELOG.md')) return new Response(changelog, { status: 200 });
    return new Response('', { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  priorHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-checkonly-'));
  process.env.GBRAIN_HOME = home;
  captured = [];
  console.log = (...a: unknown[]) => { captured.push(a.join(' ')); };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

// A fork build resolves no upstream release BY DESIGN (see src/core/distribution.ts),
// so the upstream-facing assertions below describe upstream behaviour only. They are
// kept — not deleted — so this file stays correct on either build and can be
// contributed upstream unchanged. `describe.if` keeps the skip visible in the runner
// rather than silently passing.
describe.if(isForkBuild())('self-upgrade --check-only on a fork build', () => {
  test('reports fork status instead of an upstream version, and does not throw', async () => {
    stub(`v${minorBump()}`, 'should-not-be-read');
    await runSelfUpgrade(['--check-only', '--json']);
    const out = JSON.parse(captured.join('\n'));
    expect(out.update_available).toBe(false);
    expect(out.error).toBe('fork_build');
    expect(out.latest_version).toBe('');
    expect(out.distribution_repo).toBe(DISTRIBUTION_REPO);
  });

  test('human output names the fork rather than offering an upgrade', async () => {
    stub(`v${minorBump()}`, 'should-not-be-read');
    await runSelfUpgrade(['--check-only']);
    const text = captured.join('\n');
    expect(text).toContain(DISTRIBUTION_REPO);
    expect(text).not.toContain('What changed');
  });
});

describe.if(!isForkBuild())('self-upgrade --check-only surfaces what you get', () => {
  test('behind → JSON includes changelog_diff + release_url + update_available', async () => {
    const latest = minorBump();
    const changelog = `# Changelog\n\n## [${latest}] - 2026-01-01\n\n- Shiny new thing\n- Another fix\n\n## [${VERSION}] - 2025-12-01\n\n- old\n`;
    stub(`v${latest}`, changelog);
    await runSelfUpgrade(['--check-only', '--json']);
    const out = JSON.parse(captured.join('\n'));
    expect(out.update_available).toBe(true);
    expect(out.latest_version).toBe(latest);
    expect(out.release_url).toBe('https://x/rel');
    expect(out.changelog_diff).toContain('Shiny new thing');
  });

  test('behind, human output prints What changed', async () => {
    const latest = minorBump();
    const changelog = `# Changelog\n\n## [${latest}] - 2026-01-01\n\n- Headline feature\n\n## [${VERSION}] - 2025-12-01\n\n- old\n`;
    stub(`v${latest}`, changelog);
    await runSelfUpgrade(['--check-only']);
    const text = captured.join('\n');
    expect(text).toContain('What changed');
    expect(text).toContain('Headline feature');
  });

  test('up to date → no changelog fetched, empty diff', async () => {
    // Stub returns the SAME version → not behind → no changelog.
    stub(`v${VERSION}`, 'should-not-be-read');
    await runSelfUpgrade(['--check-only', '--json']);
    const out = JSON.parse(captured.join('\n'));
    expect(out.update_available).toBe(false);
    expect(out.changelog_diff).toBe('');
  });

  test('network failure → up to date, no crash', async () => {
    stub(null, '');
    await runSelfUpgrade(['--check-only', '--json']);
    const out = JSON.parse(captured.join('\n'));
    expect(out.update_available).toBe(false);
    expect(out.changelog_diff).toBe('');
  });
});
