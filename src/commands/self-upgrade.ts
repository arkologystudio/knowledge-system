import { VERSION } from '../version.ts';
import { isMinorOrMajorBump, isValidVersionString } from '../core/semver.ts';
import { fetchChangelog, fetchLatestRelease } from './check-update.ts';
import { detectInstallMethod, runUpgrade } from './upgrade.ts';
import { writeUpdateCache } from '../core/self-upgrade.ts';
import { assertUpgradeAllowed, isForkBuild, DISTRIBUTION_REPO, UPSTREAM_RELEASE_REPO } from '../core/distribution.ts';

/**
 * `gbrain self-upgrade [--check-only] [--force] [--json]`
 *
 * The universal substrate every agent ecosystem (Codex / Claude Code / Hermes /
 * OpenClaw / Perplexity-server) can call to stay current. The CLI startup hook
 * emits a marker; the agent skill / autopilot daemon act on it by running THIS
 * command. The action is always the hardcoded `gbrain upgrade` — never
 * parameterized by any marker content (forged-marker guard).
 *
 *   --check-only  Report whether an upgrade is available; never apply.
 *   --force       Apply even if not behind (re-run the install-method swap).
 *   --json        Machine-readable output for the check.
 */
/** Best-effort cache warm; a cache failure must never fail the command. */
function writeUpdateCacheSafely(entry: Parameters<typeof writeUpdateCache>[0]): void {
  try {
    writeUpdateCache(entry);
  } catch {
    /* best-effort */
  }
}

export async function runSelfUpgrade(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain self-upgrade [--check-only] [--force] [--json]\n\n' +
        'Check for and apply gbrain updates. The shared entry point used by the\n' +
        'CLI startup marker, the gbrain-upgrade agent skill, and the autopilot\n' +
        'silent channel.\n\n' +
        '  --check-only  Report whether an upgrade is available; do not apply.\n' +
        '  --force       Apply even when not behind.\n' +
        '  --json        Machine-readable output (with --check-only).',
    );
    return;
  }

  const checkOnly = args.includes('--check-only');
  const force = args.includes('--force');
  const json = args.includes('--json');

  // Fork guard, ahead of the release fetch and every apply branch.
  //
  // --check-only is PASSIVE, so it reports rather than throws — the agent skill
  // polls it, and a thrown error there would read as a broken install instead of
  // a deliberate policy. Everything else APPLIES a release and is refused.
  // --force deliberately does NOT bypass this: --force skips the "am I behind?"
  // check, which is exactly the shape that makes an accidental overwrite easy.
  if (isForkBuild()) {
    if (!checkOnly) assertUpgradeAllowed('gbrain self-upgrade');
    writeUpdateCacheSafely({ kind: 'up_to_date', current: VERSION });
    if (json) {
      console.log(JSON.stringify({
        current_version: VERSION,
        latest_version: '',
        update_available: false,
        install_method: detectInstallMethod(),
        changelog_diff: '',
        release_url: '',
        error: 'fork_build',
        distribution_repo: DISTRIBUTION_REPO,
        upstream_release_repo: UPSTREAM_RELEASE_REPO,
      }, null, 2));
    } else {
      console.log(
        `GBrain ${VERSION} — this build is ${DISTRIBUTION_REPO}, a fork.\n` +
        `Upstream (${UPSTREAM_RELEASE_REPO}) release checks are disabled; deploy from the fork's own repository.`,
      );
    }
    return;
  }

  const release = await fetchLatestRelease();
  const latest = release ? release.tag.replace(/^v/, '') : null;
  const behind = !!latest && isValidVersionString(latest) && isMinorOrMajorBump(VERSION, latest);

  // Warm the cache so the next invocation's startup hook can emit without a fetch.
  try {
    if (latest && isValidVersionString(latest)) {
      writeUpdateCache(
        behind
          ? { kind: 'upgrade_available', current: VERSION, latest }
          : { kind: 'up_to_date', current: VERSION },
      );
    }
  } catch {
    /* best-effort */
  }

  if (checkOnly) {
    // Tell the operator WHAT they'd get: fetch the changelog only when actually
    // behind (so an up-to-date check stays a single release fetch). The agent
    // skill surfaces these "what's new" bullets in the notify prompt.
    let changelogDiff = '';
    if (behind && latest) {
      try {
        changelogDiff = await fetchChangelog(VERSION, latest);
      } catch {
        /* best-effort: an unavailable changelog must not block the check */
      }
    }
    if (json) {
      console.log(
        JSON.stringify(
          {
            current_version: VERSION,
            latest_version: latest ?? '',
            update_available: behind,
            install_method: detectInstallMethod(),
            release_url: release?.url ?? '',
            changelog_diff: changelogDiff,
          },
          null,
          2,
        ),
      );
    } else if (behind) {
      console.log(`Update available: ${VERSION} -> ${latest}. Run: gbrain self-upgrade`);
      if (changelogDiff) {
        console.log('\nWhat changed:\n');
        console.log(changelogDiff);
      }
      if (release?.url) console.log(`\nRelease: ${release.url}`);
    } else {
      console.log(`gbrain ${VERSION} is up to date.`);
    }
    return;
  }

  if (!behind && !force) {
    console.log(`gbrain ${VERSION} is up to date.`);
    return;
  }

  // Apply: delegate to the hardcoded upgrade path (full swap + post-upgrade).
  await runUpgrade([]);
}
