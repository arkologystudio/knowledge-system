/**
 * Mirror convergence pins.
 *
 * The property being pinned is not "reset works" — it is that **there is no state
 * a mirror can reach from which it cannot recover unattended**. `--ff-only`
 * failed that: one local commit inside the Arkology mirror wedged every pull for
 * a day and hid three weeks of staleness behind the failure.
 *
 * The second, equally load-bearing property: convergence never destroys evidence
 * silently. A reset that quietly ate a colleague's uncommitted work would trade
 * one incident class for a worse one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convergeMirror } from '../src/core/git-remote.ts';

let root: string;
let remote: string;
let mirror: string;
let author: string;
let quarantine: string;
const originalFileTransport = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function seed(repo: string): void {
  git(repo, ['config', 'user.name', 'GBrain Test']);
  git(repo, ['config', 'user.email', 'gbrain-test@example.invalid']);
}

beforeEach(() => {
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-mirror-'));
  remote = path.join(root, 'remote.git');
  mirror = path.join(root, 'mirror');
  author = path.join(root, 'author');
  quarantine = path.join(root, 'quarantine');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, author], { stdio: 'ignore' });
  seed(author);
  fs.writeFileSync(path.join(author, 'README.md'), '# Brain\n');
  git(author, ['add', '.']);
  git(author, ['commit', '-m', 'seed']);
  git(author, ['branch', '-M', 'main']);
  git(author, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['clone', remote, mirror], { stdio: 'ignore' });
  seed(mirror);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalFileTransport === undefined) delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  else process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = originalFileTransport;
});

/** Push a new upstream commit from the author clone. */
function upstreamCommit(name: string): string {
  fs.writeFileSync(path.join(author, name), `content of ${name}\n`);
  git(author, ['add', '.']);
  git(author, ['commit', '-m', `add ${name}`]);
  git(author, ['push', 'origin', 'main']);
  return git(author, ['rev-parse', 'HEAD']);
}

