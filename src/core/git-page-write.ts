/**
 * Git-first page writes for remote agents.
 *
 * The repository is the system of record. This helper previews a proposed
 * markdown change against a clean, freshly-pulled source checkout, then applies
 * it only when the caller presents the exact previewed HEAD. The git commit is
 * pushed before the caller updates the derived brain index.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { validateSlug } from './utils.ts';
import { isWriteTargetContained } from './path-confine.ts';
import { CONTENT_FLAG_KEY, QUARANTINE_KEY } from './quarantine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';
import {
  divergenceSafePull,
  GIT_ENV_AUTH,
  GIT_SSRF_SUBCOMMAND_FLAGS,
  isWorkingTreeDirty,
} from './git-remote.ts';
import { unifiedDiff } from './skillpack/diff-text.ts';

const MAX_CONTENT_BYTES = 5_000_000;
const MAX_DIFF_CHARS = 40_000;
const LOCK_NAME = 'gbrain-commit-page.lock';
const PROTECTED_FRONTMATTER = [QUARANTINE_KEY, CONTENT_FLAG_KEY, EMBED_SKIP_KEY] as const;

export type GitPageWriteMode = 'preview' | 'apply';

export interface GitPageWriteInput {
  mode: GitPageWriteMode;
  sourceId: string;
  slug: string;
  content: string;
  expectedHead?: string;
  expectedContentSha256?: string;
  commitMessage?: string;
  actor: string;
  protectedSlugs?: readonly string[];
}

export interface GitPageWriteResult {
  mode: GitPageWriteMode;
  source_id: string;
  slug: string;
  path: string;
  changed: boolean;
  head_before: string;
  head_after?: string;
  content_sha256: string;
  diff: string;
  diff_truncated: boolean;
  committed?: boolean;
  pushed?: boolean;
}

export class GitPageWriteError extends Error {
  constructor(
    public code:
      | 'disabled'
      | 'invalid_content'
      | 'protected_path'
      | 'repo_unavailable'
      | 'repo_dirty'
      | 'repo_conflict'
      | 'stale_preview'
      | 'nothing_to_commit'
      | 'commit_failed'
      | 'push_failed',
    message: string,
  ) {
    super(message);
    this.name = 'GitPageWriteError';
  }
}

const repoQueues = new Map<string, Promise<void>>();

async function serializeForRepo<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(repoPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  repoQueues.set(repoPath, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (repoQueues.get(repoPath) === queued) repoQueues.delete(repoPath);
  }
}

function git(repoPath: string, args: readonly string[], timeout = 120_000): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    env: { ...process.env, ...GIT_ENV_AUTH },
  }).trim();
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function matchesSlug(slug: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const clean = pattern.trim().replace(/\.md$/i, '');
    if (!clean) return false;
    if (clean.endsWith('/*')) {
      const prefix = clean.slice(0, -2);
      return slug.startsWith(`${prefix}/`);
    }
    return slug === clean;
  });
}

function validateContent(slug: string, content: string, protectedSlugs: readonly string[]): string {
  const normalizedSlug = validateSlug(slug);
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new GitPageWriteError('invalid_content', `content exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  if (matchesSlug(normalizedSlug, protectedSlugs)) {
    throw new GitPageWriteError(
      'protected_path',
      `remote commit_page writes are disabled for protected slug '${normalizedSlug}'`,
    );
  }
  const parsed = parseMarkdown(content, `${normalizedSlug}.md`, {
    validate: true,
    expectedSlug: normalizedSlug,
  });
  if (parsed.errors?.length) {
    const detail = parsed.errors.slice(0, 5).map((e) => `${e.code}@${e.line}: ${e.message}`).join('; ');
    throw new GitPageWriteError('invalid_content', detail);
  }
  const forbidden = PROTECTED_FRONTMATTER.filter((key) => parsed.frontmatter[key] !== undefined);
  if (forbidden.length > 0) {
    throw new GitPageWriteError(
      'invalid_content',
      `remote callers cannot set gate-owned frontmatter: ${forbidden.join(', ')}`,
    );
  }
  return normalizedSlug;
}

async function resolveRepoPath(engine: BrainEngine, sourceId: string): Promise<string> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    'SELECT local_path FROM sources WHERE id = $1',
    [sourceId],
  );
  const sourcePath = rows[0]?.local_path ?? null;
  if (sourcePath) return sourcePath;

  const repoPath = await engine.getConfig('sync.repo_path');
  if (!repoPath) throw new GitPageWriteError('repo_unavailable', `source '${sourceId}' has no local checkout`);

  const otherSources = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id <> $1 AND local_path = $2 LIMIT 1',
    [sourceId, repoPath],
  );
  if (otherSources.length > 0) {
    throw new GitPageWriteError('repo_unavailable', `configured checkout belongs to another source`);
  }
  return repoPath;
}

function acquireLock(repoPath: string): () => void {
  const gitDir = git(repoPath, ['rev-parse', '--git-dir'], 10_000);
  const lockPath = join(isAbsolute(gitDir) ? gitDir : join(repoPath, gitDir), LOCK_NAME);
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    throw new GitPageWriteError('repo_dirty', 'another commit_page write is in progress');
  }
  return () => {
    try { closeSync(fd); } catch { /* best effort */ }
    try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function safeActor(actor: string): string {
  const cleaned = actor.replace(/[\r\n\0]/g, ' ').trim().slice(0, 120);
  return cleaned || 'unknown-agent';
}

