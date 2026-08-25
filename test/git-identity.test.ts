import { describe, expect, test } from 'bun:test';
import {
  GIT_IDENTITY_DEFAULT_KEY,
  gitIdentityEnv,
  parseGitIdentity,
  resolveGitIdentity,
} from '../src/core/git-identity.ts';

/** Minimal stand-in for the config + principals planes; the resolver only reads. */
function fakeEngine(
  config: Record<string, string>,
  principals: Record<number, { subject: string | null; display_name: string | null }> = {},
) {
  return {
    getConfig: async (key: string) => config[key] ?? null,
    executeRaw: async <T>(_sql: string, params?: unknown[]): Promise<T[]> => {
      const row = principals[params?.[0] as number];
      return (row ? [row] : []) as T[];
    },
  };
}

/** A brain predating the principals migration: the table simply is not there. */
function engineWithoutPrincipals(config: Record<string, string>) {
  return {
    getConfig: async (key: string) => config[key] ?? null,
    executeRaw: async <T>(): Promise<T[]> => {
      throw new Error('relation "principals" does not exist');
    },
  };
}

describe('parseGitIdentity', () => {
  test('parses the `Name <email>` shape git itself prints', () => {
    expect(parseGitIdentity('Che Coelho <checoelho@gmail.com>')).toEqual({
      name: 'Che Coelho',
      email: 'checoelho@gmail.com',
    });
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseGitIdentity('  Che Coelho   <che@example.com>  ')).toEqual({
      name: 'Che Coelho',
      email: 'che@example.com',
    });
  });

  test('rejects malformed values rather than throwing', () => {
    // A config typo must fall through to the environment identity, not take
    // the write path down.
    for (const bad of ['', '   ', 'no-brackets', 'Che Coelho <not-an-email>', '<che@example.com>']) {
      expect(parseGitIdentity(bad)).toBeUndefined();
    }
    expect(parseGitIdentity(null)).toBeUndefined();
    expect(parseGitIdentity(undefined)).toBeUndefined();
  });

  test('strips newlines so a config value cannot forge commit-object headers', () => {
    const parsed = parseGitIdentity('Che\nCoelho <che@example.com>');
    expect(parsed?.name).toBe('Che Coelho');
    expect(parsed?.name).not.toContain('\n');
  });
});

describe('gitIdentityEnv', () => {
  test('pins committer as well as author', () => {
    expect(gitIdentityEnv({ name: 'Che Coelho', email: 'che@example.com' })).toEqual({
      GIT_AUTHOR_NAME: 'Che Coelho',
      GIT_AUTHOR_EMAIL: 'che@example.com',
      GIT_COMMITTER_NAME: 'Che Coelho',
      GIT_COMMITTER_EMAIL: 'che@example.com',
    });
  });

  test('empty overlay when unmapped, so the environment identity survives', () => {
    expect(gitIdentityEnv(undefined)).toEqual({});
  });
});

describe('resolveGitIdentity', () => {
  test('per-client mapping wins over the default', async () => {
    const engine = fakeEngine({
      'writer.git_identity.hab_cl_abc': 'Che Coelho <che@example.com>',
      [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>',
    });
    expect(await resolveGitIdentity(engine, { clientId: 'hab_cl_abc' })).toEqual({
      name: 'Che Coelho',
      email: 'che@example.com',
    });
  });

  test('falls back to the default for an unmapped client', async () => {
    const engine = fakeEngine({ [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>' });
    expect(await resolveGitIdentity(engine, { clientId: 'hab_cl_unknown' })).toEqual({
      name: 'Fallback Bot',
      email: 'bot@example.com',
    });
  });

  test('undefined when nothing is configured — environment identity stands', async () => {
    expect(await resolveGitIdentity(fakeEngine({}), { clientId: 'hab_cl_abc' })).toBeUndefined();
    expect(await resolveGitIdentity(fakeEngine({}))).toBeUndefined();
  });

  test('the credential\'s principal outranks any config mapping', async () => {
    const engine = fakeEngine(
      {
        'writer.git_identity.tok_ross': 'Wrong Person <wrong@example.com>',
        [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>',
      },
      { 1: { subject: 'rosseyre@gmail.com', display_name: 'Ross Eyre' } },
    );
    expect(await resolveGitIdentity(engine, { clientId: 'tok_ross', principalId: 1 })).toEqual({
      name: 'Ross Eyre',
      email: 'rosseyre@gmail.com',
    });
  });

  test('falls back to the subject when a principal has no display name', async () => {
    const engine = fakeEngine({}, { 2: { subject: 'che@example.com', display_name: null } });
    expect(await resolveGitIdentity(engine, { principalId: 2 })).toEqual({
      name: 'che@example.com',
      email: 'che@example.com',
    });
  });

  test('a non-email principal subject is not turned into an address', async () => {
    // Service principals exist; their subject is an identifier, not a mailbox.
    const engine = fakeEngine({ [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>' },
      { 3: { subject: 'service:ingest-worker', display_name: 'Ingest Worker' } });
    expect(await resolveGitIdentity(engine, { principalId: 3 })).toEqual({
      name: 'Fallback Bot',
      email: 'bot@example.com',
    });
  });

  test('an unknown principal id falls through to config', async () => {
    const engine = fakeEngine({ [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>' });
    expect(await resolveGitIdentity(engine, { principalId: 99 })).toEqual({
      name: 'Fallback Bot',
      email: 'bot@example.com',
    });
  });

  test('a brain without the principals table still resolves from config', async () => {
    const engine = engineWithoutPrincipals({ [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>' });
    expect(await resolveGitIdentity(engine, { principalId: 1 })).toEqual({
      name: 'Fallback Bot',
      email: 'bot@example.com',
    });
  });

  test('a hostile client id cannot escape its config namespace', async () => {
    const engine = fakeEngine({ [GIT_IDENTITY_DEFAULT_KEY]: 'Fallback Bot <bot@example.com>' });
    // Never consulted as a key; falls through to the default.
    expect(await resolveGitIdentity(engine, { clientId: 'a b/../../etc' })).toEqual({
      name: 'Fallback Bot',
      email: 'bot@example.com',
    });
  });
});
