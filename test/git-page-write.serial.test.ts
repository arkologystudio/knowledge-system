import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { gitFirstPageWrite, GitPageWriteError } from '../src/core/git-page-write.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let root: string;
let remote: string;
let checkout: string;
const originalFileTransport = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function page(body: string): string {
  return `---\ntitle: Git First\ntype: note\n---\n\n# Git First\n\n${body}\n`;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (originalFileTransport === undefined) delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  else process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = originalFileTransport;
});

beforeEach(async () => {
  await resetPgliteState(engine);
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-git-page-'));
  remote = path.join(root, 'remote.git');
  checkout = path.join(root, 'checkout');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, checkout], { stdio: 'ignore' });
  git(checkout, ['config', 'user.name', 'GBrain Test']);
  git(checkout, ['config', 'user.email', 'gbrain-test@example.invalid']);
  fs.writeFileSync(path.join(checkout, 'README.md'), '# Brain\n');
  git(checkout, ['add', 'README.md']);
  git(checkout, ['commit', '-m', 'seed']);
  git(checkout, ['branch', '-M', 'main']);
  git(checkout, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [checkout, 'default']);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('gitFirstPageWrite', () => {
  test('preview returns diff + concurrency tokens; apply pushes exact content', async () => {
    const content = page('A durable idea.');
    const preview = await gitFirstPageWrite(engine, {
      mode: 'preview', sourceId: 'default', slug: 'wiki/concepts/durable-idea', content, actor: 'mcp:test',
    });
    expect(preview.changed).toBe(true);
    expect(preview.diff).toContain('+A durable idea.');
    expect(preview.head_before).toMatch(/^[0-9a-f]{40}$/);
    expect(preview.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(checkout, 'wiki/concepts/durable-idea.md'))).toBe(false);

    const applied = await gitFirstPageWrite(engine, {
      mode: 'apply',
      sourceId: 'default',
      slug: 'wiki/concepts/durable-idea',
      content,
      actor: 'mcp:test',
      commitMessage: 'synthesis: durable idea',
      expectedHead: preview.head_before,
      expectedContentSha256: preview.content_sha256,
    });
    expect(applied.pushed).toBe(true);
    expect(fs.readFileSync(path.join(checkout, 'wiki/concepts/durable-idea.md'), 'utf8')).toBe(content);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(remote, ['rev-parse', 'refs/heads/main']));
    const message = git(checkout, ['log', '-1', '--format=%B']);
    expect(message).toContain('Knowledge-Actor: mcp:test');
    expect(message).toContain('Knowledge-Source: default');
  });

  test('apply is rejected when content differs from the preview', async () => {
    const preview = await gitFirstPageWrite(engine, {
      mode: 'preview', sourceId: 'default', slug: 'wiki/concepts/a', content: page('A'), actor: 'mcp:test',
    });
    await expect(gitFirstPageWrite(engine, {
      mode: 'apply',
      sourceId: 'default',
      slug: 'wiki/concepts/a',
      content: page('B'),
      actor: 'mcp:test',
      commitMessage: 'synthesis: a',
      expectedHead: preview.head_before,
      expectedContentSha256: preview.content_sha256,
    })).rejects.toMatchObject({ code: 'stale_preview' });
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
  });

  test('protected slugs and gate-owned frontmatter fail before git mutation', async () => {
    await expect(gitFirstPageWrite(engine, {
      mode: 'preview', sourceId: 'default', slug: 'north-star', content: page('change'), actor: 'mcp:test', protectedSlugs: ['north-star', 'voice/*'],
    })).rejects.toMatchObject({ code: 'protected_path' });

    const forged = `---\ntitle: Hidden\ntype: note\nquarantine: true\n---\n\nbody\n`;
    await expect(gitFirstPageWrite(engine, {
      mode: 'preview', sourceId: 'default', slug: 'wiki/hidden', content: forged, actor: 'mcp:test',
    })).rejects.toBeInstanceOf(GitPageWriteError);
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
  });

  test('refuses a dirty checkout without touching unrelated work', async () => {
    fs.writeFileSync(path.join(checkout, 'unrelated.txt'), 'mine');
    await expect(gitFirstPageWrite(engine, {
      mode: 'preview', sourceId: 'default', slug: 'wiki/concepts/a', content: page('A'), actor: 'mcp:test',
    })).rejects.toMatchObject({ code: 'repo_dirty' });
    expect(fs.readFileSync(path.join(checkout, 'unrelated.txt'), 'utf8')).toBe('mine');
  });

  test('redacts URL credentials from push failures returned to remote callers', async () => {
    const preview = await gitFirstPageWrite(engine, {
      mode: 'preview', sourceId: 'default', slug: 'wiki/concepts/redacted-error', content: page('Safe'), actor: 'mcp:test',
    });
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by https://alice:super-secret@example.invalid/repo" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    try {
      await gitFirstPageWrite(engine, {
        mode: 'apply',
        sourceId: 'default',
        slug: 'wiki/concepts/redacted-error',
        content: page('Safe'),
        actor: 'mcp:test',
        commitMessage: 'synthesis: redacted error',
        expectedHead: preview.head_before,
        expectedContentSha256: preview.content_sha256,
      });
      throw new Error('expected push to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GitPageWriteError);
      expect((error as Error).message).toContain('https://***@example.invalid/repo');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});

test('commit_page operation is write-scoped and MCP-visible', () => {
  const op = operations.find((candidate) => candidate.name === 'commit_page');
  expect(op).toBeDefined();
  expect(op?.scope).toBe('write');
  expect(op?.localOnly).not.toBe(true);
  expect(op?.params.mode.enum).toEqual(['preview', 'apply']);
});

test('Git-first mode rejects remote and missing-trust put_page before mutation', async () => {
  const op = operations.find((candidate) => candidate.name === 'put_page');
  expect(op).toBeDefined();
  await engine.setConfig('writer.commit_page.enabled', 'true');

  try {
    for (const remote of [true, undefined]) {
      const ctx = {
        engine,
        config: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        dryRun: false,
        remote,
        sourceId: 'default',
      } as unknown as OperationContext;

      await expect(op!.handler(ctx, {
        slug: 'wiki/concepts/must-use-git',
        content: page('This must never bypass Git.'),
      })).rejects.toMatchObject({
        code: 'permission_denied',
        suggestion: expect.stringContaining('commit_page'),
      });
    }
    expect(await engine.getPage('wiki/concepts/must-use-git', { sourceId: 'default' })).toBeNull();
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
  } finally {
    await engine.setConfig('writer.commit_page.enabled', 'false');
  }
});