function commitMessage(subject: string, actor: string, sourceId: string): string {
  const cleanSubject = subject.replace(/[\r\n\0]/g, ' ').trim().slice(0, 180);
  if (!cleanSubject) throw new GitPageWriteError('invalid_content', 'commit_message is required for apply');
  return `${cleanSubject}\n\nKnowledge-Actor: ${safeActor(actor)}\nKnowledge-Source: ${sourceId}`;
}

export async function gitFirstPageWrite(
  engine: BrainEngine,
  input: GitPageWriteInput,
): Promise<GitPageWriteResult> {
  const slug = validateContent(input.slug, input.content, input.protectedSlugs ?? []);
  const repoPath = await resolveRepoPath(engine, input.sourceId);
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory() || !existsSync(join(repoPath, '.git'))) {
    throw new GitPageWriteError('repo_unavailable', `not a git checkout: ${repoPath}`);
  }

  return serializeForRepo(repoPath, async () => {
    const releaseLock = acquireLock(repoPath);
    try {
      if (isWorkingTreeDirty(repoPath)) {
        throw new GitPageWriteError('repo_dirty', 'source checkout has uncommitted changes');
      }
      const branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000);
      if (!branch || branch === 'HEAD') {
        throw new GitPageWriteError('repo_unavailable', 'source checkout is on detached HEAD');
      }
      const pull = divergenceSafePull(repoPath, branch);
      if (pull.status === 'skipped_dirty') {
        throw new GitPageWriteError('repo_dirty', 'source checkout became dirty before pull');
      }
      if (pull.status === 'conflict_aborted') {
        throw new GitPageWriteError('repo_conflict', pull.detail);
      }

      const head = git(repoPath, ['rev-parse', 'HEAD'], 10_000);
      const filePath = join(repoPath, `${slug}.md`);
      if (!isWriteTargetContained(filePath, repoPath)) {
        throw new GitPageWriteError('invalid_content', 'resolved page path escapes source checkout');
      }
      const before = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      const diffFull = unifiedDiff(before, input.content, {
        oldPath: `a/${slug}.md`,
        newPath: `b/${slug}.md`,
      });
      const changed = before !== input.content;
      const diffTruncated = diffFull.length > MAX_DIFF_CHARS;
      const diff = diffTruncated ? `${diffFull.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...\n` : diffFull;
      const base: GitPageWriteResult = {
        mode: input.mode,
        source_id: input.sourceId,
        slug,
        path: relative(repoPath, filePath),
        changed,
        head_before: head,
        content_sha256: sha256(input.content),
        diff,
        diff_truncated: diffTruncated,
      };

      if (input.mode === 'preview') return base;
      if (!input.expectedHead || input.expectedHead !== head) {
        throw new GitPageWriteError(
          'stale_preview',
          `previewed HEAD ${input.expectedHead || '<missing>'} does not match current HEAD ${head}`,
        );
      }
      if (!input.expectedContentSha256 || input.expectedContentSha256 !== base.content_sha256) {
        throw new GitPageWriteError(
          'stale_preview',
          `previewed content hash ${input.expectedContentSha256 || '<missing>'} does not match proposed content ${base.content_sha256}`,
        );
      }
      if (!changed) throw new GitPageWriteError('nothing_to_commit', 'proposed content matches the canonical page');

      atomicWrite(filePath, input.content);
      try {
        git(repoPath, ['add', '--', `${slug}.md`], 30_000);
        git(repoPath, ['commit', '-m', commitMessage(input.commitMessage ?? '', input.actor, input.sourceId)], 60_000);
      } catch (e) {
        try { git(repoPath, ['reset', '--mixed', 'HEAD'], 10_000); } catch { /* best effort */ }
        try { git(repoPath, ['restore', '--source=HEAD', '--', `${slug}.md`], 10_000); } catch {
          if (!before) rmSync(filePath, { force: true });
        }
        throw new GitPageWriteError('commit_failed', e instanceof Error ? e.message : String(e));
      }

      const committedHead = git(repoPath, ['rev-parse', 'HEAD'], 10_000);
      try {
        git(repoPath, [
          '-c', 'http.followRedirects=false',
          'push', ...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', `HEAD:${branch}`,
        ], 180_000);
      } catch (e) {
        throw new GitPageWriteError(
          'push_failed',
          `commit ${committedHead.slice(0, 12)} is local-only; push failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      return { ...base, head_after: committedHead, committed: true, pushed: true };
    } finally {
      releaseLock();
    }
  });
}