describe('convergeMirror', () => {
  test('fast-forwards a clean mirror and reports no violations', async () => {
    const head = upstreamCommit('note.md');
    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    expect(res.after).toBe(head);
    expect(res.violations).toHaveLength(0);
    expect(fs.existsSync(path.join(mirror, 'note.md'))).toBe(true);
  });

  test('a no-op converge is a no-op', async () => {
    const before = git(mirror, ['rev-parse', 'HEAD']);
    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    expect(res.after).toBe(before);
    expect(res.violations).toHaveLength(0);
  });

  test('RECOVERS from the exact incident: a local commit plus upstream commits', async () => {
    // This is the state that wedged production. `git pull --ff-only` fails here
    // permanently; convergence must resolve it unattended and on the first try.
    fs.writeFileSync(path.join(mirror, 'stray.md'), 'written into the mirror\n');
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'chore: tidy untracked file']);
    const strayHead = git(mirror, ['rev-parse', 'HEAD']);
    const upstream = upstreamCommit('legit.md');

    // Prove the old behaviour would wedge.
    expect(() => git(mirror, ['pull', '--ff-only'])).toThrow();

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    expect(res.after).toBe(upstream);
    expect(fs.existsSync(path.join(mirror, 'legit.md'))).toBe(true);
    expect(fs.existsSync(path.join(mirror, 'stray.md'))).toBe(false);

    // Evidence preserved, not destroyed: the commit is still reachable by ref.
    const v = res.violations.find((x) => x.kind === 'local_commits');
    expect(v).toBeDefined();
    expect(git(mirror, ['rev-parse', 'refs/gbrain/rescue/' + strayHead.slice(0, 12)])).toBe(strayHead);
    expect(git(mirror, ['show', `${strayHead}:stray.md`])).toContain('written into the mirror');
  });

  test('quarantines uncommitted work before resetting it away', async () => {
    fs.writeFileSync(path.join(mirror, 'untracked.md'), 'someone was mid-edit\n');
    fs.writeFileSync(path.join(mirror, 'README.md'), '# Brain\nlocally modified\n');
    upstreamCommit('other.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });

    // The tree is clean and matches origin.
    expect(git(mirror, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(mirror, 'README.md'), 'utf8')).toBe('# Brain\n');

    const v = res.violations.find((x) => x.kind === 'dirty_files');
    expect(v).toBeDefined();
    // Both the untracked file and the modified one survive in quarantine.
    const saved = fs.readFileSync(path.join(v!.preservedAt, 'untracked.md'), 'utf8');
    expect(saved).toBe('someone was mid-edit\n');
    expect(fs.readFileSync(path.join(v!.preservedAt, 'README.md'), 'utf8')).toContain('locally modified');
  });

  test('preserves an untracked DIRECTORY tree rather than letting clean -fd eat it', async () => {
    // The shape that actually loses data: a new slug namespace is a new untracked
    // directory, which porcelain collapses to `dir/` without -uall. Copying that
    // entry fails while `clean -fd` deletes the whole tree.
    fs.mkdirSync(path.join(mirror, 'wiki/notes'), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'wiki/notes/important.md'), 'PRECIOUS DATA A\n');
    fs.writeFileSync(path.join(mirror, 'wiki/top.md'), 'also precious\n');
    upstreamCommit('unrelated.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });

    expect(git(mirror, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(mirror, 'wiki/notes/important.md'))).toBe(false);
    const v = res.violations.find((x) => x.kind === 'dirty_files')!;
    expect(fs.readFileSync(path.join(v.preservedAt, 'wiki/notes/important.md'), 'utf8')).toBe('PRECIOUS DATA A\n');
    expect(fs.readFileSync(path.join(v.preservedAt, 'wiki/top.md'), 'utf8')).toBe('also precious\n');
  });

  test('preserves paths git would quote and C-escape', async () => {
    // Without -z, git emits `"caf\303\251.md"`; stripping the quotes leaves the
    // escapes, the path never resolves, and the reset destroys the file.
    fs.writeFileSync(path.join(mirror, 'café.md'), 'PRECIOUS DATA B\n');
    fs.writeFileSync(path.join(mirror, 'with space.md'), 'PRECIOUS DATA C\n');
    fs.writeFileSync(path.join(mirror, 'quo"te.md'), 'PRECIOUS DATA D\n');
    upstreamCommit('unrelated2.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    const v = res.violations.find((x) => x.kind === 'dirty_files')!;

    expect(fs.readFileSync(path.join(v.preservedAt, 'café.md'), 'utf8')).toBe('PRECIOUS DATA B\n');
    expect(fs.readFileSync(path.join(v.preservedAt, 'with space.md'), 'utf8')).toBe('PRECIOUS DATA C\n');
    expect(fs.readFileSync(path.join(v.preservedAt, 'quo"te.md'), 'utf8')).toBe('PRECIOUS DATA D\n');
    expect(git(mirror, ['status', '--porcelain'])).toBe('');
  });

  test('preserves a staged rename without mis-parsing the origin-path field', async () => {
    // -z emits `R  new\0old\0`; consuming the origin field is required or every
    // later entry shifts by one and gets mis-copied.
    git(mirror, ['mv', 'README.md', 'RENAMED.md']);
    fs.writeFileSync(path.join(mirror, 'after-rename.md'), 'PRECIOUS DATA E\n');
    upstreamCommit('unrelated3.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    const v = res.violations.find((x) => x.kind === 'dirty_files')!;
    expect(fs.readFileSync(path.join(v.preservedAt, 'after-rename.md'), 'utf8')).toBe('PRECIOUS DATA E\n');
    expect(git(mirror, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(mirror, 'README.md'))).toBe(true);
  });

  test('preserves a symlink as a link, not as a copy of its target', async () => {
    fs.writeFileSync(path.join(mirror, 'target.md'), 'target body\n');
    fs.symlinkSync('target.md', path.join(mirror, 'link.md'));
    upstreamCommit('unrelated4.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    const v = res.violations.find((x) => x.kind === 'dirty_files')!;
    const saved = path.join(v.preservedAt, 'link.md');
    expect(fs.lstatSync(saved).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(saved)).toBe('target.md');
  });

  test('a deleted tracked file is restored and does not abort the scan', async () => {
    fs.rmSync(path.join(mirror, 'README.md'));
    fs.writeFileSync(path.join(mirror, 'survivor.md'), 'PRECIOUS DATA F\n');
    upstreamCommit('unrelated5.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    expect(fs.existsSync(path.join(mirror, 'README.md'))).toBe(true);
    const v = res.violations.find((x) => x.kind === 'dirty_files')!;
    expect(fs.readFileSync(path.join(v.preservedAt, 'survivor.md'), 'utf8')).toBe('PRECIOUS DATA F\n');
  });

  test('with no quarantine root it still REPORTS the discard instead of going silent', async () => {
    fs.writeFileSync(path.join(mirror, 'doomed.md'), 'x\n');
    upstreamCommit('unrelated6.md');
    const res = convergeMirror(mirror, { quarantineRoot: '' });
    const v = res.violations.find((x) => x.kind === 'dirty_files');
    expect(v).toBeDefined();
    expect(v!.detail).toMatch(/DISCARDED/);
  });

  test('reports both violation kinds when both are present', async () => {
    fs.writeFileSync(path.join(mirror, 'a.md'), 'a\n');
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'local']);
    fs.writeFileSync(path.join(mirror, 'b.md'), 'b\n');
    upstreamCommit('c.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    expect(res.violations.map((v) => v.kind).sort()).toEqual(['dirty_files', 'local_commits']);
    expect(git(mirror, ['status', '--porcelain'])).toBe('');
  });

  test('an upstream .gitignore change cannot destroy a file the scan never saw', async () => {
    // The scan runs against the CURRENT .gitignore; if `clean -fd` ran AFTER the
    // reset it would apply the INCOMING one, deleting anything the old rules hid
    // and the new rules do not — unpreserved, and with no violation reported.
    // An ordinary upstream .gitignore edit is enough to trigger it.
    fs.writeFileSync(path.join(author, '.gitignore'), 'scratch/\n');
    git(author, ['add', '.']);
    git(author, ['commit', '-m', 'ignore scratch']);
    git(author, ['push', 'origin', 'main']);
    convergeMirror(mirror, { quarantineRoot: quarantine });

    // The mirror has an ignored file; upstream then STOPS ignoring that path.
    fs.mkdirSync(path.join(mirror, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'scratch/notes.md'), 'PRECIOUS DATA G\n');
    fs.writeFileSync(path.join(author, '.gitignore'), '# nothing ignored now\n');
    git(author, ['add', '.']);
    git(author, ['commit', '-m', 'stop ignoring scratch']);
    git(author, ['push', 'origin', 'main']);

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });

    // Either it survived untouched, or it was quarantined — but it must not have
    // been destroyed silently.
    const stillThere = fs.existsSync(path.join(mirror, 'scratch/notes.md'));
    const v = res.violations.find((x) => x.kind === 'dirty_files');
    const quarantined = v ? fs.existsSync(path.join(v.preservedAt, 'scratch/notes.md')) : false;
    expect(stillThere || quarantined).toBe(true);
  });

  test('a failed fetch leaves the mirror untouched rather than resetting onto a stale ref', async () => {
    // Losing the remote must not cause the mirror to converge onto whatever its
    // remote-tracking ref last happened to say.
    fs.writeFileSync(path.join(mirror, 'local-work.md'), 'unpushed\n');
    git(mirror, ['add', '.']);
    git(mirror, ['commit', '-m', 'local only']);
    const before = git(mirror, ['rev-parse', 'HEAD']);
    fs.rmSync(remote, { recursive: true, force: true });

    expect(() => convergeMirror(mirror, { quarantineRoot: quarantine })).toThrow(/fetch failed/);
    expect(git(mirror, ['rev-parse', 'HEAD'])).toBe(before);
    expect(fs.existsSync(path.join(mirror, 'local-work.md'))).toBe(true);
  });

  test('an un-cleanable nested repo is reported ONCE as unremovable, not re-quarantined forever', async () => {
    // `git clean -fd` refuses to delete a nested git repository, so it survives.
    // Reporting it as "quarantined" is a lie, and re-copying it every 5 minutes
    // would grow the quarantine without bound and never clear the alarm.
    const nested = path.join(mirror, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', nested], { stdio: 'ignore' });
    fs.writeFileSync(path.join(nested, 'inner.md'), 'inner\n');
    upstreamCommit('other7.md');

    const first = convergeMirror(mirror, { quarantineRoot: quarantine });
    const stuck = first.violations.find((v) => v.kind === 'unremovable');
    expect(stuck).toBeDefined();
    expect(stuck!.detail).toMatch(/nested/);
    // Nothing was lost, so nothing should be claimed as quarantined.
    expect(first.violations.find((v) => v.kind === 'dirty_files')).toBeUndefined();
    expect(fs.existsSync(path.join(nested, 'inner.md'))).toBe(true);

    // A second run must not accumulate another copy of the same surviving tree.
    const before = fs.existsSync(quarantine) ? fs.readdirSync(quarantine).length : 0;
    const second = convergeMirror(mirror, { quarantineRoot: quarantine });
    const after = fs.existsSync(quarantine) ? fs.readdirSync(quarantine).length : 0;
    expect(second.violations.find((v) => v.kind === 'unremovable')).toBeDefined();
    expect(after).toBe(before);
  });

  test('an UNWRITABLE untracked path does not stop the mirror converging', async () => {
    // `git clean -fd` EXITS 1 when it cannot unlink something (unwritable dir,
    // EBUSY mount, NFS silly-rename). Treating that as fatal meant reset never
    // ran and the mirror never converged — permanently stale, recoverable only by
    // hand: the original wedging bug in a new costume. The confusing sibling is a
    // nested git repo, which clean REFUSES but exits 0, so that case always
    // worked. Both must converge.
    const locked = path.join(mirror, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'stuck.md'), 'cannot be removed\n');
    fs.chmodSync(locked, 0o500);
    const head = upstreamCommit('progress.md');

    let res;
    try {
      res = convergeMirror(mirror, { quarantineRoot: quarantine });
    } finally {
      fs.chmodSync(locked, 0o700);
    }

    // The mirror CONVERGED despite the un-cleanable path.
    expect(res!.after).toBe(head);
    expect(fs.existsSync(path.join(mirror, 'progress.md'))).toBe(true);
    // …and said so, once, without claiming it was quarantined.
    const stuck = res!.violations.find((v) => v.kind === 'unremovable');
    expect(stuck).toBeDefined();
    expect(stuck!.detail).toMatch(/locked/);
    expect(fs.existsSync(path.join(locked, 'stuck.md'))).toBe(true);
  });

  test('dirty_files reports what was DESTROYED, not the whole scan', async () => {
    // Counting survivors as losses overstates the damage and erodes trust in the
    // number at the moment it matters.
    const nested = path.join(mirror, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', nested], { stdio: 'ignore' });
    fs.writeFileSync(path.join(mirror, 'gone-a.md'), 'a\n');
    fs.writeFileSync(path.join(mirror, 'gone-b.md'), 'b\n');
    upstreamCommit('other8.md');

    const res = convergeMirror(mirror, { quarantineRoot: quarantine });
    const dirty = res.violations.find((v) => v.kind === 'dirty_files')!;
    expect(dirty.detail).toMatch(/^2 uncommitted change\(s\) destroyed/);
    expect(res.violations.find((v) => v.kind === 'unremovable')).toBeDefined();
  });

  test('with no quarantine root, survivor cleanup never touches the process CWD', async () => {
    // `join('', rel)` is a RELATIVE path; rmSync would then delete from cwd,
    // outside the repo entirely.
    const decoy = path.join(root, 'cwd-decoy');
    fs.mkdirSync(path.join(decoy, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(decoy, 'nested/PRECIOUS_CWD.txt'), 'do not delete\n');
    const nested = path.join(mirror, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', nested], { stdio: 'ignore' });
    upstreamCommit('other9.md');

    const prevCwd = process.cwd();
    try {
      process.chdir(decoy);
      convergeMirror(mirror, { quarantineRoot: '' });
    } finally {
      process.chdir(prevCwd);
    }
    expect(fs.existsSync(path.join(decoy, 'nested/PRECIOUS_CWD.txt'))).toBe(true);
  });

  test('a reset that fails after clean still reports where the files went', async () => {
    // clean is destructive and reset is the step most likely to throw. A bare
    // throw would delete files and take the record of their quarantine with it,
    // leaving the operator a generic "pull failed" and no idea anything was gone.
    fs.writeFileSync(path.join(mirror, 'doomed.md'), 'PRECIOUS DATA H\n');
    // Make the incoming tree impossible to check out: a read-only directory the
    // reset must write into.
    fs.mkdirSync(path.join(author, 'locked'), { recursive: true });
    fs.writeFileSync(path.join(author, 'locked/file.md'), 'x\n');
    git(author, ['add', '.']);
    git(author, ['commit', '-m', 'add locked dir']);
    git(author, ['push', 'origin', 'main']);
    fs.mkdirSync(path.join(mirror, 'locked'), { recursive: true });
    // A file inside, so `clean -fd` cannot remove the directory and `reset` is
    // then forced to write into a read-only one.
    fs.writeFileSync(path.join(mirror, 'locked/blocker.md'), 'blocks the checkout\n');
    fs.chmodSync(path.join(mirror, 'locked'), 0o500);

    let err: any;
    try {
      convergeMirror(mirror, { quarantineRoot: quarantine });
    } catch (e) {
      err = e;
    } finally {
      fs.chmodSync(path.join(mirror, 'locked'), 0o700);
    }

    expect(err).toBeDefined();
    // The violations survived the throw, so the operator can find the copies.
    expect(Array.isArray(err.violations)).toBe(true);
    const v = err.violations.find((x: any) => x.kind === 'dirty_files');
    expect(v).toBeDefined();
    expect(fs.readFileSync(path.join(v.preservedAt, 'doomed.md'), 'utf8')).toBe('PRECIOUS DATA H\n');
  });

  test('refuses a detached HEAD rather than guessing a branch', async () => {
    git(mirror, ['checkout', '--detach', 'HEAD']);
    expect(() => convergeMirror(mirror, { quarantineRoot: quarantine })).toThrow(/detached HEAD/);
  });

  test('converges repeatedly — the operation is idempotent', async () => {
    upstreamCommit('one.md');
    const a = convergeMirror(mirror, { quarantineRoot: quarantine });
    const b = convergeMirror(mirror, { quarantineRoot: quarantine });
    expect(b.after).toBe(a.after);
    expect(b.violations).toHaveLength(0);
  });
});
