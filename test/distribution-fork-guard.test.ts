/**
 * Fork-identity guard pins.
 *
 * The 2026-08-18 review found that `self_upgrade.mode=off` gates only the
 * invocation nag and the autopilot channel, so `gbrain self-upgrade` / `gbrain
 * upgrade` / `gbrain check-update` still installed UPSTREAM releases over this
 * fork. These pins exist so that regression cannot return silently: they assert
 * the guard is reachable from every entry point that could apply a release, and
 * that it is compiled in rather than configured.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DISTRIBUTION_REPO,
  UPSTREAM_RELEASE_REPO,
  UPSTREAM_LATEST_RELEASE_API,
  isForkBuild,
  assertUpgradeAllowed,
  foreignUpgradeMessage,
  ForeignUpgradeRefused,
} from '../src/core/distribution.ts';

const SRC = join(import.meta.dir, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('distribution identity', () => {
  test('this build declares itself a fork of the upgrade target', () => {
    expect(DISTRIBUTION_REPO).toBe('arkologystudio/knowledge-system');
    expect(UPSTREAM_RELEASE_REPO).toBe('garrytan/gbrain');
    expect(isForkBuild()).toBe(true);
  });

  test('the release API url is derived from the upstream constant, not re-hardcoded', () => {
    expect(UPSTREAM_LATEST_RELEASE_API).toBe(
      `https://api.github.com/repos/${UPSTREAM_RELEASE_REPO}/releases/latest`,
    );
  });
});

describe('assertUpgradeAllowed', () => {
  test('refuses on a fork build, naming the command and both repos', () => {
    let thrown: unknown;
    try {
      assertUpgradeAllowed('gbrain upgrade');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForeignUpgradeRefused);
    const msg = (thrown as Error).message;
    expect(msg).toContain('gbrain upgrade');
    expect(msg).toContain(DISTRIBUTION_REPO);
    expect(msg).toContain(UPSTREAM_RELEASE_REPO);
  });

  test('the refusal tells the operator what to do instead', () => {
    // A refusal with no alternative is a refusal people route around.
    expect(foreignUpgradeMessage('gbrain self-upgrade')).toContain('pull --ff-only');
  });

  test('carries a stable machine-readable code', () => {
    const err = new ForeignUpgradeRefused('x');
    expect(err.code).toBe('foreign_upgrade_refused');
  });
});

describe('every release-applying entry point is guarded', () => {
  // Structural pins. The danger is a NEW apply path landing unguarded, which a
  // behavioural test on today's paths would not catch.
  test('runUpgrade calls the guard', () => {
    expect(read('commands/upgrade.ts')).toContain("assertUpgradeAllowed('gbrain upgrade')");
  });

  test('runSelfUpgrade calls the guard', () => {
    expect(read('commands/self-upgrade.ts')).toContain("assertUpgradeAllowed('gbrain self-upgrade')");
  });

  test('the guard precedes the release fetch in self-upgrade', () => {
    // Ordering matters: fetching first would warm the update cache with an
    // upstream version this build will never install, re-arming the nag.
    const s = read('commands/self-upgrade.ts');
    expect(s.indexOf('assertUpgradeAllowed')).toBeLessThan(s.indexOf('await fetchLatestRelease()'));
  });

  test('the guard precedes --swap-only handling in upgrade (the autopilot path)', () => {
    const s = read('commands/upgrade.ts');
    expect(s.indexOf('assertUpgradeAllowed')).toBeLessThan(s.indexOf("args.includes('--swap-only')"));
  });
});

describe('passive check paths degrade quietly rather than throwing', () => {
  test('fetchLatestRelease short-circuits on a fork', () => {
    expect(read('commands/check-update.ts')).toContain('if (isForkBuild()) return null;');
  });

  test('the binary self-update release fetch short-circuits on a fork', () => {
    expect(read('core/binary-self-update.ts')).toContain('if (isForkBuild()) return null;');
  });

  test('no upgrade path re-hardcodes the upstream API url', () => {
    for (const f of ['commands/check-update.ts', 'core/binary-self-update.ts']) {
      expect(read(f)).not.toContain('api.github.com/repos/garrytan');
    }
  });
});
