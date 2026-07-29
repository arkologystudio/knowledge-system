/**
 * Thin git helpers for per-leg commits.
 *
 * Per-leg commits keep one upstream outage from leaving a partially-written tree
 * and make the history readable (one commit per source per run). Nothing is
 * committed when nothing is staged — the final backstop for idempotency.
 */
import { execFileSync } from 'node:child_process';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

/** True when the index has staged changes. */
function hasStaged(repoRoot: string): boolean {
  try {
    git(repoRoot, ['diff', '--cached', '--quiet']);
    return false; // exit 0 = no staged changes
  } catch {
    return true; // non-zero = staged changes present
  }
}

/**
 * Stage the given repo-relative paths and commit them with `message`.
 * Returns true if a commit was made, false if there was nothing to commit.
 *
 * `paths` may include deletions — `git add -A -- <path>` records a removal too.
 */
export function commitPaths(repoRoot: string, paths: string[], message: string): boolean {
  if (paths.length === 0) return false;
  git(repoRoot, ['add', '-A', '--', ...paths]);
  if (!hasStaged(repoRoot)) return false;
  git(repoRoot, ['commit', '--no-verify', '-m', message]);
  return true;
}
