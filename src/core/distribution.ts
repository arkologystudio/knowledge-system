/**
 * Build identity — WHO this binary is, and therefore whose releases it may install.
 *
 * WHY THIS EXISTS
 * ---------------
 * gbrain's upgrade machinery fetches releases from a hardcoded GitHub repo. That
 * is correct for upstream builds and catastrophic for a fork: `gbrain upgrade`
 * on a fork downloads UPSTREAM's binary over itself, silently reverting every
 * fork patch. On the Arkology deployment (`kb.arkology.studio`) that would have
 * undone the entire knowledge-system divergence in one command — and the CLI
 * *nags you to run it* on every invocation.
 *
 * The first mitigation was configuration: `self_upgrade.mode=off`. A 2026-08-18
 * review proved that insufficient — `resolveSelfUpgradeMode` gates only the
 * invocation nag and the autopilot channel. `gbrain self-upgrade`, `gbrain
 * upgrade` and `gbrain check-update` never consult it, so the command the
 * runbook forbade still worked exactly as before. Config could not fix this
 * because config is not on the path the dangerous commands take.
 *
 * So identity moves into the binary. `DISTRIBUTION_REPO` is a compile-time
 * constant, not a setting: it cannot be un-set by a config edit, a regenerated
 * `config.json`, a typo'd env var (the mode resolver falls back to the
 * PERMISSIVE value on an unrecognized string), or a fresh install. When it
 * disagrees with the repo the upgrade machinery targets, this build is a fork
 * and foreign releases are refused.
 *
 * UPSTREAM SAFETY
 * ---------------
 * On an upstream build the two constants are equal, `isForkBuild()` is false,
 * and every guard here is a no-op. This module is therefore safe to contribute
 * upstream unchanged — forks flip ONE line and inherit the protection.
 *
 * NO ESCAPE HATCH, DELIBERATELY
 * -----------------------------
 * There is no `GBRAIN_ALLOW_FOREIGN_UPGRADE`. An operator who genuinely wants
 * upstream gbrain installs upstream gbrain directly; they do not ask a fork to
 * overwrite itself with a different project. An env override would recreate
 * exactly the footgun this closes, and "it was set once in a service unit" is
 * how that override would actually be encountered.
 */

/** The repo whose GitHub releases the upgrade machinery downloads. */
export const UPSTREAM_RELEASE_REPO: string = 'garrytan/gbrain';

/**
 * The repo THIS build is distributed from. Forks change this line and nothing
 * else. Kept as a bare `owner/name` so it composes into API and web URLs.
 */
export const DISTRIBUTION_REPO: string = 'arkologystudio/knowledge-system';

/** GitHub API endpoint for the upstream latest release. One definition, many callers. */
export const UPSTREAM_LATEST_RELEASE_API =
  `https://api.github.com/repos/${UPSTREAM_RELEASE_REPO}/releases/latest`;

/** True when this build's releases and its upgrade target are different projects. */
export function isForkBuild(): boolean {
  return DISTRIBUTION_REPO !== UPSTREAM_RELEASE_REPO;
}

/** Raised by `assertUpgradeAllowed`. Carries an exit-worthy operator message. */
export class ForeignUpgradeRefused extends Error {
  readonly code = 'foreign_upgrade_refused';
  constructor(message: string) {
    super(message);
    this.name = 'ForeignUpgradeRefused';
  }
}

/**
 * The refusal text. Names both projects and points at the deploy path that IS
 * correct for this build, because a refusal that doesn't say what to do instead
 * just gets worked around.
 */
export function foreignUpgradeMessage(command: string): string {
  return (
    `Refusing to run \`${command}\`: this is a fork.\n\n` +
    `  This build:      ${DISTRIBUTION_REPO}\n` +
    `  Upgrade target:  ${UPSTREAM_RELEASE_REPO}\n\n` +
    `The upgrade machinery installs GitHub releases from ${UPSTREAM_RELEASE_REPO}. ` +
    `Running it here would overwrite this fork with a different project and revert ` +
    `every fork-local change.\n\n` +
    `To update this build, deploy from its own repository instead:\n` +
    `  git -C <checkout> pull --ff-only && bun install --frozen-lockfile\n\n` +
    `If you genuinely want upstream gbrain, install it separately rather than ` +
    `having this build replace itself.`
  );
}

/**
 * Fail-closed gate for any code path that would APPLY a foreign release.
 * Passive checks should use `isForkBuild()` and degrade quietly instead — a
 * fork should simply never see an upgrade nag, not crash on startup.
 */
export function assertUpgradeAllowed(command: string): void {
  if (isForkBuild()) throw new ForeignUpgradeRefused(foreignUpgradeMessage(command));
}
